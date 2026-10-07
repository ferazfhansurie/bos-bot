import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, room, digest } from './slice34-service-adapter.mjs';

export async function createRecovery(c) {
  c.f.hooks.pausedWorker = true;
  const h = await c.humans('recovery-corpus', { role: 'member' });
  const windows = await Promise.all([h.a, h.b].map(a => c.ok(root(h) + '/operation-windows', a, 'POST', {})));
  const snapshots = await Promise.all([h.a, h.b].map(a => c.snapshot(h, a)));
  const wire = new Map(), idMap = new Map(), receipts = new Map(), faults = new Set();
  const aliases = new Map([[h.a.account_id, 'fictional-alice'], [h.b.account_id, 'fictional-bob']]);
  const diskPath = resolve(c.evidence, 'recovery-storage.private.json');
  const storage = {
    getItem(key) { return existsSync(diskPath) ? JSON.parse(readFileSync(diskPath, 'utf8'))[key] ?? null : null; },
    setItem(key, value) {
      const current = existsSync(diskPath) ? JSON.parse(readFileSync(diskPath, 'utf8')) : {};
      current[key] = value; writeFileSync(diskPath, JSON.stringify(current), { mode: 0o600, flush: true });
    },
  };
  const stores = windows.map(w => c.client.localOutboxStore(storage, w.namespace));
  let projections = snapshots.map((s, i) => c.client.cloudRoomReducer(c.client.initialCloudRoomState({
    namespace: windows[i].namespace.subject, account_id: windows[i].namespace.account_id,
    workspace_id: h.w, room_id: h.r.room_id, thread_id: h.r.thread_id }), { type: 'snapshot', snapshot: s }));
  let slowPrepared = false;
  const recipientFrame = async (i, { crash = false, duplicate = false } = {}) => {
    const actor = i ? h.b : h.a;
    let frame = await c.ok(room(h) + '/replay', actor, 'POST', { thread_id: h.r.thread_id, cursor: projections[i].cursor });
    const checkpoint = c.artifact('recipient-before-apply', projections[i]);
    const apply = c.client.cloudRoomReducer(projections[i], { type: 'frame', frame });
    if (crash) {
      c.log({ type: 'crash_after_actual_reducer_apply_before_checkpoint', recipient: i, applied_cursor: apply.cursor, checkpoint });
      projections[i] = JSON.parse(readFileSync(checkpoint.path, 'utf8'));
      frame = await c.ok(room(h) + '/replay', actor, 'POST', { thread_id: h.r.thread_id, cursor: projections[i].cursor });
    }
    projections[i] = c.client.cloudRoomReducer(projections[i], { type: 'frame', frame });
    if (duplicate) {
      const once = projections[i]; projections[i] = c.client.cloudRoomReducer(projections[i], { type: 'frame', frame });
      assert.deepEqual(projections[i].messages, once.messages);
    }
    return frame;
  };
  const slowFault = async () => {
    if (!slowPrepared) {
      // Committed fictional filler is explicitly outside the independent intent
      // corpus. It saturates an actual TCP write queue without inventing events.
      const template = await c.envelope(h, h.a, { text: 'fictional-backpressure:' + 'x'.repeat(65000), window: windows[0] });
      for (let i = 0; i < 24; i++) await c.send(h, h.a, { ...template, client_operation_id: windows[0].window_id + '.fictional_filler_' + String(i).padStart(16, '0') });
      slowPrepared = true;
    }
    const socket = await c.socket(h.b);
    const peer = [...c.f.app.wsServer.clients].find(ws => ws._socket?.remotePort === socket.ws._socket.localPort);
    assert.ok(peer, 'owned websocket peer');
    // Real socket backpressure fault: hold its TCP writes. The service's own
    // replay/pump and bufferedAmount limit must close it; no synthetic frame.
    peer._socket.cork();
    try {
      socket.ws.send(JSON.stringify({ type: 'subscribe', workspace_id: h.w, room_id: h.r.room_id,
        thread_id: h.r.thread_id, cursor: snapshots[1].cursor }));
      await c.until(() => peer.readyState === c.WebSocket.CLOSING || peer.readyState === c.WebSocket.CLOSED, 'actual slow-consumer overflow', 6000);
    } finally { peer._socket?.uncork(); }
    await c.until(() => socket.code !== null, 'actual overflow close', 6000); assert.equal(socket.code, 1013);
    return c.artifact('actual-tcp-overflow', { code: socket.code, frames: socket.frames.map(f => ({ type: f.type, events: f.events?.length, reason: f.reason })), source: 'service ws bufferedAmount gate' });
  };
  const recoverOutbox = async (index, intent, e) => {
    let entries = stores[index].load();
    entries = c.client.outboxReducer(entries, { type: 'send_failed', id: e.client_operation_id, now: Date.now(), failure: { transport: true } });
    stores[index].save(entries);
    entries = c.client.outboxReducer(stores[index].load(), { type: 'restored', now: Date.now() });
    const receipt = await c.lookup(h, index ? h.b : h.a, e);
    if (receipt.status === 'not_found') {
      entries = c.client.outboxReducer(entries, { type: 'operation_result', result: receipt, now: Date.now() }); stores[index].save(entries);
      const work = c.client.nextWork(entries, windows[index].namespace, Date.now());
      assert.ok(work.some(w => w.kind === 'send' && w.entry.envelope.client_operation_id === e.client_operation_id));
      await c.send(h, index ? h.b : h.a, e);
    }
    const terminal = await c.lookup(h, index ? h.b : h.a, e); assert.equal(terminal.status, 'accepted');
    entries = c.client.outboxReducer(entries, { type: 'operation_result', result: terminal, now: Date.now() }); stores[index].save(entries);
    receipts.set(intent.id, terminal); return terminal;
  };
  return {
    prepare: async intent => {
      const index = intent.envelope.actor_alias === 'fictional-bob' ? 1 : 0;
      const win = windows[index];
      const frozen = await c.client.freezeSend({ namespace: win.namespace, window_id: win.window_id, window_token: win.window_token,
        room_id: h.r.room_id, thread_id: h.r.thread_id, expected_policy_revision: snapshots[index].policy_revision,
        text: intent.envelope.text, mentions: [], now: Date.now(), nonce: intent.id.replaceAll('-', '_') });
      assert.ok(!frozen.problem); assert.equal(frozen.digest, digest(frozen.envelope));
      stores[index].save(c.client.outboxReducer(stores[index].load(), { type: 'queued', entry: frozen }));
      wire.set(intent.id, frozen.envelope); idMap.set(frozen.envelope.client_operation_id, intent.id); return frozen.envelope;
    },
    submit: async (intent, e) => {
      assert.deepEqual(e, wire.get(intent.id), 'never replace the frozen envelope');
      const index = intent.envelope.actor_alias === 'fictional-bob' ? 1 : 0, actor = index ? h.b : h.a;
      stores[index].save(c.client.outboxReducer(stores[index].load(), { type: 'dispatching', id: e.client_operation_id }));
      let faultArtifact;
      if (['response-lost-before-commit', 'response-lost-after-commit'].includes(intent.fault)) {
        const point = intent.fault === 'response-lost-before-commit' ? 'message.send' : 'http.publication';
        const gate = c.gate(point + '.before_admission', { workspace_id: h.w, account_id: actor.account_id });
        const abort = new AbortController();
        const request = fetch(c.f.url + root(h) + '/messages', { method: 'POST', signal: abort.signal,
          headers: { authorization: 'Bearer ' + actor.bearer, 'content-type': 'application/json' }, body: JSON.stringify(e) }).catch(error => ({ aborted: error.name }));
        try {
          await gate.waitUntilReached(); abort.abort();
          const atLoss = await c.sql('SELECT * FROM cloud.operations WHERE workspace_id=$1 AND client_operation_id=$2', [h.w, e.client_operation_id]);
          assert.equal(atLoss.length, point === 'message.send' ? 0 : 1);
          faultArtifact = c.artifact('actual-response-loss', { fault: intent.fault, barrier: gate.artifact(), atLoss });
          await gate.release(); await request;
          await c.until(async () => (await c.lookup(h, actor, e)).status === 'accepted', 'lost-response actual commit');
        } finally { await gate.cleanup(); await request; }
      } else {
        if (intent.fault === 'dropped-wakeup') { c.f.hooks.dropNotify = true; c.f.hooks.pausedWorker = true; }
        try { await c.send(h, actor, e); if (intent.fault === 'duplicate-delivery') await c.send(h, actor, e); }
        finally { c.f.hooks.dropNotify = false; c.f.hooks.pausedWorker = true; }
      }
      await recoverOutbox(index, intent, e);
      if (intent.fault === 'expired-cursor-reset') {
        const s = await c.snapshot(h, actor);
        await c.sql("UPDATE cloud.snapshots SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND snapshot_id=$2", [h.w, s.snapshot_id]);
        const reset = await c.replay(h, actor, s); assert.equal(reset.type, 'reset_required'); assert.equal(reset.reason, 'snapshot_expired');
        projections[index] = c.client.cloudRoomReducer(projections[index], { type: 'frame', frame: reset });
        faultArtifact = c.artifact('actual-expired-snapshot-reset', reset);
      }
      if (intent.fault === 'filtered-empty-batch') {
        const s = await c.snapshot(h, h.b), bytes = Buffer.from('fictional private attachment');
        const a = await c.attachment(h, h.a, bytes);
        const empty = await c.replay(h, h.b, s); assert.equal(empty.events.length, 0); assert.ok(BigInt(empty.scanned_sequence) > BigInt(s.watermark));
        faultArtifact = c.artifact('actual-filtered-empty', { empty, attachment_id: a.value.attachment_id });
      }
      if (intent.fault === 'slow-consumer-overflow') faultArtifact = await slowFault();
      for (let i = 0; i < 2; i++) {
        const frame = await recipientFrame(i, { crash: intent.fault === 'crash-after-apply-before-checkpoint', duplicate: intent.fault === 'reordered-stream' });
        if (intent.fault === 'reordered-stream') {
          // Deliver an actual older frame after the current frame to the actual
          // reducer, then restore the latest replay cursor from the service.
          const old = await c.ok(room(h) + '/replay', i ? h.b : h.a, 'POST', { thread_id: h.r.thread_id, cursor: snapshots[i].cursor });
          const before = projections[i].messages;
          projections[i] = c.client.cloudRoomReducer(projections[i], { type: 'frame', frame: old });
          projections[i] = c.client.cloudRoomReducer(projections[i], { type: 'frame', frame });
          assert.deepEqual(projections[i].messages, before);
          faultArtifact = c.artifact('actual-reordered-frames', { newest: frame, older: old, client_artifact: c.clientArtifact });
        }
      }
      if (!faultArtifact) faultArtifact = c.artifact('exercised-' + intent.fault, { operation_id: e.client_operation_id, receipt: receipts.get(intent.id), client_artifact: c.clientArtifact });
      faults.add(intent.fault); c.log({ type: 'recovery_fault_exercised', id: intent.id, fault: intent.fault, artifact: faultArtifact });
    },
    reconcile: async intents => {
      const durable = await c.sql('SELECT client_operation_id,digest,result FROM cloud.operations WHERE workspace_id=$1', [h.w]);
      const map = new Map(durable.map(row => [row.client_operation_id, row]));
      const canonicalReceipts = intents.map(intent => {
        const e = wire.get(intent.id), row = map.get(e.client_operation_id); assert.ok(row); assert.equal(row.digest, digest(e));
        assert.equal(row.result.status, 'accepted'); assert.equal(row.result.message_id, receipts.get(intent.id).message_id);
        return { id: intent.id, state: row.result.status, envelope_digest: digest(intent.envelope), wire_digest: row.digest,
          canonical_message_id: row.result.message_id, commit_artifact: c.artifact('durable-commit-' + intent.id, row) };
      });
      const result = [];
      for (let i = 0; i < 2; i++) {
        // Real bounded history supplements snapshots (which deliberately retain
        // only 50 messages). Two authenticated recipients independently read it.
        const history = await c.history(h, i ? h.b : h.a);
        projections[i] = c.client.cloudRoomReducer(projections[i], { type: 'history', messages: history });
        let frame;
        do { frame = await recipientFrame(i); } while (frame.type === 'event_batch' && !frame.live);
        const messages = projections[i].messages.filter(m => idMap.has(m.client_operation_id)).map(m => ({
          operation_id: idMap.get(m.client_operation_id), text: m.text, actor_alias: aliases.get(m.actor_id), message_id: m.message_id }));
        result.push({ messages, cursor_artifact: c.artifact('actual-recipient-cursor-' + i, { cursor: projections[i].cursor, head: projections[i].head }),
          durable_readback_artifact: c.artifact('actual-recipient-history-' + i, { history, projection: projections[i], client_artifact: c.clientArtifact }) });
      }
      const stored = stores.flatMap(s => s.load());
      const unresolved = stored.filter(e => c.client.isUnresolved(e));
      const absent = intents.filter(i => !stored.some(e => e.envelope.client_operation_id === wire.get(i.id).client_operation_id));
      assert.equal(unresolved.length, 0); assert.equal(absent.length, 0);
      return { receipts: canonicalReceipts, projections: result, faults_exercised: [...faults], unresolved_outbox_lost: absent.length };
    },
  };
}
