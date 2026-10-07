import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownedFixture, pause, until } from './slice34-owned-fixture.mjs';
import { Transport, redact, localURL } from './transport.mjs';
import { Slice34Driver } from './slice34-binding.mjs';
import { serviceScenarios } from './slice34-service-scenarios.mjs';

// Independent serialization. Never import the oracle or SUT digest implementation.
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object'
  ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
export const digest = v => createHash('sha256').update(canonical(v)).digest('hex');
const bytesDigest = b => createHash('sha256').update(b).digest('hex');
export const root = h => `/v2/workspaces/${h.w}`;
export const room = h => `${root(h)}/rooms/${h.r.room_id}`;
export const binding = v => ({ invocation_id: v.invocation_id, attempt: v.attempt, fence_gen: v.fence_gen });

export async function connect({ server, candidate, schema, evidence, record }) {
  const f = await ownedFixture(server, { evidence, record });
  const require = createRequire(server + '/services/cloud/package.json');
  const pg = require('pg'), WebSocket = require('ws').WebSocket;
  const admin = new pg.Client({ connectionString: f.migration_url, query_timeout: 5000 });
  const sockets = new Set();
  let trace = [], serial = 0;
  const log = v => { const entry = redact(v); trace.push(entry); record(entry); };
  const artifact = (label, data, { privateData = false } = {}) => {
    const path = resolve(evidence, `${String(++serial).padStart(6, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    const raw = JSON.stringify(privateData ? data : redact(data), null, 2) + '\n';
    writeFileSync(path, raw, { mode: 0o600, flag: 'wx', flush: true });
    return { path, sha256: bytesDigest(raw) };
  };
  const c = { f, admin, server, evidence, log, artifact, digest, pause, until, sockets, WebSocket, candidate, schema };
  // Browser WebSocket errors are DOM events. Node ws additionally throws when
  // no EventEmitter error listener exists (e.g. stop before the TCP handshake).
  c.BrowserSocket = class extends WebSocket {
    constructor(...args) { super(...args); this.on('error', e => log({ type: 'browser_socket_error', message: e.message })); }
  };
  c.transport = new Transport(f.url, log);
  c.request = (path, actor, method = 'GET', body, hostCredential) => c.transport.request(path,
    { method, body, token: actor?.bearer, hostCredential });
  c.ok = async (path, actor, method = 'GET', body, hostCredential) => {
    const response = await c.request(path, actor, method, body, hostCredential);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.data)}`); return response.data;
  };
  c.sql = async (text, values = []) => {
    const result = await admin.query(text, values); log({ type: 'durable_sql', text, values, rows: result.rows }); return result.rows;
  };
  c.issuerRequest = async (path, options = {}) => fetch(new URL(path, f.issuer_url),
    { ...options, redirect: 'error', signal: AbortSignal.timeout(6000) });
  c.actor = async label => {
    const email = `fictional_${label}_${randomUUID()}@example.test`, origin = 'http://127.0.0.1:5199';
    const headers = { 'content-type': 'application/json', origin };
    const sent = await c.issuerRequest('/api/auth/email-otp/send-verification-otp', { method: 'POST', headers, body: JSON.stringify({ email, type: 'sign-in' }) });
    assert.equal(sent.status, 200, 'real issuer OTP dispatch');
    const sink = await c.issuerRequest('/__dev/otp?email=' + encodeURIComponent(email));
    assert.equal(sink.status, 200); const { otp } = await sink.json();
    const signed = await c.issuerRequest('/api/auth/sign-in/email-otp', { method: 'POST', headers, body: JSON.stringify({ email, otp }) });
    assert.equal(signed.status, 200); const bearer = signed.headers.get('set-auth-token'); assert.ok(bearer);
    const identity = await c.ok('/v2/me', { bearer });
    log({ type: 'real_issuer_identity', label, email, identity }); return { ...identity, bearer, email };
  };
  c.humans = async (name, { runtime = false, role = 'guest', actors = c.actors } = {}) => {
    const [a, b] = actors;
    const w = (await c.ok('/v2/workspaces', a, 'POST', { name: 'fictional ' + name })).workspace_id;
    const r = await c.ok(`/v2/workspaces/${w}/rooms`, a, 'POST', { name: 'fictional ' + name });
    const invite = await c.ok(`/v2/workspaces/${w}/invites`, a, 'POST', { role, room_ids: [r.room_id] });
    await c.ok('/v2/invites/redeem', b, 'POST', { token: invite.token });
    const h = { a, b, w, r, model: { provider: 'fixture', model: 'fictional-pinned-no-provider', config_revision: '1' } };
    if (runtime) {
      const scope = { workspace_id: w, room_id: r.room_id };
      const driver = new Slice34Driver(c.transport, a.bearer);
      await driver.json('botRegister', scope, { bot_id: 'fictional-bot', name: 'fictional bot', room_ids: [r.room_id], model: h.model });
      h.host = await driver.json('hostRegister', scope, { name: 'fictional host', bot_ids: ['fictional-bot'], capabilities: ['cooperative_read_only'] });
      h.driver = new Slice34Driver(c.transport, a.bearer, h.host.host_credential);
    }
    return h;
  };
  c.snapshot = (h, actor = h.b) => c.ok(room(h) + '/snapshot', actor, 'POST', { thread_id: h.r.thread_id });
  c.envelope = async (h, actor = h.b, { text = 'fictional exact e\u0301 🦊', bot = false, attachments = [], window } = {}) => {
    window ??= await c.ok(root(h) + '/operation-windows', actor, 'POST', {});
    const snapshot = await c.snapshot(h, actor);
    return { kind: 'message.send', namespace: window.namespace, window_token: window.window_token,
      client_operation_id: window.window_id + '.' + randomUUID().replaceAll('-', ''),
      room_id: h.r.room_id, thread_id: h.r.thread_id, text: bot ? '@fictional-bot ' + text : text,
      mentions: bot ? [{ kind: 'bot', id: 'fictional-bot', start: 0, end: 14 }] : [],
      attachment_ids: attachments, reply_to_message_id: null, expected_policy_revision: snapshot.policy_revision };
  };
  c.send = (h, actor, e) => c.ok(root(h) + '/messages', actor, 'POST', e);
  c.lookup = (h, actor, e) => c.ok(root(h) + '/operations/' + e.client_operation_id, actor);
  c.seal = (h, actor, e) => c.ok(root(h) + '/operations/' + e.client_operation_id + '/resolve-not-accepted', actor, 'POST', e);
  c.invoke = async h => {
    const e = await c.envelope(h, h.b, { bot: true }); const sent = await c.send(h, h.b, e);
    assert.equal(sent.status, 'accepted');
    const offers = await h.driver.json('hostInvocations', { workspace_id: h.w, host_id: h.host.host_id });
    const offered = offers.invocations.find(v => v.source.message_id === sent.message_id); assert.ok(offered);
    const run = await h.driver.json('hostClaim', { workspace_id: h.w, host_id: h.host.host_id }, { invocation_id: offered.invocation_id });
    return { e, sent, run };
  };
  c.append = (h, run, event) => h.driver.json('hostEvents', { workspace_id: h.w, host_id: h.host.host_id }, { ...binding(run), ...event });
  c.appendRequest = (h, run, event) => c.request(root(h) + '/hosts/' + h.host.host_id + '/events', h.a, 'POST', { ...binding(run), ...event }, h.host.host_credential);
  c.history = async (h, actor = h.b) => {
    let before = '9223372036854775807', messages = [];
    for (;;) {
      const page = await c.ok(room(h) + '/history?thread_id=' + h.r.thread_id + '&before=' + before + '&limit=100', actor);
      messages.unshift(...page.messages); if (!page.next_before) return messages;
      assert.ok(BigInt(page.next_before) < BigInt(before)); before = page.next_before;
    }
  };
  c.replay = (h, actor, snapshot, cursor = snapshot.cursor) => c.ok(room(h) + '/replay', actor, 'POST', { thread_id: h.r.thread_id, cursor, snapshot_id: snapshot.snapshot_id });
  c.gate = (point, match) => {
    const id = randomUUID(); f.hooks.arm(id, point, match);
    let barrier;
    return { boundary: 'before-protected-admission', waitUntilReached: async () => {
      const state = await until(() => { const g = f.hooks.state().find(v => v.id === id); return g?.entered && g.waiting === 1 ? g : null; }, 'real admission hook');
      barrier = artifact('admission-barrier', { boundary: 'before-protected-admission', point, match, ...state });
    }, release: async () => {
      assert.ok(f.hooks.state().find(v => v.id === id)?.entered, 'hook expired before release'); f.hooks.release(id);
    }, cleanup: async () => f.hooks.release(id), artifact: () => barrier };
  };
  c.raw = async (url, actor, { method = 'GET', body, range } = {}) => {
    const target = localURL(new URL(url, f.url)); assert.equal(target.origin, f.url);
    const response = await fetch(target, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: 'Bearer ' + actor.bearer, ...(range ? { range } : {}) }, ...(body ? { body: new Uint8Array(body) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const item = { type: 'raw_http', path: target.pathname, method, range, status: response.status,
      headers: Object.fromEntries(response.headers), bytes: bytes.length, sha256: bytesDigest(bytes), data_base64: bytes.toString('base64') };
    log(item); return { ...item, bytes };
  };
  c.allocate = async (h, actor, bytes, type = 'text/plain', change = {}) => c.ok(root(h) + '/attachments', actor, 'POST',
    { room_id: h.r.room_id, thread_id: h.r.thread_id, name: '../fictional.txt', size: bytes.length, type, checksum: bytesDigest(bytes), ...change });
  c.attachment = async (h, actor = h.a, bytes = Buffer.from('fictional safe bytes'), type = 'text/plain') => {
    const a = await c.allocate(h, actor, bytes, type); assert.equal((await c.raw(a.upload_url, actor, { method: 'PUT', body: bytes })).status, 200);
    const ready = await c.ok(root(h) + '/attachments/' + a.attachment.attachment_id + '/complete', actor, 'POST', {});
    return { allocation: a, value: ready, bytes };
  };
  c.socket = async actor => {
    const ws = new WebSocket(f.ws_url); sockets.add(ws); const trace = { ws, frames: [], code: null };
    ws.on('message', b => { const frame = JSON.parse(b.toString()); trace.frames.push(frame); log({ type: 'ws_frame', account_id: actor.account_id, frame }); });
    ws.on('error', e => log({ type: 'ws_error', message: e.message }));
    ws.on('close', code => { trace.code = code; sockets.delete(ws); log({ type: 'ws_close', code }); });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ type: 'authenticate', bearer: actor.bearer }));
    await until(() => trace.frames.some(v => v.type === 'heartbeat'), 'real socket authentication');
    trace.subscribe = (h, s) => ws.send(JSON.stringify({ type: 'subscribe', workspace_id: h.w, room_id: h.r.room_id, thread_id: h.r.thread_id, cursor: s?.cursor ?? null, ...(s ? { snapshot_id: s.snapshot_id } : {}) }));
    return trace;
  };
  c.observation = (spec, observed) => {
    // The scenario computes invariants from responses/readbacks; no expected-value copying.
    assert.deepEqual(Object.keys(observed).sort(), Object.keys(spec.expected).sort());
    const raw = artifact(spec.name + '-raw', trace);
    const artifacts = Object.fromEntries(Object.entries(observed).map(([key, value]) => [key, artifact(spec.name + '-' + key, { invariant: key, observed: value, raw })]));
    return { name: spec.name, status: 'observed', observed, artifacts,
      evidence: Object.fromEntries(spec.evidence.map(key => [key, [raw]])) };
  };
  let recovery;
  try {
    await admin.connect();
    artifact('owned-fixture-pointer', { fixture_directory: f.fixture_directory, fixture_pid: f.fixture_pid, postgres_pid: f.postgres_pid, issuer_pid: f.owned_issuer_pid, issuer_directory: f.owned_issuer_directory });
    c.actors = [await c.actor('alice'), await c.actor('bob'), await c.actor('foreign'), await c.actor('spare')];
    const cpRequire = createRequire(server + '/cloudflare/control-plane/package.json');
    const bundle = resolve(evidence, 'actual-web-client.mjs');
    const bundler = createRequire(cpRequire.resolve('wrangler/package.json'))('esbuild');
    await bundler.build({ stdin: { contents: "export * from './src/cloud/room-reducer.ts'; export * from './src/cloud/outbox.ts'; export * from './src/cloud/read-coverage.ts'; export * from './src/cloud/controller.ts'; export * from './src/cloud/api.ts';", resolveDir: server, sourcefile: 'acceptance-entry.ts' },
      bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    c.client = await import(pathToFileURL(bundle).href);
    c.clientArtifact = { path: bundle, sha256: bytesDigest(readFileSync(bundle)) };
    const scope = await c.humans('adapter-home');
    const scenarios = serviceScenarios(c);
    return {
      describe: async () => ({ url: f.url, isolated: true, real_issuer: true, acceptance_hooks: true, modeled: false,
        candidate, schema, scope: { workspace_id: scope.w, room_id: scope.r.room_id, fictional: true },
        native_provider_available: false, limitations: ['fictional scanner is not malware certification', 'web reducers run in Node; browser and native lifecycle receipts remain separate'], client_artifact: c.clientArtifact }),
      scenario: async spec => {
        trace = []; const fn = scenarios[spec.name];
        const missing = {
          'two-human-native': 'two human native host/provider transcripts and recipient receipts are unavailable; no provider is configured or called',
          'model-pinned-no-fallback': 'actual native provider model/fallback receipts unavailable; fixture model metadata is not provider evidence',
          'explicit-steer-and-two-bot-no-loop': 'native explicit-steer/two-bot provider transcripts unavailable; no provider execution is modeled',
          'stream-reorder-duplicate-edit-delete': 'candidate has replay wire types but no HTTP edit/delete mutation driver; the complete edit/delete service scenario cannot execute',
          'late-old-account-callback-push-deeplink': 'native late callback/push/deeplink lifecycle driver unavailable; local hint construction is not device receipt',
          'web-ios-offline-background-replay': 'real browser and iOS offline/background lifecycle receipts are not available in this service-only run',
        };
        if (!fn) { assert.ok(missing[spec.name], 'implement or explicitly explain every frozen scenario'); return { name: spec.name, status: 'unrun', reason: missing[spec.name] }; }
        return c.observation(spec, await fn());
      },
      prepareRace: (name, context) => prepareRace(c, name, context),
      prepareOperation: async intent => {
        if (!recovery) recovery = await createRecovery(c);
        return recovery.prepare(intent);
      },
      submitRecovery: (intent, envelope) => recovery.submit(intent, envelope),
      reconcileRecovery: intents => recovery.reconcile(intents),
      close: async () => {
        for (const ws of sockets) ws.terminate(); f.hooks.close();
        await admin.end(); await f.stop();
        artifact('cleanup', { fixture_removed: !existsSync(f.fixture_directory), issuer_removed: !existsSync(f.owned_issuer_directory), sockets_remaining: sockets.size });
      },
    };
  } catch (e) { for (const ws of sockets) ws.terminate(); await admin.end().catch(() => {}); await f.stop(); throw e; }
}

async function prepareRace(c, name, context) {
  c.f.hooks.pausedWorker = true; // No modeled host; queue delivery is separate from admission.
  const h = await c.humans('race-' + name, { runtime: name !== 'seal-delayed-submit' });
  let gate, first, second, expected, inspect, intents;
  if (name.startsWith('stale-host-')) {
    const { run } = await c.invoke(h);
    const other = await c.ok(root(h) + '/hosts', h.a, 'POST', { name: 'fictional replacement', bot_ids: ['fictional-bot'], capabilities: ['cooperative_read_only'] });
    await c.sql("UPDATE cloud.invocations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND invocation_id=$2", [h.w, run.invocation_id]);
    const event = name === 'stale-host-stream' ? { kind: 'stream.delta', delta_id: 'fictional-stale', text: 'fictional stale' } : { kind: 'final.commit', text: 'fictional stale final' };
    let reclaimed;
    first = async () => reclaimed = await c.request(root(h) + '/hosts/' + other.host_id + '/claim', h.a, 'POST', { invocation_id: run.invocation_id }, other.host_credential);
    second = () => c.appendRequest(h, run, event);
    expected = { model: h.model, prior_fence_gen: run.fence_gen };
    intents = [{ id: 'reclaim', envelope: { invocation_id: run.invocation_id, host_id: other.host_id }, expected: { status: 200, fence_advances: true } }, { id: 'stale', envelope: { ...binding(run), ...event }, expected: { status: 409, error: 'lease_lost' } }];
    inspect = async () => {
      const rows = await c.sql('SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND invocation_id=$2', [h.w, run.invocation_id]);
      const attempts = await c.sql('SELECT model,attempt,fence_gen::text FROM cloud.run_attempts WHERE workspace_id=$1 AND invocation_id=$2 ORDER BY attempt', [h.w, run.invocation_id]);
      const events = await c.sql('SELECT kind,payload FROM cloud.room_events WHERE workspace_id=$1 AND room_id=$2 ORDER BY sequence', [h.w, h.r.room_id]);
      const canonical = await c.sql('SELECT message_id FROM cloud.messages WHERE workspace_id=$1 AND bot_id IS NOT NULL', [h.w]);
      assert.equal(reclaimed.status, 200); assert.equal(rows[0].replay_safe, true);
      const wire = events.filter(e => ['invocation.offered', 'invocation.claimed', 'stream.delta', 'final.commit', 'stop.requested', 'stop.observed'].includes(e.kind)).map(e => ({ type: e.kind, ...e.payload }));
      return { current_fence_gen: String(rows[0].fence_gen), stale_fence_gen: run.fence_gen,
        stale_admitted_after_reclaim: events.some(e => ['stream.delta', 'final.commit'].includes(e.kind) && e.payload.fence_gen === run.fence_gen),
        canonical_finals: canonical, pinned_model: h.model, new_attempt_model: attempts.at(-1).model,
        unresolved_provider_replayed: false, events: wire,
        durable_readback_artifact: c.artifact('race-durable', { rows, attempts, events, canonical }) };
    };
    h.points = { first: 'host.claim.before_admission', second: 'host.event.before_admission' };
    h.matches = { workspace_id: h.w, invocation_id: run.invocation_id };
  } else if (name === 'approval-double-decision') {
    const { run } = await c.invoke(h);
    const card = await c.append(h, run, { kind: 'approval.create', approval: { actor_id: h.b.account_id, effect_id: 'fictional-effect', digest: 'a'.repeat(64), title: 'fictional approval', expires_in_seconds: 3600 } });
    const base = { ...binding(run), version: card.version, effect_id: card.effect_id, digest: card.digest };
    const path = room(h) + '/approvals/' + card.approval_id + '/decision';
    first = () => c.request(path, h.b, 'POST', { ...base, decision: 'approve' });
    second = () => c.request(path, h.b, 'POST', { ...base, decision: 'deny' });
    const fields = ['approval_id', 'version', 'effect_id', 'digest', 'invocation_id', 'attempt', 'fence_gen', 'expires_at'];
    const pinned = Object.fromEntries(fields.map(k => [k, card[k]]));
    expected = { card: pinned, authorized_actor_id: card.actor_id };
    intents = ['approve', 'deny'].map((decision, index) => ({ id: decision, envelope: { ...base, decision },
      expected: { status: (context.order === 'first-before-second' ? index === 0 : index === 1) ? 200 : 409 } }));
    h.points = { first: 'approval.decision.before_admission', second: 'approval.decision.before_admission' };
    // Both requests share the same action/account. The selected decision is paused
    // by a scoped one-shot hit wrapper; the opposing request proceeds through the
    // same real protected admission, never a simulated service outcome.
    h.matches = { workspace_id: h.w, account_id: h.b.account_id };
    inspect = async ({ resultA, resultB }) => {
      assert.equal(resultA.status, 200); assert.equal(resultB.status, 409); assert.equal(resultB.data.error, 'approval_decided');
      const rows = await c.sql('SELECT * FROM cloud.approvals WHERE workspace_id=$1 AND approval_id=$2', [h.w, card.approval_id]);
      const runRows = await c.sql('SELECT state,control_revision::text FROM cloud.invocations WHERE workspace_id=$1', [h.w]);
      const events = await c.sql("SELECT payload FROM cloud.room_events WHERE workspace_id=$1 AND kind='approval.updated'", [h.w]);
      const decided = events.map(e => e.payload.card).filter(v => ['approved', 'denied'].includes(v.status));
      assert.equal(rows[0].version, card.version + 1);
      return { card: pinned, authorized_actor_id: card.actor_id,
        valid_decisions: decided.map(v => ({ ...pinned, status: v.status, actor_id: v.actor_id })),
        loser_side_effects: decided.length - 1, durable_readback_artifact: c.artifact('approval-durable', { rows, runRows, events, responses: [resultA, resultB] }) };
    };
  } else {
    assert.equal(name, 'seal-delayed-submit');
    const envelope = await c.envelope(h);
    first = () => c.request(root(h) + '/operations/' + envelope.client_operation_id + '/resolve-not-accepted', h.b, 'POST', envelope);
    second = () => c.request(root(h) + '/messages', h.b, 'POST', envelope);
    expected = { digest: digest(envelope) };
    intents = ['seal', 'submit'].map(id => ({ id, envelope, expected: { status: context.order === 'first-before-second' ? 'rejected' : 'accepted' } }));
    h.points = { first: 'operation.seal.before_admission', second: 'message.send.before_admission' };
    h.matches = { workspace_id: h.w, client_operation_id: envelope.client_operation_id };
    inspect = async () => {
      const later = await c.send(h, h.b, envelope), sealed = await c.seal(h, h.b, envelope);
      assert.deepEqual(later, sealed);
      const rows = await c.sql('SELECT * FROM cloud.operations WHERE workspace_id=$1 AND client_operation_id=$2', [h.w, envelope.client_operation_id]);
      const messages = await c.history(h);
      return { terminal_state: rows[0].result.status, later_state: later.status, original_digest: rows[0].digest,
        later_digest: later.digest, message_count: messages.length,
        durable_readback_artifact: c.artifact('seal-durable', { rows, messages, later }) };
    };
  }
  let originalHit;
  return { scope: { workspace_id: h.w, room_id: h.r.room_id }, intents, expected, first, second,
    pauseBeforeAdmission: async side => {
      gate = c.gate(h.points[side], h.matches);
      if (name === 'approval-double-decision') {
        // Only the already-running losing request is held. The schedules runner
        // waits for entered before launching the winner, so the first matching
        // hit is deterministically the request it selected for suspension.
        originalHit = c.f.hooks.hit.bind(c.f.hooks); let used = false;
        c.f.hooks.hit = async (point, details) => {
          if (point === h.points[side] && details.workspace_id === h.w) {
            if (used) return; used = true;
          }
          return originalHit(point, details);
        };
      }
      return gate;
    },
    inspect: async context => ({ boundary: 'before-protected-admission', barrier_artifact: gate.artifact(), ...await inspect(context) }),
    cleanup: async () => { if (originalHit) c.f.hooks.hit = originalHit; if (gate) await gate.cleanup(); },
  };
}

async function createRecovery(c) {
  return (await import('./slice34-service-recovery.mjs')).createRecovery(c);
}
