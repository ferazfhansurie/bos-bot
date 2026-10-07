import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { BINDING, ROUTES, requestBinding, Slice34Driver, SCHEMA_COMMIT } from './slice34-binding.mjs';
import { WIRE } from './slice34-plan.mjs';
import { Transport, redact } from './transport.mjs';
import { InvocationWireEventSchema, ATTACHMENT_LIMITS, ApprovalDecisionSchema } from '../../../shared/cloud-protocol/index.ts';

const scope = { workspace_id: 'w', room_id: 'r', host_id: 'h', invocation_id: 'i', approval_id: 'c', attachment_id: 'a' };
const run = { invocation_id: 'i', attempt: 1, fence_gen: '9007199254740993' };
const decision = { ...run, version: 1, effect_id: 'e', digest: 'a'.repeat(64), decision: 'deny' };
test('frozen binding matches schema wire, decisions and attachment limits', () => {
  assert.match(SCHEMA_COMMIT, /^[a-f0-9]{40}$/);
  assert.deepEqual(WIRE, BINDING.wire);
  assert.deepEqual(ATTACHMENT_LIMITS, Object.fromEntries(Object.entries(BINDING.attachment_limits).filter(([k]) => k !== 'messageCount')));
  InvocationWireEventSchema.parse({ ...run, kind: 'invocation.claimed', host_id: 'h',
    model: { provider: 'fictional', model: 'fixture-model', config_revision: '1' }, lease_expires_at: '2026-10-07T16:00:00Z' });
  assert.equal(InvocationWireEventSchema.safeParse({ ...run, kind: 'claimed' }).success, false);
  for (const d of BINDING.decisions) ApprovalDecisionSchema.parse({ ...decision, decision: d });
  assert.equal(ApprovalDecisionSchema.safeParse({ ...decision, decision: 'reject' }).success, false);
});
test('routes use pinned workspace/host/room namespace and reject path injection', () => {
  const paths = {
    botRegister: 'bots', hostRegister: 'hosts', hostInvocations: 'hosts/h/invocations',
    hostClaim: 'hosts/h/claim', hostHeartbeat: 'hosts/h/heartbeat', hostEvents: 'hosts/h/events',
    hostContext: 'hosts/h/context', hostRevoke: 'hosts/h', stop: 'rooms/r/invocations/i/stop',
    resume: 'rooms/r/invocations/i/resume', approvalView: 'rooms/r/approvals/c',
    approvalDecision: 'rooms/r/approvals/c/decision', attachmentPrepare: 'attachments',
    attachmentComplete: 'attachments/a/complete', attachmentView: 'attachments/a', attachmentDownload: 'attachments/a/download',
  };
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(ROUTES).sort());
  for (const [name, path] of Object.entries(paths)) {
    assert.equal(ROUTES[name][1](scope), `/v2/workspaces/w/${path}`);
    assert.throws(() => ROUTES[name][1]({ ...scope, workspace_id: '../other' }));
  }
  assert.throws(() => requestBinding('approvalDecision', { ...scope, approval_id: '../a' }, decision));
  assert.throws(() => requestBinding('approvalDecision', scope, { ...decision, actor_id: 'forged' }));
  assert.throws(() => requestBinding('hostHeartbeat', scope, { ...run, fence_gen: 9007199254740993 }));
  assert.throws(() => requestBinding('attachmentComplete', scope, { object_key: 'foreign' }));
  assert.equal(requestBinding('approvalDecision', scope, decision).body.decision, 'deny');
});
test('driver delivers scoped host credential only to host routes and redacts returned credentials', async t => {
  const requests = [], records = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/invocations')) res.end(JSON.stringify({ invocations: [] }));
    else if (req.url.endsWith('/hosts')) res.end(JSON.stringify({ host_id: 'h', workspace_id: 'w',
      host_credential: 'fixture-host-secret', expires_at: 'fixture-expiry', lease_seconds: 30, heartbeat_seconds: 10 }));
    else res.end(JSON.stringify({ error: 'approval_decided' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = new Transport(`http://127.0.0.1:${server.address().port}`, r => records.push(r));
  const driver = new Slice34Driver(transport, 'fixture-bearer', 'fixture-host-secret');
  await driver.json('hostInvocations', scope);
  await driver.json('hostRegister', scope, { name: 'fixture', bot_ids: ['b'], capabilities: ['cooperative_read_only'] });
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-bearer');
  assert.equal(requests[0].headers['x-cloud-host-credential'], 'fixture-host-secret');
  assert.equal(requests[1].headers['x-cloud-host-credential'], undefined);
  assert.ok(!JSON.stringify(records).includes('fixture-host-secret'));
  assert.deepEqual(redact({ 'X-Cloud-Host-Credential': 'fixture-host-secret' }), { 'X-Cloud-Host-Credential': '[redacted]' });
  await assert.rejects(new Slice34Driver(transport, 'fixture-bearer').json('hostInvocations', scope), /scoped host/);
  assert.equal(requests.length, 2, 'credential failure never dispatches');
  await assert.rejects(driver.json('attachmentDownload', scope), /raw\/range adapter/);
});
