import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import { fixture } from '../fixture.ts';
import { CloudService } from '../service.ts';
import { Database } from '../db.ts';
import { InvocationSchema, ContextSchema, SnapshotSchema, canonicalJson, AttachmentSchema, ApprovalCardSchema } from '../../../shared/cloud-protocol/index.ts';
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { f = await fixture(false); });
after(async () => { if (f)
    await f.stop(); });
let seq = 0;
async function call(method: string, path: string, token?: string, body?: any, host?: string) { const r = await fetch(f.url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(host ? { 'x-cloud-host-credential': host } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; }
async function ok(method: string, path: string, token?: string, body?: any, host?: string) { const r = await call(method, path, token, body, host); assert.equal(r.status, 200, JSON.stringify(r)); return r.body; }
async function setup() {
    const a = await ok('POST', '/v2/test/sign-in', undefined, { subject: 'fictional_host_' + ++seq }), b = await ok('POST', '/v2/test/sign-in', undefined, { subject: 'fictional_guest_' + seq });
    const w = (await ok('POST', '/v2/workspaces', a.bearer, { name: 'fictional' })).workspace_id;
    const r = await ok('POST', `/v2/workspaces/${w}/rooms`, a.bearer, { name: 'fictional' });
    const invite = await ok('POST', `/v2/workspaces/${w}/invites`, a.bearer, { role: 'guest', room_ids: [r.room_id] });
    await ok('POST', '/v2/invites/redeem', b.bearer, { token: invite.token });
    const model = { provider: 'fixture', model: 'fictional-pinned-model', config_revision: '1' };
    await ok('POST', `/v2/workspaces/${w}/bots`, a.bearer, { bot_id: 'bot', name: 'fictional', room_ids: [r.room_id], model });
    const host = await ok('POST', `/v2/workspaces/${w}/hosts`, a.bearer, { name: 'fictional host', bot_ids: ['bot'], capabilities: ['cooperative_read_only'] });
    return { a, b, w, r, host, model };
}
async function env(h: any, actor = h.b, attachments: string[] = [], bot = true) { const win = await ok('POST', `/v2/workspaces/${h.w}/operation-windows`, actor.bearer, {}), snap = await ok('POST', `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`, actor.bearer, { thread_id: h.r.thread_id }); return { kind: 'message.send', namespace: win.namespace, window_token: win.window_token, client_operation_id: win.window_id + '.' + randomBytes(16).toString('hex'), room_id: h.r.room_id, thread_id: h.r.thread_id, text: '@bot fictional 🦊', mentions: bot ? [{ kind: 'bot', id: 'bot', start: 0, end: 4 }] : [], attachment_ids: attachments, reply_to_message_id: null, expected_policy_revision: snap.policy_revision }; }
async function invoke(h: any) { const e = await env(h); const sent = await ok('POST', `/v2/workspaces/${h.w}/messages`, h.b.bearer, e); assert.equal(sent.status, 'accepted'); const offered = await ok('GET', `/v2/workspaces/${h.w}/hosts/${h.host.host_id}/invocations`, h.a.bearer, undefined, h.host.host_credential); const v = offered.invocations.find((v: any) => v.source.message_id === sent.message_id); assert(v); const run = await ok('POST', `/v2/workspaces/${h.w}/hosts/${h.host.host_id}/claim`, h.a.bearer, { invocation_id: v.invocation_id }, h.host.host_credential); return { e, sent, run }; }
const binding = (run: any) => ({ invocation_id: run.invocation_id, attempt: run.attempt, fence_gen: run.fence_gen });
const append = (h: any, run: any, body: any) => ok('POST', `/v2/workspaces/${h.w}/hosts/${h.host.host_id}/events`, h.a.bearer, { ...binding(run), ...body }, h.host.host_credential);
async function admin(query: string, values: any[] = []) { const q = new pg.Client({ connectionString: f.migration_url }); await q.connect(); try {
    return await q.query(query, values);
}
finally {
    await q.end();
} }
const err = (code: string) => (e: any) => e.code === code;
async function entered(g: string) { for (let i = 0; i < 100; i++) {
    if (f.hooks.state().find(v => v.id === g)?.entered)
        return;
    await new Promise(r => setTimeout(r, 5));
} throw new Error('gate not entered'); }
test('typed source/model are pinned, provisional events stay out of history and final retry is one result after server restart', async () => {
    const h = await setup(), { run, e } = await invoke(h);
    InvocationSchema.parse(run);
    assert.deepEqual(run.model, h.model);
    const { digest, ...source } = run.source;
    assert.equal(digest, createHash('sha256').update(canonicalJson(source)).digest('hex'));
    const context = await ok('POST', `/v2/workspaces/${h.w}/hosts/${h.host.host_id}/context`, h.a.bearer, binding(run), h.host.host_credential);
    ContextSchema.parse(context);
    assert.equal(context.source.text, e.text);
    assert(context.messages.every((m: any) => m.trust === 'untrusted'));
    const d = { kind: 'stream.delta', delta_id: 'delta', text: 'provisional' };
    await append(h, run, d);
    await append(h, run, d);
    let hist = await ok('GET', `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/history?thread_id=${h.r.thread_id}`, h.b.bearer);
    assert.equal(hist.messages.length, 1);
    const final = await append(h, run, { kind: 'final.commit', text: 'fictional final' });
    assert.equal(final.state, 'completed');
    await append(h, run, { kind: 'final.commit', text: 'fictional final' });
    const fresh = new CloudService(new Database(f.database_url), f.issuer, f.url, randomBytes(32));
    try {
        await fresh.runtime.append(h.a.bearer, h.w, h.host.host_id, h.host.host_credential, { ...binding(run), kind: 'final.commit', text: 'fictional final' });
    }
    finally {
        await fresh.db.close();
    }
    hist = await ok('GET', `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/history?thread_id=${h.r.thread_id}`, h.b.bearer);
    assert.equal(hist.messages.length, 2);
    assert.equal(hist.messages[1].bot_id, 'bot');
    assert.equal(hist.messages[1].text, 'fictional final');
    await assert.rejects(f.service.runtime.append(h.a.bearer, h.w, h.host.host_id, h.host.host_credential, { ...binding(run), kind: 'final.commit', text: 'changed' }), err('operation_conflict'));
    const counts = await admin("SELECT (SELECT count(*) FROM cloud.run_events WHERE workspace_id=$1 AND event_key='delta.delta') AS deltas,(SELECT count(*) FROM cloud.invocations WHERE workspace_id=$1 AND result_message_id IS NOT NULL) AS finals", [h.w]);
    assert.equal(counts.rows[0].deltas, '1');
    assert.equal(counts.rows[0].finals, '1');
});
test('invalid bot/foreign or unready attachment rejects atomically with no invocation', async () => {
    const h = await setup(), e = await env(h);
    e.mentions[0].id = 'ungranted';
    const result = await ok('POST', `/v2/workspaces/${h.w}/messages`, h.b.bearer, e);
    assert.equal(result.reason, 'invalid_mention');
    const next = await env(h, h.b, ['foreign']);
    const rejected = await ok('POST', `/v2/workspaces/${h.w}/messages`, h.b.bearer, next);
    assert.equal(rejected.reason, 'attachment_unready');
    assert.equal((await admin('SELECT * FROM cloud.invocations WHERE workspace_id=$1', [h.w])).rowCount, 0);
});
test('safe pre-provider expiry reclaims with a new generation; stale host cannot append or final', async () => {
    const h = await setup(), { run } = await invoke(h);
    const other = await ok('POST', `/v2/workspaces/${h.w}/hosts`, h.a.bearer, { name: 'other fictional host', bot_ids: ['bot'], capabilities: ['cooperative_read_only'] });
    await admin("UPDATE cloud.invocations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND invocation_id=$2", [h.w, run.invocation_id]);
    const next = await f.service.runtime.claim(h.a.bearer, h.w, other.host_id, other.host_credential, { invocation_id: run.invocation_id });
    assert.equal(next.attempt, 2);
    assert.equal(next.fence_gen, '2');
    for (const body of [{ kind: 'stream.delta', delta_id: 'stale', text: 'stale' }, { kind: 'final.commit', text: 'stale' }])
        await assert.rejects(f.service.runtime.append(h.a.bearer, h.w, h.host.host_id, h.host.host_credential, { ...binding(run), ...body }), err('lease_lost'));
    assert.equal(InvocationSchema.parse(await f.service.runtime.append(h.a.bearer, h.w, other.host_id, other.host_credential, { ...binding(next), kind: 'final.commit', text: 'new final' })).state, 'completed');
});
test('provider checkpoint or mid-stream crash holds uncertainty, lease expiry is not termination', async () => {
    const h = await setup(), { run } = await invoke(h);
    await append(h, run, { kind: 'checkpoint', replay_safe: false });
    await admin("UPDATE cloud.invocations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND invocation_id=$2", [h.w, run.invocation_id]);
    await f.service.runtime.offers(h.a.bearer, h.w, h.host.host_id, h.host.host_credential);
    const snap = await ok('POST', `/v2/workspaces/${h.w}/rooms/${h.r.room_id}/snapshot`, h.b.bearer, { thread_id: h.r.thread_id });
    SnapshotSchema.parse(snap);
    const v = snap.active_runs.find((v: any) => v.invocation_id === run.invocation_id);
    assert.equal(v.state, 'held');
    assert.equal(v.stopped_observed, false);
    await assert.rejects(f.service.runtime.claim(h.a.bearer, h.w, h.host.host_id, h.host.host_credential, { invocation_id: run.invocation_id }), err('lease_lost'));
});
for (const first of ['stop', 'final'])
    test(`stop/final serialize with ${first} first`, async () => {
        const h = await setup(), { run } = await invoke(h), gate = 'stop-final-' + first;
        f.hooks.arm(gate, (first === 'stop' ? 'run.stop' : 'host.event') + '.after_admission', { workspace_id: h.w });
        const stop = () => f.service.runtime.control(h.b.bearer, h.w, h.r.room_id, run.invocation_id, { ...binding(run), control_revision: run.control_revision });
        const final = () => f.service.runtime.append(h.a.bearer, h.w, h.host.host_id, h.host.host_credential, { ...binding(run), kind: 'final.commit', text: 'race final' });
        const winner = first === 'stop' ? stop() : final();
        await entered(gate);
        const loser = first === 'stop' ? final() : stop();
        const settledLoser = loser.then(v => ({ value: v, error: '' }), e => ({ value: null, error: e.code }));
        f.hooks.release(gate);
        const won = InvocationSchema.parse(await winner), other = await settledLoser;
        if (first === 'stop') {
            assert.equal(won.state, 'held');
            assert.equal(won.stopped_observed, false);
            assert.equal(other.error, 'lease_lost');
            const observed = await append(h, won, { kind: 'stop.observed', control_revision: won.control_revision });
            assert.equal(observed.stopped_observed, true);
            assert.equal(observed.state, 'cancelled');
        }
        else {
            assert.equal(won.state, 'completed');
            assert.equal(InvocationSchema.parse(other.value).state, 'completed');
        }
    });
test('approval cards are actor-only, one opposite decision wins, expiry and stop fail closed', async () => {
    const h = await setup(), { run } = await invoke(h);
    const card = await append(h, run, { kind: 'approval.create', approval: { actor_id: h.b.account_id, effect_id: 'effect', digest: 'a'.repeat(64), title: 'fictional gate', expires_in_seconds: 60 } });
    ApprovalCardSchema.parse(card);
    await assert.rejects(f.service.runtime.approval(h.a.bearer, h.w, h.r.room_id, card.approval_id), err('forbidden'));
    const d = { ...binding(run), version: card.version, effect_id: card.effect_id, digest: card.digest };
    const outcomes = await Promise.allSettled(['approve', 'deny'].map(decision => f.service.runtime.approval(h.b.bearer, h.w, h.r.room_id, card.approval_id, { ...d, decision })));
    // A terminal loser is an explicit error response, never a second winning card.
    const cards = outcomes.filter((v: any) => v.status === 'fulfilled' && !v.value.error);
    assert.equal(cards.length, 1);
    assert.equal((await admin('SELECT version FROM cloud.approvals WHERE workspace_id=$1 AND approval_id=$2', [h.w, card.approval_id])).rows[0].version, 2);
    const next = await invoke(h), expired = await append(h, next.run, { kind: 'approval.create', approval: { actor_id: h.b.account_id, effect_id: 'expired', digest: 'b'.repeat(64), title: 'expired', expires_in_seconds: 60 } });
    await admin("UPDATE cloud.approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND approval_id=$2", [h.w, expired.approval_id]);
    const result = await f.service.runtime.approval(h.b.bearer, h.w, h.r.room_id, expired.approval_id, { ...binding(next.run), version: 1, effect_id: 'expired', digest: 'b'.repeat(64), decision: 'approve' });
    assert.deepEqual(result, { error: 'approval_expired' });
});
async function attachment(h: any, bytes: Buffer, actor = h.b, type = 'text/plain') {
    const allocation = await ok('POST', `/v2/workspaces/${h.w}/attachments`, actor.bearer, { room_id: h.r.room_id, thread_id: h.r.thread_id, name: '../fictional.txt', size: bytes.length, type, checksum: createHash('sha256').update(bytes).digest('hex') });
    const upload = await fetch(allocation.upload_url, { method: 'PUT', headers: { authorization: 'Bearer ' + actor.bearer }, body: new Uint8Array(bytes) });
    assert.equal(upload.status, 200);
    const a = await upload.json();
    AttachmentSchema.parse(a);
    assert.equal(a.state, 'uploading');
    return a;
}
test('attachments quarantine until verified, explicit send grants range access, guest revocation blocks bytes and pending bot', async () => {
    const h = await setup(), bytes = Buffer.from('fictional safe attachment'), a = await attachment(h, bytes, h.a);
    await assert.rejects(f.service.attachments.metadata(h.b.bearer, h.w, a.attachment_id), err('forbidden'));
    await assert.rejects(f.service.attachments.download(h.a.bearer, h.w, a.attachment_id, undefined, () => assert.fail('unready download')), err('attachment_unready'));
    assert.equal((await ok('POST', `/v2/workspaces/${h.w}/attachments/${a.attachment_id}/complete`, h.a.bearer, {})).state, 'ready');
    const e = await env(h, h.a, [a.attachment_id], false);
    assert.equal((await ok('POST', `/v2/workspaces/${h.w}/messages`, h.a.bearer, e)).status, 'accepted');
    const download = await fetch(f.url + `/v2/workspaces/${h.w}/attachments/${a.attachment_id}/download`, { headers: { authorization: 'Bearer ' + h.b.bearer, range: 'bytes=0-8' } });
    assert.equal(download.status, 206);
    assert.equal(await download.text(), 'fictional');
    assert.equal((await ok('GET', `/v2/workspaces/${h.w}/attachments/${a.attachment_id}`, h.b.bearer)).state, 'ready');
    await admin("UPDATE cloud.attachment_objects SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND attachment_id=$2", [h.w, a.attachment_id]);
    await f.service.tickWorker();
    assert.equal((await f.service.attachments.metadata(h.b.bearer, h.w, a.attachment_id)).state, 'ready');
    const { run } = await invoke(h);
    await ok('DELETE', `/v2/workspaces/${h.w}/members/${h.b.account_id}`, h.a.bearer);
    const denied = await fetch(f.url + `/v2/workspaces/${h.w}/attachments/${a.attachment_id}/download`, { headers: { authorization: 'Bearer ' + h.b.bearer } });
    assert.equal(denied.status, 403);
    await assert.rejects(f.service.runtime.append(h.a.bearer, h.w, h.host.host_id, h.host.host_credential, { ...binding(run), kind: 'final.commit', text: 'must not publish' }), err('forbidden'));
    assert.equal((await admin('SELECT state FROM cloud.invocations WHERE workspace_id=$1 AND invocation_id=$2', [h.w, run.invocation_id])).rows[0].state, 'held');
});
test('scanner rejection/outage and orphan expiry never expose bytes', async () => {
    const h = await setup(), a = await attachment(h, Buffer.from('EICAR fictional test sentinel'));
    assert.equal((await f.service.attachments.complete(h.b.bearer, h.w, a.attachment_id, {})).state, 'rejected');
    const next = await attachment(h, Buffer.from('fictional outage')), scan = f.service.attachments.store!.scan;
    f.service.attachments.store!.scan = async () => { throw Error('fictional scanner outage'); };
    try {
        await assert.rejects(f.service.attachments.complete(h.b.bearer, h.w, next.attachment_id, {}), err('unavailable'));
    }
    finally {
        f.service.attachments.store!.scan = scan;
    }
    assert.equal((await f.service.attachments.metadata(h.b.bearer, h.w, next.attachment_id)).state, 'verifying');
    await admin("UPDATE cloud.attachment_objects SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1", [h.w]);
    await f.service.tickWorker();
    assert.equal((await f.service.attachments.metadata(h.b.bearer, h.w, next.attachment_id)).state, 'expired');
    await assert.rejects(f.service.attachments.store!.get(next.object_key));
});
test('push builder binds current session/generation, redacts and dedupes committed events only', async () => {
    const h = await setup(), e = await env(h, h.a, [], false);
    await ok('POST', `/v2/workspaces/${h.w}/messages`, h.a.bearer, e);
    const reg = await f.service.push.renew(h.b.bearer, h.w, { installation_id: 'fictional', generation: '1', token_version: '1', provider: 'apns', environment: 'sandbox', muted: false });
    const event = (await admin("SELECT event_id FROM cloud.room_events WHERE workspace_id=$1 AND kind='message.created'", [h.w])).rows[0].event_id;
    const hint = await f.service.push.build(h.b.bearer, h.w, h.r.room_id, reg.registration_id, event);
    assert.equal(hint.payload.preview, 'New activity');
    assert.equal(JSON.stringify(hint).includes('fictional 🦊'), false);
    assert.equal((await f.service.push.build(h.b.bearer, h.w, h.r.room_id, reg.registration_id, event)).duplicate, true);
    const renewed = await f.service.push.renew(h.b.bearer, h.w, { installation_id: 'fictional', generation: '1', token_version: '2', provider: 'apns', environment: 'sandbox', muted: false });
    assert.equal((await f.service.push.build(h.b.bearer, h.w, h.r.room_id, renewed.registration_id, event)).duplicate, true);
    await f.service.push.revoke(h.b.bearer, h.w, reg.registration_id);
    await assert.rejects(f.service.push.build(h.b.bearer, h.w, h.r.room_id, reg.registration_id, event), err('forbidden'));
});
test('runtime RLS denies cross-tenant bot, run, card, attachment and hint reads', async () => {
    const h = await setup(), other = await setup();
    await invoke(other);
    await f.service.db.tx(h.a.account_id, h.w, async (q) => { for (const table of ['bots', 'hosts', 'invocations', 'run_attempts', 'approvals', 'attachment_objects', 'push_hints'])
        assert.equal((await q.query(`SELECT * FROM cloud.${table} WHERE workspace_id=$1`, [other.w])).rowCount, 0); });
});
test('removing the source approval actor holds the run and revokes the card', async () => {
    const h = await setup();
    const { run } = await invoke(h);
    const card = await append(h, run, { kind: 'approval.create', approval: { actor_id: h.b.account_id, effect_id: 'source_actor', digest: 'c'.repeat(64), title: 'fictional source approver', expires_in_seconds: 60 } });
    await ok('DELETE', `/v2/workspaces/${h.w}/members/${h.b.account_id}`, h.a.bearer);
    assert.equal((await admin('SELECT state FROM cloud.invocations WHERE workspace_id=$1 AND invocation_id=$2', [h.w, run.invocation_id])).rows[0].state, 'held');
    assert.equal((await admin('SELECT status FROM cloud.approvals WHERE workspace_id=$1 AND approval_id=$2', [h.w, card.approval_id])).rows[0].status, 'revoked');
});
test('host cannot select another room member or outsider as approval decider', async () => {
    const h = await setup(), {run} = await invoke(h);
    const outsider = await ok('POST', '/v2/test/sign-in', undefined, {subject:'fictional_outsider_'+ ++seq});
    const approval = {actor_id:h.b.account_id,effect_id:'source_only',digest:'d'.repeat(64),title:'fictional source gate',expires_in_seconds:60};
    for(const actor_id of [h.a.account_id,outsider.account_id]) {
        const rejected = await call('POST', `/v2/workspaces/${h.w}/hosts/${h.host.host_id}/events`,h.a.bearer,{...binding(run),kind:'approval.create',approval:{...approval,actor_id}},h.host.host_credential);
        assert.equal(rejected.status,403);
        assert.equal(rejected.body.error,'forbidden');
        assert.equal((await admin('SELECT * FROM cloud.approvals WHERE workspace_id=$1',[h.w])).rowCount,0);
    }
    const card = await append(h,run,{kind:'approval.create',approval});
    assert.equal(card.actor_id,run.source.actor_id);
    assert.equal((await append(h,run,{kind:'approval.create',approval})).approval_id,card.approval_id);
});
test('malformed host payloads fail before mutating the run', async () => {
    const h = await setup(), {run} = await invoke(h);
    for(const event of [{kind:'final.commit'},{kind:'stream.delta',text:'x'},{kind:'approval.create',approval:{junk:true}},{kind:'final.commit',text:'x',approval:{}}]) {
        const rejected = await call('POST', `/v2/workspaces/${h.w}/hosts/${h.host.host_id}/events`,h.a.bearer,{...binding(run),...event},h.host.host_credential);
        assert.equal(rejected.status,400);
        assert.equal(rejected.body.error,'invalid_request');
    }
    assert.equal((await admin('SELECT state FROM cloud.invocations WHERE workspace_id=$1',[h.w])).rows[0].state,'leased');
    assert.equal((await admin('SELECT * FROM cloud.run_events WHERE workspace_id=$1',[h.w])).rowCount,0);
    assert.equal((await admin('SELECT * FROM cloud.approvals WHERE workspace_id=$1',[h.w])).rowCount,0);
});
