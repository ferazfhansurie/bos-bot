import assert from 'node:assert/strict';
import {
  IdSchema, HostRegistrationSchema, HostCredentialSchema, BotRegistrationSchema,
  HostClaimSchema, HostHeartbeatSchema, HostAppendSchema, RunBindingSchema,
  RunControlSchema, ApprovalDecisionSchema, ApprovalCardSchema, AttachmentPrepareSchema,
  AttachmentSchema, AttachmentUploadSchema, InvocationSchema, ContextSchema,
} from '../../../shared/cloud-protocol/index.ts';
import { ErrorSchema } from '../../../shared/cloud-protocol/index.ts';

export const SCHEMA_COMMIT = '261f3ece439af540056b9734824b949a58e7851b';
// Frozen independently from the server implementation, against the schema README.
export const BINDING = Object.freeze({
  schema: SCHEMA_COMMIT,
  host_header: 'X-Cloud-Host-Credential',
  wire: ['invocation.offered', 'invocation.claimed', 'stream.delta', 'final.commit', 'stop.requested', 'stop.observed'],
  run_fields: ['invocation_id', 'attempt', 'fence_gen'],
  approval_fields: ['approval_id', 'invocation_id', 'attempt', 'fence_gen', 'version', 'effect_id', 'digest', 'expires_at'],
  decisions: ['approve', 'deny'], approval_statuses: ['pending', 'approved', 'denied', 'expired', 'revoked'],
  attachment_namespace: ['workspace_id', 'room_id', 'attachment_id'],
  attachment_limits: { bytes: 10485760, uploadSeconds: 300, orphanSeconds: 86400, messageCount: 32,
    types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'], multipart: false },
});
const w = s => `/v2/workspaces/${IdSchema.parse(s.workspace_id)}`;
const h = s => `${w(s)}/hosts/${IdSchema.parse(s.host_id)}`;
const r = s => `${w(s)}/rooms/${IdSchema.parse(s.room_id)}`;
const a = s => `${w(s)}/attachments/${IdSchema.parse(s.attachment_id)}`;
const card = s => `${r(s)}/approvals/${IdSchema.parse(s.approval_id)}`;
const invocation = s => `${r(s)}/invocations/${IdSchema.parse(s.invocation_id)}`;
export const ROUTES = Object.freeze({
  botRegister: ['POST', s => `${w(s)}/bots`, BotRegistrationSchema, null, false],
  hostRegister: ['POST', s => `${w(s)}/hosts`, HostRegistrationSchema, HostCredentialSchema, false],
  hostInvocations: ['GET', s => `${h(s)}/invocations`, null, null, true],
  hostClaim: ['POST', s => `${h(s)}/claim`, HostClaimSchema, InvocationSchema, true],
  hostHeartbeat: ['POST', s => `${h(s)}/heartbeat`, HostHeartbeatSchema, InvocationSchema, true],
  hostEvents: ['POST', s => `${h(s)}/events`, HostAppendSchema, null, true],
  hostContext: ['POST', s => `${h(s)}/context`, RunBindingSchema, ContextSchema, true],
  hostRevoke: ['DELETE', h, null, null, false],
  stop: ['POST', s => `${invocation(s)}/stop`, RunControlSchema, InvocationSchema, false],
  resume: ['POST', s => `${invocation(s)}/resume`, RunControlSchema, InvocationSchema, false],
  approvalView: ['GET', card, null, ApprovalCardSchema, false],
  approvalDecision: ['POST', s => `${card(s)}/decision`, ApprovalDecisionSchema, ApprovalCardSchema, false],
  attachmentPrepare: ['POST', s => `${w(s)}/attachments`, AttachmentPrepareSchema, AttachmentUploadSchema, false],
  attachmentComplete: ['POST', s => `${a(s)}/complete`, null, AttachmentSchema, false],
  attachmentView: ['GET', a, null, AttachmentSchema, false],
  attachmentDownload: ['GET', s => `${a(s)}/download`, null, null, false],
});
export function requestBinding(name, scope, body) {
  const row = ROUTES[name]; assert.ok(row, 'unknown frozen route');
  const [method, path, schema, , host] = row;
  if (name === 'attachmentComplete') assert.deepEqual(body, {});
  else if (!schema) assert.equal(body, undefined, 'route has no request body');
  return { method, path: path(scope), host, ...(body === undefined ? {} : { body: schema ? schema.parse(body) : body }) };
}
export class Slice34Driver {
  constructor(transport, bearer, hostCredential) { Object.assign(this, { transport, bearer, hostCredential }); }
  async json(name, scope, body) {
    assert.notEqual(name, 'attachmentDownload', 'download requires authenticated raw/range adapter');
    const request = requestBinding(name, scope, body);
    if (request.host) assert.ok(this.hostCredential, 'scoped host credential required');
    const response = await this.transport.request(request.path, { method: request.method, body: request.body,
      token: this.bearer, ...(request.host ? { hostCredential: this.hostCredential } : {}) });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}: ${ErrorSchema.parse(response.data).error}`);
    const schema = ROUTES[name][3];
    if (schema) return schema.parse(response.data);
    if (name === 'hostInvocations') {
      assert.ok(Array.isArray(response.data.invocations) && response.data.invocations.length <= 100);
      return { invocations: response.data.invocations.map(i => InvocationSchema.parse(i)) };
    }
    if (name === 'hostEvents') return body.kind === 'approval.create'
      ? ApprovalCardSchema.parse(response.data) : InvocationSchema.parse(response.data);
    if (name === 'botRegister') { IdSchema.parse(response.data.bot_id); return response.data; }
    if (name === 'hostRevoke') { assert.equal(response.data.revoked, true); return response.data; }
    assert.fail('unbound JSON response');
  }
}
