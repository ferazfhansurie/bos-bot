import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { root, digest } from './slice34-service-adapter.mjs';
import { freezeManifest } from './oracle.mjs';

/** Uses production conversation-only provider isolation. Never infers the
 * actual model from configuration: a native session.started receipt is required. */
export async function providerTurn(instance, { invocation, prompt }, io, { record = () => {}, timeoutMs = 120000 } = {}) {
  const threadId = 'acceptance-' + invocation.invocation_id;
  return new Promise(resolve => {
    let model = null, text = '', done = false;
    let unsubscribe = () => {};
    const stop = () => instance.adapter.interruptTurn(threadId).catch(() => {});
    const finish = result => {
      if (done) return; done = true;
      clearTimeout(timer); unsubscribe(); io.signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const fail = failure => { void stop(); finish({ ok: false, failure, model }); };
    const abort = () => fail('native acceptance turn aborted');
    const timer = setTimeout(() => fail('native acceptance provider deadline'), timeoutMs);
    unsubscribe = instance.adapter.onEvent(event => {
      if (event.threadId !== threadId || done) return;
      // Only the fictional turn's canonical messages enter shareable evidence.
      record(event);
      if (event.type === 'session.started') {
        model = event.model ?? null;
        if (model !== invocation.model.model) fail('provider-reported model differs from the frozen pin');
      } else if (event.type === 'model.switched') fail('provider changed models');
      else if (event.type === 'request.opened' || event.type === 'tool.started') fail('unexpected native tool or approval');
      else if (event.type === 'content.delta' && event.streamKind === 'assistant_text') io.onDelta(event.delta);
      else if (event.type === 'item.completed' && event.itemType === 'assistant_text') text += (text ? '\n' : '') + event.text;
      else if (event.type === 'turn.completed') {
        if (event.ok && model === invocation.model.model) finish({ ok: true, text, model });
        else finish({ ok: false, failure: 'no successful native completion with model receipt', model });
      }
    });
    io.signal.addEventListener('abort', abort, { once: true });
    if (io.signal.aborted) return abort();
    const input = { threadId, botId: invocation.bot_id, text: prompt, model: invocation.model.model,
      effort: 'low', sharedContext: { mode: 'conversation-only' }, approvalMode: 'ask',
      system: 'Reply to this fictional acceptance message. Follow its requested short answer exactly. No tools, files or external actions.' };
    record({ type: 'provider_input', ...input });
    instance.adapter.sendTurn(input).catch(() => fail('native provider dispatch failed'));
  });
}

export async function nativeHostScenarios(c, { server, model = 'claude-sonnet-4-6', cli = 'claude' }) {
  assert.match(model, /^claude-[a-z0-9.-]+$/);
  const { CloudRoomHost } = await import(pathToFileURL(server + '/server/cloud-host.ts').href);
  const { ClaudeDriver } = await import(pathToFileURL(server + '/server/drivers/claude.ts').href);
  const pinned = { provider: 'anthropic', model, config_revision: '1' };
  const h = await c.humans('two-human-native');
  h.model = pinned;
  const bots = ['fictional-bot-a', 'fictional-bot-b'];
  for (const bot_id of bots) await c.ok(root(h) + '/bots', h.a, 'POST', { bot_id, name: bot_id, room_ids: [h.r.room_id], model: pinned });
  h.host = await c.ok(root(h) + '/hosts', h.a, 'POST', { name: 'fictional native host', bot_ids: bots, capabilities: ['cooperative_read_only'] });
  const build = Object.fromEntries(['server/cloud-host.ts', 'server/drivers/claude.ts'].map(path =>
    [path, createHash('sha256').update(readFileSync(server + '/' + path)).digest('hex')]));
  const instance = await ClaudeDriver.create({ instanceId: 'fictional-slice34-native', displayName: 'fictional native host',
    enabled: true, config: ClaudeDriver.decodeConfig({ cli }), environment: { OMB_CLAUDE_INHERIT_USER_CONFIG: '0' } });
  const records = new Map();
  const host = new CloudRoomHost({ baseUrl: c.f.url, workspaceId: h.w, hostId: h.host.host_id,
    credential: h.host.host_credential, bearer: h.a.bearer, fetch, canHost: id => bots.includes(id),
    pollMs: 150, heartbeatMs: 2000, maxConcurrent: 2, deltaFlushMs: 25,
    log: message => c.log({ type: 'native_host_log', message }),
    stopTurn: id => instance.adapter.interruptTurn('acceptance-' + id),
    runTurn: async (turn, io) => {
      assert.equal(turn.prompt, turn.invocation.source.text);
      const r = { invocation: turn.invocation, context: turn.context, ingress: turn.prompt, events: [] };
      records.set(turn.invocation.invocation_id, r);
      {
        r.result = await providerTurn(instance, turn, io, { record: event => { r.events.push(event); c.log({ type: 'native_provider', invocation_id: turn.invocation.invocation_id, event }); } });
        r.artifact = c.artifact('native-provider-' + turn.invocation.invocation_id, { host_build: build, ...r });
        return r.result;
      }
    },
  });
  let execution, manifests;
  const sourceIntents = name => bots.map((bot, index) => ({ id: name + '-source-' + index,
    envelope: { room_id: h.r.room_id, actor_alias: index ? 'fictional-bob' : 'fictional-alice',
      text: `@${bot} reply exactly: @${bots[1-index]} receipt ${index} e\u0301 🦊`,
      mentions: [{ bot_alias: bot, start: 0, end: bot.length + 1 }], pinned_model: pinned },
    expected: { canonical_finals: 1, private_tasks: 0 },
  }));
  // Two logical gate manifests refer to the same deliberately bounded pair of
  // provider calls; neither gate generates an additional turn.
  async function execute() {
    const intents = sourceIntents('two-human-native');
    manifests = intents;
    freezeManifest(c.evidence + '/two-human-native.sources.manifest.json', { candidate: c.candidate, protocol: c.schema, scope: { workspace_id: h.w, room_id: h.r.room_id }, operations: intents });
    const envelopes = [];
    for (let index = 0; index < intents.length; index++) {
      const actor = index ? h.b : h.a, intent = intents[index];
      const envelope = await c.envelope(h, actor, { text: intent.envelope.text });
      envelope.mentions = [{ kind: 'bot', id: bots[index], start: 0, end: bots[index].length + 1 }];
      envelopes.push({ actor, envelope, intent });
    }
    freezeManifest(c.evidence + '/two-human-native.wire.manifest.json', { candidate: c.candidate, protocol: c.schema, scope: { workspace_id: h.w, room_id: h.r.room_id },
      operations: envelopes.map(({ actor, envelope, intent }) => ({ id: intent.id, actor_id: actor.account_id, envelope, expected: intent.expected })) });
    const snapshots = await Promise.all([c.snapshot(h, h.a), c.snapshot(h, h.b)]);
    const sockets = await Promise.all([c.socket(h.a), c.socket(h.b)]);
    sockets.forEach((s, i) => s.subscribe(h, snapshots[i]));
    await c.until(() => sockets.every(s => s.frames.some(f => f.type === 'event_batch' && f.live)), 'two recipient subscriptions');
    // Both human sends are admitted before the first host poll. No implicit
    // steer into an already-running provider turn is possible on this path.
    const sends = await Promise.all(envelopes.map(({ actor, envelope }) => c.send(h, actor, envelope)));
    sends.forEach(s => assert.equal(s.status, 'accepted'));
    host.start();
    const invocations = await c.until(async () => {
      await c.pause(150);
      const rows = await c.sql('SELECT * FROM cloud.invocations WHERE workspace_id=$1 ORDER BY source_message_id', [h.w]);
      if (rows.some(v => records.get(v.invocation_id)?.result?.ok === false)) throw new Error('native provider failed; see native provider transcript');
      return rows.length === 2 && rows.every(v => v.state === 'completed') ? rows : null;
    }, 'two real native finals', 150000);
    await c.until(() => sockets.every(s => s.frames.flatMap(f => f.type === 'event_batch' ? f.events : []).filter(e => e.kind === 'final.commit').length === 2), 'both websocket recipient finals', 10000);
    await c.pause(600); // four host polls after the bot finals, then independent DB readback
    const settled = await c.sql('SELECT * FROM cloud.invocations WHERE workspace_id=$1', [h.w]);
    const history = await Promise.all([c.history(h, h.a), c.history(h, h.b)]);
    const finals = history[0].filter(m => m.bot_id);
    assert.equal(finals.length, 2); finals.forEach(m => assert.deepEqual(m.mentions, []));
    const triggers = intents.map((intent, index) => {
      const invocation = invocations.find(v => v.source_message_id === sends[index].message_id);
      assert.ok(invocation); const r = records.get(invocation.invocation_id); assert.equal(r.result.ok, true);
      assert.equal(r.ingress, envelopes[index].envelope.text);
      const { digest: serviceDigest, ...serviceSource } = invocation.source;
      assert.equal(serviceDigest, digest(serviceSource));
      assert.equal(invocation.source.actor_id, envelopes[index].actor.account_id);
      assert.deepEqual(invocation.source.mentions, envelopes[index].envelope.mentions);
      const input = r.events.find(e => e.type === 'provider_input'); assert.equal(input.text, r.ingress);
      const actual = r.events.find(e => e.type === 'session.started'); assert.equal(actual.model, model);
      const completed = r.events.filter(e => e.type === 'turn.completed'); assert.equal(completed.length, 1); assert.equal(completed[0].ok, true);
      const canonical_finals = finals.filter(m => m.message_id === invocation.result_message_id); assert.equal(canonical_finals.length, 1);
      assert.equal(canonical_finals[0].text, r.result.text);
      assert.ok(canonical_finals[0].text.includes('@' + bots[1-index]), 'bot reply deliberately names another bot');
      const recipient_views = history.map((messages, i) => {
        const final = messages.find(m => m.message_id === invocation.result_message_id); assert.deepEqual(final, canonical_finals[0]);
        const socket = sockets[i].frames.flatMap(f => f.type === 'event_batch' ? f.events : []).find(e => e.kind === 'final.commit' && e.payload.invocation_id === invocation.invocation_id);
        assert.ok(socket); assert.equal(socket.payload.message.message_id, final.message_id);
        return { actor_id: i ? h.b.account_id : h.a.account_id, final, websocket_receipt: socket };
      });
      return { source_intent_id: intent.id, actor_alias: intent.envelope.actor_alias, source: intent.envelope,
        invocation_id: invocation.invocation_id, ingress_digest: digest(intent.envelope), provider_input_digest: digest({ ...intent.envelope, text: input.text }),
        service_source_digest: serviceDigest, actual_model: { ...pinned, model: actual.model }, pinned_model: invocation.model,
        provider_receipt: { session_id: actual.sessionId, turn_id: completed[0].turnId, actual_model: actual.model, ok: completed[0].ok },
        host_build: build, provider_transcript_artifact: r.artifact, final_room_id: canonical_finals[0].room_id,
        canonical_finals, private_task_count: Object.hasOwn(input, 'resumeCursor') || Object.hasOwn(input, 'integrations') ? 1 : 0, recipient_views };
    });
    const controlEvents = await c.sql("SELECT kind,payload FROM cloud.room_events WHERE workspace_id=$1 AND kind IN ('stop.requested','stop.observed')", [h.w]);
    const automatic = settled.filter(v => !sends.some(s => s.message_id === v.source_message_id));
    assert.equal(automatic.length, 0); assert.equal(settled.length, 2);
    return { triggers, settled, controlEvents, sends, finals, native_intents: intents,
      implicit_steer_count: settled.filter(v => BigInt(v.control_revision) !== 0n).length + controlEvents.length,
      automatic_bot_reply_trigger_count: automatic.length };
  }
  return {
    descriptor: { native_provider_available: true, pinned_model: pinned, scope: { workspace_id: h.w, room_id: h.r.room_id, fictional: true },
      limitations: ['native host + production Claude driver on macOS; recipients are real issuer sessions over HTTP/WebSocket, not native UI/device receipts', 'does not exercise server/index.ts startTurn wiring or certify the separate model-pin gate'] },
    sourceIntents,
    scenario: async spec => {
      execution ??= execute();
      const run = await execution;
      const observed = spec.name === 'two-human-native'
        ? { canonical_finals_per_trigger: Math.max(...run.triggers.map(t => t.canonical_finals.length)), private_task_count: Math.max(...run.triggers.map(t => t.private_task_count)) }
        : { implicit_steer_count: run.implicit_steer_count, automatic_bot_reply_trigger_count: run.automatic_bot_reply_trigger_count };
      const observation = c.observation(spec, observed);
      observation.native = { triggers: run.triggers };
      observation.native_intents = manifests;
      observation.native_run_artifact = c.artifact(spec.name + '-native-run', run);
      for (const key of spec.evidence) observation.evidence[key].push(observation.native_run_artifact);
      return observation;
    },
    close: async () => { host.stop(); await instance.dispose(); },
  };
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
