import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { root } from './slice34-service-adapter.mjs';

export async function identityStallGate(c) {
  const h = await c.humans('identity-stall');
  const snapshot = await c.snapshot(h);
  const sockets = await Promise.all(Array.from({ length: 20 }, () => c.socket(h.b)));
  try {
    for (const socket of sockets) socket.subscribe(h, snapshot);
    await c.until(() => sockets.every(s => s.frames.some(f => f.type === 'event_batch' && f.live)), '20 subscribed streams', 20000);
    const envelope = await c.envelope(h, h.a, { text: 'fictional stall sentinel' });
    const stalledEnvelope = await c.envelope(h, h.b, { text: 'fictional denied during stall' });
    const offsets = sockets.map(s => s.frames.length);
    const started = Date.now();
    c.f.issuer_fault.stall_bearer = h.b.bearer;
    c.f.issuer_fault.stall_ms = 15000;
    c.log({ type: 'identity_stall_start', sockets: sockets.length, stall_ms: 15000 });
    const denied = c.request(root(h) + '/messages', h.b, 'POST', stalledEnvelope);
    const committed = await c.send(h, h.a, envelope);
    assert.equal(committed.status, 'accepted');
    const response = await denied;
    assert.equal(response.status, 503); assert.equal(response.data.error, 'identity_unavailable');
    await c.until(() => sockets.every(s => s.code !== null), 'all 20 sockets fail closed', 10000);
    await c.pause(Math.max(0, started + 16000 - Date.now()));
    const frames = sockets.flatMap((s, index) => s.frames.slice(offsets[index]));
    const publications = sockets.flatMap(s => s.timed_frames).filter(({frame, received_at}) =>
      received_at >= started + 15000 && ['event_batch', 'reset'].includes(frame.type));
    assert.equal(publications.length, 0, 'stalled issuer cannot publish protected room data');
    assert.equal(frames.filter(f => f.type === 'event_batch' && f.events.some(e => e.payload.message?.message_id === committed.message_id)).length, 0, 'stall sentinel must not be published');
    assert.ok(sockets.every(s => s.code === 1008 && s.frames.some(f => f.type === 'error' && f.error === 'identity_unavailable')));
    c.log({ type: 'identity_stall_receipt', elapsed_ms: Date.now() - started,
      concurrent_sockets: sockets.length, closed_codes: sockets.map(s => s.code),
      protected_publications: publications.length, denial: response.data, accepted_sentinel: committed.message_id });
    c.f.issuer_fault.stall_ms = 0; c.f.issuer_fault.stall_bearer = null;
    const recovered = await c.socket(h.b); recovered.subscribe(h, snapshot);
    await c.until(() => recovered.frames.some(f => f.type === 'event_batch' && f.events.some(e => e.payload.message?.message_id === committed.message_id)), 'same bearer reconnect catches up');
    recovered.ws.terminate();
    const durable = await c.sql('SELECT message_id,client_operation_id FROM cloud.messages WHERE workspace_id=$1', [h.w]);
    assert.equal(durable.filter(m => m.client_operation_id === stalledEnvelope.client_operation_id).length, 0);

    // Exercise the production native coordinator against the real issuer. The
    // proxy lets validation finish upstream, then drops its response once.
    const actor = c.actors[3];
    const configPath = c.evidence + '/native-identity-config.private.json';
    const receiptPath = c.evidence + '/native-identity-receipt.json';
    const { bearer, email, ...identity } = actor;
    writeFileSync(configPath, JSON.stringify({ issuer: c.f.issuer_url, rooms: c.f.url, bearer, identity, receipt: receiptPath }), { flag: 'wx', mode: 0o600 });
    c.f.issuer_fault.drop_me_response_bearer = bearer;
    let output = '';
    try {
      const child = spawn('/usr/bin/swift', ['test', '--package-path', c.server + '/ios', '--skip-build', '--filter', 'CloudIdentityLiveGateTests'], {
        env: { ...process.env, CLOUD_IDENTITY_GATE_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
      let code;
      try { code = await new Promise((r, j) => { child.once('error', j); child.once('exit', r); }); }
      finally { clearTimeout(timer); }
      c.log({ type: 'native_identity_test', exit_code: code, output });
      assert.equal(code, 0, 'native identity driver failed');
      assert.match(output, /Executed 1 test/);
      assert.equal(c.f.issuer_fault.drop_me_response_bearer, null, 'issuer proxy must actually drop the native response');
      const native = JSON.parse(readFileSync(receiptPath, 'utf8'));
      for (const key of ['native_coordinator', 'response_loss_unavailable', 'stored_bearer_retained', 'retry_signed_in', 'retry_same_bearer']) assert.equal(native[key], true, key);
      const source = readFileSync(c.server + '/ios/Sources/CompanionCore/Cloud/CloudIdentity.swift');
      c.log({ type: 'native_identity_receipt', ...native, coordinator_sha256: createHash('sha256').update(source).digest('hex') });
      return { protected_publications_after_15s: publications.length,
        renewed_bearer_changed_on_response_loss: !native.retry_same_bearer };
    } finally { rmSync(configPath, { force: true }); c.f.issuer_fault.drop_me_response_bearer = null; }
  } finally {
    c.f.issuer_fault.stall_ms = 0; c.f.issuer_fault.stall_bearer = null;
    for (const socket of sockets) socket.ws.terminate();
  }
}
