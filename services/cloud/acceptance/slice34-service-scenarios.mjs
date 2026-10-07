import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { root, room, binding, digest } from './slice34-service-adapter.mjs';

export function serviceScenarios(c) {
  const counted = rows => rows.length;
  const forbidden = async request => { const r = await request; assert.ok([401, 403, 409].includes(r.status), JSON.stringify(r.data)); return r; };
  const state = (h, actor = h.b, outbox = []) => c.client.initialCloudRoomState({ namespace: actor.subject,
    account_id: actor.account_id, workspace_id: h.w, room_id: h.r.room_id, thread_id: h.r.thread_id, outbox });
  const entry = e => ({ envelope: e, digest: digest(e), state: 'draft', created_at: Date.now(), dispatched: false, attempts: 0 });
  const coverage = h => c.ok(room(h) + '/read', h.b, 'POST', { thread_id: h.r.thread_id, intervals: [] });
  const apply = (s, frame) => c.client.cloudRoomReducer(s, { type: 'frame', frame });
  const expiry = (h, table, idKey, id) => c.sql(`UPDATE cloud.${table} SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND ${idKey}=$2`, [h.w, id]);
  const readRows = h => c.sql('SELECT * FROM cloud.operations WHERE workspace_id=$1', [h.w]);

  return {
    'host-crash-mid-stream': async () => {
      const h = await c.humans('uncertain-host', { runtime: true }); const { run } = await c.invoke(h);
      await c.append(h, run, { kind: 'checkpoint', replay_safe: false });
      await c.append(h, run, { kind: 'stream.delta', delta_id: 'fictional-partial', text: 'fictional provisional' });
      await c.sql("UPDATE cloud.invocations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1", [h.w]);
      const offers = await h.driver.json('hostInvocations', { workspace_id: h.w, host_id: h.host.host_id });
      const after = await c.snapshot(h);
      const claim = await c.request(root(h) + '/hosts/' + h.host.host_id + '/claim', h.a, 'POST', { invocation_id: run.invocation_id }, h.host.host_credential);
      assert.equal(claim.status, 409); assert.equal(after.active_runs[0].state, 'held');
      const finals = (await c.history(h)).filter(m => m.bot_id);
      const attempts = await c.sql('SELECT * FROM cloud.run_attempts WHERE workspace_id=$1', [h.w]);
      return { duplicate_finals: Math.max(0, finals.length - 1), uncertain_provider_auto_replay: Math.max(0, attempts.length - 1) + offers.invocations.length };
    },
    'response-loss-before-after-commit': async () => {
      const h = await c.humans('response-loss', { runtime: true }); let duplicateMessages = 0, duplicateInvocations = 0, unknownReplaced = 0;
      for (const when of ['before', 'after']) {
        const e = await c.envelope(h, h.b, { bot: true }); const gate = c.gate((when === 'before' ? 'message.send' : 'http.publication') + '.before_admission', { workspace_id: h.w, account_id: h.b.account_id });
        const abort = new AbortController();
        const pending = fetch(c.f.url + root(h) + '/messages', { method: 'POST', signal: abort.signal,
          headers: { authorization: 'Bearer ' + h.b.bearer, 'content-type': 'application/json' }, body: JSON.stringify(e) }).catch(e => ({ aborted: e.name }));
        try {
          await gate.waitUntilReached(); abort.abort();
          const durableAtLoss = await c.sql('SELECT * FROM cloud.operations WHERE workspace_id=$1 AND client_operation_id=$2', [h.w, e.client_operation_id]);
          assert.equal(durableAtLoss.length, when === 'before' ? 0 : 1);
          c.log({ type: 'actual_response_loss', when, operation_id: e.client_operation_id, barrier_artifact: gate.artifact(), durable_at_loss: durableAtLoss });
          await gate.release(); await pending;
          await c.until(async () => (await c.lookup(h, h.b, e)).status === 'accepted', 'lost-response reconciliation');
          const receipt = await c.send(h, h.b, e);
          const messages = (await c.history(h)).filter(m => m.client_operation_id === e.client_operation_id);
          const invocations = await c.sql('SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND source_message_id=$2', [h.w, receipt.message_id]);
          duplicateMessages += Math.max(0, messages.length - 1); duplicateInvocations += Math.max(0, invocations.length - 1);
          unknownReplaced += receipt.digest === digest(e) ? 0 : 1;
        } finally { await gate.cleanup(); await pending; }
      }
      return { duplicate_messages: duplicateMessages, duplicate_invocations: duplicateInvocations, unknown_replaced: unknownReplaced };
    },
    'terminal-seal-delayed-submit': async () => {
      const h = await c.humans('terminal'); let changes = 0, duplicates = 0;
      for (const first of ['seal', 'submit']) {
        const e = await c.envelope(h); const start = await (first === 'seal' ? c.seal(h, h.b, e) : c.send(h, h.b, e));
        const later = await c.send(h, h.b, e), sealed = await c.seal(h, h.b, e);
        changes += [later, sealed].filter(v => v.status !== start.status || v.digest !== start.digest).length;
        duplicates += Math.max(0, (await c.history(h)).filter(m => m.client_operation_id === e.client_operation_id).length - (start.status === 'accepted' ? 1 : 0));
      }
      return { terminal_state_changes: changes, duplicate_messages: duplicates };
    },
    'changed-envelope-window-swap': async () => {
      const h = await c.humans('conflicts'); const e = await c.envelope(h); await c.send(h, h.b, e);
      const changed = await c.request(root(h) + '/messages', h.b, 'POST', { ...e, text: e.text + 'changed' });
      assert.equal(changed.status, 409); assert.equal(changed.data.error, 'operation_conflict');
      const fresh = await c.envelope(h), other = await c.ok(root(h) + '/operation-windows', h.b, 'POST', {});
      const swap = await c.request(root(h) + '/messages', h.b, 'POST', { ...fresh, window_token: other.window_token });
      assert.equal(swap.status, 409);
      await readRows(h);
      return { changed_envelope_admitted: +(changed.status === 200), window_swap_admitted: +(swap.status === 200) };
    },
    'expired-key-missing-key-restore-unknown': async () => {
      const h = await c.humans('unknown'); const e = await c.envelope(h);
      await expiry(h, 'windows', 'window_id', e.client_operation_id.split('.')[0]);
      const expired = await c.send(h, h.b, e); assert.equal(expired.reason, 'operation_expired');
      const missing = await c.envelope(h);
      await c.sql('DELETE FROM cloud.windows WHERE workspace_id=$1 AND window_id=$2', [h.w, missing.client_operation_id.split('.')[0]]);
      const unknown = await c.seal(h, h.b, missing); assert.equal(unknown.status, 'recovery_unknown');
      const epoch = await c.envelope(h);
      await c.sql("UPDATE cloud.workspaces SET epoch='fictional-restored-epoch' WHERE workspace_id=$1", [h.w]);
      const restored = await c.seal(h, h.b, epoch); assert.equal(restored.status, 'recovery_unknown');
      const rows = await readRows(h);
      return { expired_never_seen_admitted: +(expired.status === 'accepted'), restore_unknown_sealed: rows.filter(r => [missing.client_operation_id, epoch.client_operation_id].includes(r.client_operation_id)).length };
    },
    'expiry-policy-invalid-mention-at-lock': async () => {
      const h = await c.humans('at-lock'); let expiredAdmitted = 0, invalidCommitted = 0;
      const e = await c.envelope(h), gate = c.gate('message.send.before_admission', { workspace_id: h.w, client_operation_id: e.client_operation_id });
      const pending = c.send(h, h.b, e); pending.catch(() => {});
      try { await gate.waitUntilReached(); await expiry(h, 'windows', 'window_id', e.client_operation_id.split('.')[0]); await gate.release(); const r = await pending; assert.equal(r.reason, 'operation_expired'); expiredAdmitted += +(r.status === 'accepted'); }
      finally { await gate.cleanup(); await pending.catch(() => {}); }
      const stale = await c.envelope(h);
      await c.ok(root(h) + '/rooms', h.a, 'POST', { name: 'fictional policy change' });
      // Explicit fixture policy mutation is an actual committed lock authority change.
      await c.sql('UPDATE cloud.rooms SET policy_revision=policy_revision+1 WHERE workspace_id=$1 AND room_id=$2', [h.w, h.r.room_id]);
      assert.equal((await c.send(h, h.b, stale)).reason, 'policy_changed');
      const mention = await c.envelope(h); mention.text = '@absent'; mention.mentions = [{ kind: 'bot', id: 'fictional-ungranted', start: 0, end: 7 }];
      const r = await c.send(h, h.b, mention); assert.equal(r.reason, 'invalid_mention');
      invalidCommitted += (await c.history(h)).filter(m => m.client_operation_id === mention.client_operation_id).length;
      return { expired_at_lock_admitted: expiredAdmitted, invalid_mentions_committed: invalidCommitted };
    },
    'draft-23h-25h-review': async () => {
      const h = await c.humans('draft-review'); const e = await c.envelope(h); const now = Date.now();
      const old = { ...entry(e), created_at: now - 25 * 3600000 }, young = { ...entry(e), created_at: now - 23 * 3600000 };
      const aged = c.client.outboxReducer([old], { type: 'tick', now })[0];
      const fresh = c.client.outboxReducer([young], { type: 'tick', now })[0]; assert.equal(fresh.review_required, undefined);
      const unknown = c.client.outboxReducer([{ ...old, state: 'sending', dispatched: true }], { type: 'restored', now })[0];
      c.log({ type: 'actual_web_outbox', aged, fresh, unknown, client_artifact: c.clientArtifact });
      return { reviewed_25h: aged.review_required === true && c.client.nextWork([aged], e.namespace, now).length === 0,
        unchanged_unknown_replay: digest(unknown.envelope) === digest(e) && unknown.state === 'checking' };
    },
    'duplicate-lost-queue-dispatch-outage': async () => {
      const h = await c.humans('dispatch-outage', { runtime: true }); c.f.hooks.pausedWorker = true; c.f.hooks.dropNotify = true;
      try {
        const e = await c.envelope(h, h.b, { bot: true }); const sent = await c.send(h, h.b, e); await c.send(h, h.b, e);
        const inv = await c.sql('SELECT * FROM cloud.invocations WHERE workspace_id=$1', [h.w]); assert.equal(inv.length, 1);
        const queue = await c.sql('SELECT * FROM cloud.work_queue WHERE workspace_id=$1', [h.w]);
        await c.sql('UPDATE cloud.work_queue SET completed_at=NULL WHERE workspace_id=$1', [h.w]);
        c.f.hooks.pausedWorker = false; await c.f.service.tickWorker();
        const offers = await h.driver.json('hostInvocations', { workspace_id: h.w, host_id: h.host.host_id });
        const run = await h.driver.json('hostClaim', { workspace_id: h.w, host_id: h.host.host_id }, { invocation_id: offers.invocations[0].invocation_id });
        await c.append(h, run, { kind: 'final.commit', text: 'fictional final' }); await c.append(h, run, { kind: 'final.commit', text: 'fictional final' });
        await c.sql('UPDATE cloud.work_queue SET completed_at=NULL WHERE workspace_id=$1', [h.w]); await c.f.service.tickWorker();
        const history = await c.history(h); c.log({ type: 'queue_fault', queue, sent, history });
        return { lost_accepted_messages: +(history.filter(m => m.message_id === sent.message_id).length !== 1), duplicate_finals: Math.max(0, history.filter(m => m.bot_id).length - 1) };
      } finally { c.f.hooks.pausedWorker = false; c.f.hooks.dropNotify = false; }
    },
    'crash-apply-checkpoint-filtered-empty': async () => {
      const h = await c.humans('atomic-filter', { runtime: true }); const s = await c.snapshot(h, h.b);
      const a = await c.allocate(h, h.a, Buffer.from('fictional filtered'));
      const filtered = await c.replay(h, h.b, s);
      assert.equal(filtered.events.length, 0); // allocation does not publish; force a real actor-private complete event
      await c.raw(a.upload_url, h.a, { method: 'PUT', body: Buffer.from('fictional filtered') });
      await c.ok(root(h) + '/attachments/' + a.attachment.attachment_id + '/complete', h.a, 'POST', {});
      const empty = await c.replay(h, h.b, s);
      assert.equal(empty.type, 'event_batch'); assert.equal(empty.events.length, 0); assert.ok(BigInt(empty.scanned_sequence) > BigInt(s.watermark));
      const initial = c.client.cloudRoomReducer(state(h), { type: 'snapshot', snapshot: s });
      const applied = apply(initial, empty); const crashed = structuredClone(initial); const reapplied = apply(crashed, empty);
      c.log({ type: 'real_filtered_batch_atomic_reducer', initial, applied, reapplied, client_artifact: c.clientArtifact });
      return { cursor_projection_atomic: digest(applied) === digest(reapplied), filtered_empty_advances: applied.cursor === empty.cursor && applied.head === empty.scanned_sequence };
    },
    'reset-continuous-write-page-expiry': async () => {
      const h = await c.humans('reset-live'); const s = await c.snapshot(h); const frozen = c.client.cloudRoomReducer(state(h), { type: 'snapshot', snapshot: s });
      const e = await c.envelope(h, h.a); await c.send(h, h.a, e);
      const frame = await c.replay(h, h.b, s); assert.equal(frame.type, 'event_batch');
      const live = apply(frozen, frame); const canonical = await c.history(h);
      await expiry(h, 'snapshots', 'snapshot_id', s.snapshot_id);
      const expired = await c.request(room(h) + '/snapshots/' + s.snapshot_id, h.b); assert.equal(expired.data.error, 'snapshot_expired');
      const reset = await c.replay(h, h.b, s); assert.equal(reset.type, 'reset_required'); assert.equal(reset.reason, 'snapshot_expired');
      c.log({ type: 'continuous_reset', canonical, live, reset, client_artifact: c.clientArtifact });
      return { snapshot_live_gap: canonical.filter(m => !live.messages.some(n => n.message_id === m.message_id)).length, expired_snapshot_reused: +(expired.status === 200) };
    },
    'discovery-grant-removal-during-reset': async () => {
      const h = await c.humans('discovery-reset'); const s = await c.snapshot(h);
      const gate = c.gate('snapshot.page.before_admission', { workspace_id: h.w, account_id: h.b.account_id });
      const pending = c.request(room(h) + '/snapshots/' + s.snapshot_id, h.b); pending.catch(() => {});
      let response;
      try { await gate.waitUntilReached(); await c.ok(root(h) + '/members/' + h.b.account_id, h.a, 'DELETE'); await gate.release(); response = await pending; }
      finally { await gate.cleanup(); await pending.catch(() => {}); }
      assert.equal(response.status, 403);
      const discovery = await c.ok('/v2/discovery/sync', h.b);
      const s0 = c.client.cloudRoomReducer(state(h), { type: 'snapshot', snapshot: s }); const removed = apply(s0, { type: 'error', error: response.data.error });
      c.log({ type: 'actual_removal', removed, discovery });
      return { removals_before_reopen: removed.removed && removed.messages.length === 0,
        inaccessible_metadata_count: discovery.workspaces.filter(w => w.workspace_id === h.w).length };
    },
    'slow-consumer-overflow-corrupt-cache': async () => {
      const h = await c.humans('slow-corrupt'); const s = await c.snapshot(h);
      const pending = { ...entry(await c.envelope(h)), state: 'checking', dispatched: true };
      const initial = c.client.cloudRoomReducer(state(h, h.b, [pending]), { type: 'snapshot', snapshot: s });
      const win = await c.ok(root(h) + '/operation-windows', h.a, 'POST', {});
      const template = await c.envelope(h, h.a, { text: 'fictional tcp backpressure ' + 'x'.repeat(65000), window: win });
      for (let i = 0; i < 24; i++) await c.send(h, h.a, { ...template, client_operation_id: win.window_id + '.fictional_pressure_' + String(i).padStart(16, '0') });
      const frame = await c.replay(h, h.b, s); assert.ok(frame.events.length);
      const corrupted = structuredClone(frame); corrupted.events[0].workspace_id = 'fictional-corrupt-cache';
      const refused = apply(initial, corrupted); assert.equal(refused.reset_required, true);
      const socket = await c.socket(h.b);
      const peer = [...c.f.app.wsServer.clients].find(ws => ws._socket?.remotePort === socket.ws._socket.localPort); assert.ok(peer);
      let peak = 0;
      peer._socket.cork(); const meter = setInterval(() => peak = Math.max(peak, peer.bufferedAmount), 5);
      try {
        socket.ws.send(JSON.stringify({ type: 'subscribe', workspace_id: h.w, room_id: h.r.room_id, thread_id: h.r.thread_id, cursor: s.cursor }));
        await c.until(() => peer.readyState >= c.WebSocket.CLOSING, 'actual outbound overflow');
      } finally { clearInterval(meter); peer._socket?.uncork(); }
      await c.until(() => socket.code !== null, 'actual overflow close'); assert.equal(socket.code, 1013);
      const reset = await c.snapshot(h); const recovered = c.client.cloudRoomReducer(refused, { type: 'snapshot', snapshot: reset });
      c.log({ type: 'actual_slow_consumer_corrupt_cache', peak_buffered_bytes: peak, close_code: socket.code,
        corrupted, refused_cursor: refused.cursor, restored_outbox: recovered.outbox, client_artifact: c.clientArtifact });
      return { bounded_buffer: peak <= 1048576 + 128 && socket.code === 1013,
        unresolved_outbox_lost: initial.outbox.filter(e => !recovered.outbox.some(n => n.envelope.client_operation_id === e.envelope.client_operation_id)).length,
        corrupt_cursor_advanced: +(refused.cursor !== initial.cursor) };
    },
    'sparse-read-bound-concurrent-devices': async () => {
      const h = await c.humans('read-bound'); const win = await c.ok(root(h) + '/operation-windows', h.a, 'POST', {});
      for (let i = 0; i < 514; i++) await c.send(h, h.a, await c.envelope(h, h.a, { text: 'fictional read ' + i, window: win }));
      const s = await c.snapshot(h), messages = await c.history(h);
      const seqs = messages.slice(1).filter((_, i) => i % 2 === 0).slice(0, 257).map(m => m.sequence);
      const first = seqs.slice(0, 256).map(s => [s, s]);
      const atBound = await c.ok(room(h) + '/read', h.b, 'POST', { thread_id: h.r.thread_id, intervals: first });
      const over = await c.request(room(h) + '/read', h.b, 'POST', { thread_id: h.r.thread_id, intervals: [[seqs[256], seqs[256]]] });
      assert.equal(over.data.error, 'read_coverage_limit');
      const both = await Promise.all([[], []].map(intervals => c.ok(room(h) + '/read', h.b, 'POST', { thread_id: h.r.thread_id, intervals })));
      const final = await coverage(h); assert.deepEqual(both[0], both[1]); assert.deepEqual(final, atBound);
      c.log({ type: 'read_bound', final, over, snapshot: s });
      return { sparse_interval_max: final.intervals.length, unseen_gap_marked_read: +(c.client.isRead(final, messages[0].sequence)) };
    },
    'provisional-seen-final-unseen': async () => {
      const h = await c.humans('read-provisional', { runtime: true }); const { run } = await c.invoke(h); const s = await c.snapshot(h);
      await c.append(h, run, { kind: 'stream.delta', delta_id: 'fictional-part', text: 'fictional provisional' });
      const provisional = await c.replay(h, h.b, s); assert.equal(provisional.events.some(e => e.kind === 'stream.delta'), true);
      const before = await coverage(h); await c.append(h, run, { kind: 'final.commit', text: 'fictional unseen final' });
      const hist = await c.history(h); const final = hist.find(m => m.bot_id); const after = await coverage(h);
      return { provisional_only_marks_final_read: c.client.isRead(after, final.sequence) || digest(before) !== digest(after) };
    },
    'revoke-stream-replay-upload-job-range': async () => {
      const h = await c.humans('revoke-all', { runtime: true }); const { run } = await c.invoke(h);
      const a = await c.attachment(h, h.a); assert.equal(a.value.state, 'ready');
      await c.send(h, h.a, await c.envelope(h, h.a, { attachments: [a.value.attachment_id] }));
      const upload = await c.allocate(h, h.b, Buffer.from('fictional unfinished')); const s = await c.snapshot(h);
      const socket = await c.socket(h.b); socket.subscribe(h, s);
      await c.ok(root(h) + '/members/' + h.b.account_id, h.a, 'DELETE');
      const denials = await Promise.all([
        c.request(room(h) + '/replay', h.b, 'POST', { thread_id: h.r.thread_id, cursor: s.cursor, snapshot_id: s.snapshot_id }),
        c.raw(upload.upload_url, h.b, { method: 'PUT', body: Buffer.from('fictional unfinished') }),
        c.raw(root(h) + '/attachments/' + a.value.attachment_id + '/download', h.b, { range: 'bytes=0-3' }),
        c.appendRequest(h, run, { kind: 'final.commit', text: 'fictional denied final' }),
      ]);
      for (const r of denials) assert.equal(r.status, 403);
      await c.until(() => socket.code !== null, 'removed socket close');
      const rows = await c.sql('SELECT state FROM cloud.invocations WHERE workspace_id=$1', [h.w]); assert.equal(rows[0].state, 'held');
      return { post_revocation_protected_admissions: denials.filter(r => r.status === 200 || r.status === 206).length };
    },
    'host-session-revoked-issuer-outage': async () => {
      const h = await c.humans('host-revoke', { runtime: true, actors: [c.actors[3], c.actors[1]] }); const { run } = await c.invoke(h);
      const signedOut = await c.issuerRequest('/api/auth/sign-out', { method: 'POST', headers: { authorization: 'Bearer ' + h.a.bearer, 'content-type': 'application/json', origin: 'http://127.0.0.1:5199' }, body: '{}' });
      assert.equal(signedOut.status, 200);
      const revoked = await c.appendRequest(h, run, { kind: 'final.commit', text: 'fictional revoked' }); assert.equal(revoked.status, 401);
      c.f.issuer_fault.outage = true;
      let outage;
      try { outage = await c.request(root(h) + '/operation-windows', h.b, 'POST', {}); assert.equal(outage.status, 503); assert.equal(outage.data.error, 'identity_unavailable'); }
      finally { c.f.issuer_fault.outage = false; }
      return { unverifiable_privileged_admissions: [revoked, outage].filter(r => r.status === 200).length };
    },
    'cross-tenant-all-indirect-routes': async () => {
      const h = await c.humans('foreign-target', { runtime: true }); const foreign = c.actors[2]; const { run, e } = await c.invoke(h);
      const card = await c.append(h, run, { kind: 'approval.create', approval: { actor_id: h.b.account_id, effect_id: 'fictional-secret-effect', digest: 'd'.repeat(64), title: 'fictional-other-tenant-sentinel-slice34', expires_in_seconds: 3600 } });
      const a = await c.attachment(h); await c.send(h, h.a, await c.envelope(h, h.a, { text: 'fictional-other-tenant-sentinel-slice34', attachments: [a.value.attachment_id] }));
      const s = await c.snapshot(h);
      const requests = [
        [room(h) + '/replay', 'POST', { thread_id: h.r.thread_id, cursor: s.cursor, snapshot_id: s.snapshot_id }],
        [room(h) + '/snapshots/' + s.snapshot_id], [room(h) + '/history?thread_id=' + h.r.thread_id],
        [root(h) + '/operations/' + e.client_operation_id], [root(h) + '/operations'],
        [root(h) + '/hosts/' + h.host.host_id + '/invocations'],
        [root(h) + '/hosts/' + h.host.host_id + '/claim', 'POST', { invocation_id: run.invocation_id }],
        [root(h) + '/hosts/' + h.host.host_id + '/context', 'POST', binding(run)],
        [room(h) + '/approvals/' + card.approval_id],
        [room(h) + '/approvals/' + card.approval_id + '/decision', 'POST', { ...binding(run), version: 1, effect_id: card.effect_id, digest: card.digest, decision: 'approve' }],
        [root(h) + '/attachments', 'POST', { room_id: h.r.room_id, thread_id: h.r.thread_id, name: 'fictional', size: 2, type: 'text/plain', checksum: 'a'.repeat(64) }],
        [root(h) + '/attachments/' + a.value.attachment_id + '/complete', 'POST', {}],
        [root(h) + '/attachments/' + a.value.attachment_id],
      ];
      const responses = [];
      for (const [path, method, body] of requests) responses.push(await c.request(path, foreign, method ?? 'GET', body, h.host.host_credential));
      responses.push(await c.raw(root(h) + '/attachments/' + a.value.attachment_id + '/download', foreign, { range: 'bytes=0-2' }));
      const discovery = await c.ok('/v2/discovery/sync', foreign); assert.ok(!discovery.workspaces.some(w => w.workspace_id === h.w));
      for (const r of responses) assert.equal(r.status, 403);
      const socket = await c.socket(foreign); socket.subscribe(h); await c.until(() => socket.frames.some(v => v.type === 'error'), 'foreign stream refusal'); socket.ws.terminate();
      const registrations = await c.sql('SELECT * FROM cloud.push_registrations WHERE workspace_id=$1 AND account_id=$2', [h.w, foreign.account_id]); assert.equal(registrations.length, 0);
      c.log({ type: 'indirect_route_matrix', routes: requests.map(v => v[0]), responses, discovery });
      return { sentinel_leaks: responses.filter(r => JSON.stringify(r.data ?? r.data_base64).includes('fictional-other-tenant-sentinel-slice34')).length,
        unauthorized_invocations: (await c.sql('SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND source_actor_id=$2', [h.w, foreign.account_id])).length };
    },
    'invite-expiry-replay-revoke-last-owner': async () => {
      const h = await c.humans('invite-boundary'); const foreign = c.actors[2];
      const invite = await c.ok(root(h) + '/invites', h.a, 'POST', { role: 'owner', room_ids: [h.r.room_id], expires_in_seconds: 1 });
      await c.pause(1100); const expired = await c.request('/v2/invites/redeem', foreign, 'POST', { token: invite.token }); assert.equal(expired.data.error, 'invite_expired');
      const revoked = await c.ok(root(h) + '/invites', h.a, 'POST', { role: 'owner', room_ids: [h.r.room_id] });
      await c.ok(root(h) + '/invites/' + revoked.invite_id, h.a, 'DELETE');
      assert.equal((await c.request('/v2/invites/redeem', foreign, 'POST', { token: revoked.token })).data.error, 'invite_revoked');
      const once = await c.ok(root(h) + '/invites', h.a, 'POST', { role: 'guest', room_ids: [h.r.room_id] });
      await c.ok('/v2/invites/redeem', foreign, 'POST', { token: once.token });
      assert.equal((await c.request('/v2/invites/redeem', foreign, 'POST', { token: once.token })).data.error, 'invite_used');
      assert.equal((await c.request(root(h) + '/members/' + h.a.account_id, h.a, 'DELETE')).data.error, 'last_owner');
      const owners = await c.sql("SELECT * FROM cloud.members WHERE workspace_id=$1 AND role='owner'", [h.w]);
      const gains = await c.sql("SELECT * FROM cloud.members WHERE workspace_id=$1 AND account_id=$2 AND role='owner'", [h.w, foreign.account_id]);
      return { ownerless_workspaces: +(owners.length === 0), invalid_invite_privilege_gains: gains.length };
    },
    'guest-death-recorded-unrecorded-intent': async () => {
      const h = await c.humans('guest-memory'); const s = await c.snapshot(h); const e = await c.envelope(h); let writes = 0;
      const storage = { getItem: () => null, setItem: () => { writes++; } };
      const session = { ...h.b, baseUrl: c.f.url };
      let online = true, networkListener;
      const offline = { online: () => online, subscribe: fn => { networkListener = fn; return () => { networkListener = undefined; }; } };
      const api = c.client.cloudApi(session);
      const make = () => new c.client.CloudRoomController(session, api, { workspace_id: h.w, room_id: h.r.room_id, thread_id: h.r.thread_id, policy_revision: s.policy_revision, guest: true }, storage, c.WebSocket, () => {}, offline);
      const guest = make(); guest.start();
      assert.equal(await guest.send('fictional guest recorded online'), null);
      await c.until(() => guest.getState().outbox.some(e => e.state === 'accepted'), 'real guest send recorded');
      online = false; networkListener(false);
      assert.equal(await guest.send('fictional guest never transmitted'), null);
      const drafts = guest.getState().outbox.filter(e => e.state === 'draft'); assert.equal(drafts.length, 1);
      guest.stop();
      const recorded = await c.send(h, h.b, e); const recreated = make();
      assert.equal((await c.lookup(h, h.b, e)).message_id, recorded.message_id);
      recreated.start(); const recreatedOutbox = recreated.getState().outbox; recreated.stop();
      c.log({ type: 'real_guest_controller_death', writes, recreatedOutbox, recorded, client_artifact: c.clientArtifact });
      return { persistent_guest_payloads: writes, unrecorded_guest_intent_recreated: recreatedOutbox.length };
    },
    'account-switch-logout-unresolved-send': async () => {
      const h = await c.humans('switch'); const e = await c.envelope(h); let initial = state(h, h.b, [{ ...entry(e), state: 'checking', dispatched: true }]);
      initial = c.client.cloudRoomReducer(initial, { type: 'snapshot', snapshot: await c.snapshot(h) });
      const switched = c.client.cloudRoomReducer(initial, { type: 'account_switch', namespace: h.a.subject, account_id: h.a.account_id });
      const work = c.client.nextWork(initial.outbox, { ...e.namespace, account_id: h.a.account_id, subject: h.a.subject }, Date.now());
      c.log({ type: 'actual_account_switch', initial, switched, work, client_artifact: c.clientArtifact });
      return { cross_account_content: switched.messages.length + switched.outbox.length,
        automatic_original_account_resend: work.filter(w => w.kind === 'send').length };
    },
    'attachment-interrupt-malformed-size-type': async () => {
      const h = await c.humans('attachment-validation'); const bytes = Buffer.from('fictional original bytes'); const a = await c.allocate(h, h.a, bytes);
      const interrupted = await c.raw(a.upload_url, h.a, { method: 'PUT', body: bytes.subarray(0, 3) }); assert.equal(interrupted.status, 400);
      const unready = await c.send(h, h.a, await c.envelope(h, h.a, { attachments: [a.attachment.attachment_id] })); assert.equal(unready.reason, 'attachment_unready');
      const tooBig = await c.request(root(h) + '/attachments', h.a, 'POST', { room_id: h.r.room_id, thread_id: h.r.thread_id, name: 'fictional', size: 10485761, type: 'text/plain', checksum: 'a'.repeat(64) }); assert.equal(tooBig.status, 400);
      const unsupported = await c.request(root(h) + '/attachments', h.a, 'POST', { room_id: h.r.room_id, thread_id: h.r.thread_id, name: 'fictional', size: 1, type: 'application/x-evil', checksum: 'a'.repeat(64) }); assert.equal(unsupported.status, 400);
      const wrongType = await c.attachment(h, h.a, Buffer.from('fictional not a PNG'), 'image/png'); assert.equal(wrongType.value.state, 'rejected');
      const rows = await c.sql('SELECT * FROM cloud.attachment_objects WHERE workspace_id=$1', [h.w]);
      return { unready_attachment_messages: (await c.history(h)).filter(m => m.attachment_ids?.includes(a.attachment.attachment_id)).length,
        oversized_ready_objects: rows.filter(r => r.state === 'ready' && Number(r.size) > 10485760).length,
        wrong_type_ready_objects: +(wrongType.value.state === 'ready') };
    },
    'attachment-quarantine-checksum-orphan': async () => {
      const h = await c.humans('quarantine'); const a = await c.attachment(h, h.a, Buffer.from('EICAR fictional sentinel')); assert.equal(a.value.state, 'rejected');
      const quarantined = await c.raw(root(h) + '/attachments/' + a.value.attachment_id + '/download', h.a); assert.equal(quarantined.status, 409);
      const bad = await c.allocate(h, h.a, Buffer.from('fictional expected'));
      const mismatch = await c.raw(bad.upload_url, h.a, { method: 'PUT', body: Buffer.from('fictional changed') }); assert.equal(mismatch.status, 400);
      const orphan = await c.attachment(h); await expiry(h, 'attachment_objects', 'attachment_id', orphan.value.attachment_id); await c.f.service.tickWorker();
      const orphanDenied = await c.raw(root(h) + '/attachments/' + orphan.value.attachment_id + '/download', h.a); assert.equal(orphanDenied.status, 409);
      const rows = await c.sql('SELECT * FROM cloud.attachment_objects WHERE workspace_id=$1', [h.w]);
      return { quarantine_downloads: +(quarantined.status === 200), checksum_mismatch_ready: rows.filter(v => v.attachment_id === bad.attachment.attachment_id && v.state === 'ready').length,
        expired_orphan_downloads: +(orphanDenied.status === 200) };
    },
    'attachment-revoked-download-every-range': async () => {
      const h = await c.humans('ranges'); const a = await c.attachment(h); assert.equal(a.value.state, 'ready');
      await c.send(h, h.a, await c.envelope(h, h.a, { attachments: [a.value.attachment_id] }));
      const path = root(h) + '/attachments/' + a.value.attachment_id;
      const metadata = await c.ok(path, h.b); assert.equal(metadata.state, 'ready');
      for (const range of ['bytes=0-3', 'bytes=4-', 'bytes=-4']) assert.equal((await c.raw(path + '/download', h.b, { range })).status, 206);
      const gate = c.gate('attachment.download.before_admission', { workspace_id: h.w, account_id: h.b.account_id });
      const pending = c.raw(path + '/download', h.b, { range: 'bytes=0-1' }); pending.catch(() => {}); let held;
      try { await gate.waitUntilReached(); await c.ok(root(h) + '/members/' + h.b.account_id, h.a, 'DELETE'); await gate.release(); held = await pending; }
      finally { await gate.cleanup(); await pending.catch(() => {}); }
      assert.equal(held.status, 403); const after = [held];
      for (const range of ['bytes=0-3', 'bytes=4-', 'bytes=-4']) after.push(await c.raw(path + '/download', h.b, { range }));
      for (const r of after) assert.equal(r.status, 403);
      return { post_removal_range_admissions: after.filter(r => r.status === 200 || r.status === 206).length };
    },
    'approval-expired-revoked-version-digest': async () => {
      const h = await c.humans('approval-invalid', { runtime: true }); let invalid = 0;
      const { run } = await c.invoke(h);
      const card = await c.append(h, run, { kind: 'approval.create', approval: { actor_id: h.b.account_id, effect_id: 'fictional-effect', digest: 'a'.repeat(64), title: 'fictional only source actor', expires_in_seconds: 3600 } });
      const path = room(h) + '/approvals/' + card.approval_id + '/decision'; const base = { ...binding(run), version: card.version, effect_id: card.effect_id, digest: card.digest, decision: 'approve' };
      const wrongActor = await c.request(path, h.a, 'POST', base); assert.equal(wrongActor.status, 403); invalid += +(wrongActor.status === 200);
      for (const change of [{ version: 2 }, { digest: 'b'.repeat(64) }, { effect_id: 'fictional-wrong-effect' }, { attempt: 9 }, { fence_gen: '999' }]) {
        const denied = await c.request(path, h.b, 'POST', { ...base, ...change }); assert.equal(denied.status, 409); invalid += +(denied.status === 200);
      }
      await expiry(h, 'approvals', 'approval_id', card.approval_id);
      const expired = await c.request(path, h.b, 'POST', base); assert.equal(expired.status, 409); assert.equal(expired.data.error, 'approval_expired'); invalid += +(expired.status === 200);
      const next = await c.invoke(h); const revoked = await c.append(h, next.run, { kind: 'approval.create', approval: { actor_id: h.b.account_id, effect_id: 'fictional-revoked-effect', digest: 'c'.repeat(64), title: 'fictional revoked', expires_in_seconds: 3600 } });
      await c.ok(root(h) + '/members/' + h.b.account_id, h.a, 'DELETE');
      const denied = await c.request(room(h) + '/approvals/' + revoked.approval_id + '/decision', h.b, 'POST', { ...binding(next.run), version: 1, effect_id: revoked.effect_id, digest: revoked.digest, decision: 'approve' }); assert.equal(denied.status, 403); invalid += +(denied.status === 200);
      const session = { ...h.a, baseUrl: c.f.url }, s = await c.snapshot(h, h.a);
      const controller = new c.client.CloudRoomController(session, c.client.cloudApi(session),
        { workspace_id: h.w, room_id: h.r.room_id, thread_id: h.r.thread_id, policy_revision: s.policy_revision }, null,
        c.WebSocket, () => {}, { online: () => false, subscribe: () => () => {} });
      controller.start(); assert.equal(await controller.decide(card, 'approve'), 'offline');
      const replayedControls = controller.getState().outbox.filter(e => e.envelope.kind !== 'message.send').length; controller.stop();
      c.log({ type: 'approval_actor_pin', card, revoked, wrongActor, expired, denied });
      return { invalid_approval_decisions: invalid, automatic_offline_control_replay: replayedControls };
    },
    'push-redacted-committed-event-dedupe': async () => {
      const h = await c.humans('push-hints'); const e = await c.envelope(h, h.a, { text: 'fictional sensitive text e\u0301' }); await c.send(h, h.a, e);
      const reg = await c.ok(root(h) + '/push-registrations', h.b, 'POST', { installation_id: 'fictional-installation', generation: '1', token_version: '1', provider: 'apns', environment: 'sandbox', muted: false });
      const events = await c.sql("SELECT * FROM cloud.room_events WHERE workspace_id=$1 AND kind='message.created'", [h.w]);
      const first = await c.f.service.push.build(h.b.bearer, h.w, h.r.room_id, reg.registration_id, events[0].event_id);
      const duplicate = await c.f.service.push.build(h.b.bearer, h.w, h.r.room_id, reg.registration_id, events[0].event_id);
      assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true);
      const renewed = await c.ok(root(h) + '/push-registrations', h.b, 'POST', { installation_id: 'fictional-installation', generation: '1', token_version: '2', provider: 'apns', environment: 'sandbox', muted: false });
      assert.equal((await c.f.service.push.build(h.b.bearer, h.w, h.r.room_id, renewed.registration_id, events[0].event_id)).duplicate, true);
      await c.ok(root(h) + '/members/' + h.b.account_id, h.a, 'DELETE');
      const registrations = await c.sql('SELECT revoked FROM cloud.push_registrations WHERE workspace_id=$1', [h.w]); assert.ok(registrations.every(r => r.revoked));
      const hints = await c.sql('SELECT * FROM cloud.push_hints WHERE workspace_id=$1', [h.w]);
      c.log({ type: 'push_builder_local_only', first, duplicate, hints });
      return { duplicate_committed_event_hints: Math.max(0, hints.length - 1), sensitive_preview_fields: +JSON.stringify(first.payload).includes(e.text), real_push_dispatches: 0 };
    },
  };
}
