import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Contract schemas only. Expected hashes and outcomes never import SUT algorithms.
import { SendEnvelopeSchema, LookupSchema, MessageSchema, SnapshotSchema,
  FrameSchema, ErrorSchema } from '../../../shared/cloud-protocol/index.ts';

export const PROTOCOL_COMMIT = 'ffd3a022d56485a11363a49c2e070d6cb075bbb8';
export const corpus = JSON.parse(readFileSync(new URL('../../../shared/cloud-protocol/fixtures.json', import.meta.url), 'utf8'));

export function operationEnvelope({ window, room, text, nonce, mentions = [], reply = null }) {
  assert.ok(nonce, 'independently chosen nonce required');
  return SendEnvelopeSchema.parse({ kind: 'message.send', namespace: window.namespace,
    client_operation_id: `${window.window_id}.${nonce}`, window_token: window.window_token,
    room_id: room.room_id, thread_id: room.thread_id, text, mentions, attachment_ids: [],
    reply_to_message_id: reply, expected_policy_revision: room.policy_revision });
}

export function frozenOperation(envelope) {
  SendEnvelopeSchema.parse(envelope);
  return { id: envelope.client_operation_id, envelope,
    expected: { state: 'accepted', message: {
      workspace_id: envelope.namespace.workspace_id, room_id: envelope.room_id,
      thread_id: envelope.thread_id, actor_id: envelope.namespace.account_id,
      text: envelope.text, mentions: envelope.mentions,
      reply_to_message_id: envelope.reply_to_message_id, deleted: false, version: 1,
    } } };
}

export function validateOutcome(intent, result) {
  const parsed = LookupSchema.parse(result);
  assert.equal(parsed.client_operation_id, intent.id, 'wrong operation receipt');
  if (parsed.status === 'accepted' || parsed.status === 'rejected') {
    assert.equal(parsed.digest, intent.envelope_digest, 'receipt digest differs from independent intent');
  }
  if (parsed.status === 'accepted') {
    assert.equal(parsed.room_id, intent.envelope.room_id, 'wrong receipt room');
    assert.equal(parsed.thread_id, intent.envelope.thread_id, 'wrong receipt thread');
  }
  return parsed;
}

export function recipientMessages(messages, oracle) {
  return messages.map(input => {
    const message = MessageSchema.parse(input);
    const receipt = oracle.receipts.get(message.client_operation_id);
    assert.equal(receipt?.state, 'accepted', 'message has no accepted independent operation');
    assert.equal(message.message_id, receipt.reference.message_id, 'canonical message ID differs from receipt');
    assert.equal(message.sequence, receipt.reference.sequence, 'canonical sequence differs from receipt');
    return { ...message, operation_id: message.client_operation_id };
  });
}

export class CloudDriver {
  constructor(transport, token, oracle) { Object.assign(this, { transport, token, oracle }); }
  async json(path, { method = 'GET', body } = {}) {
    const response = await this.transport.request(path, { method, body, token: this.token });
    if (response.status < 200 || response.status >= 300) {
      const error = ErrorSchema.parse(response.data);
      throw new Error(`HTTP ${response.status}: ${error.error}`);
    }
    return response.data;
  }
  async operation(id, { mode = 'submit', discardResponse = false } = {}) {
    assert.ok(['submit', 'lookup', 'seal'].includes(mode), 'explicit operation mode required');
    const intent = this.oracle.intents.get(id);
    assert.ok(intent, 'operation absent from frozen manifest');
    const w = encodeURIComponent(intent.envelope.namespace.workspace_id);
    const key = encodeURIComponent(id);
    const path = `/v2/workspaces/${w}/${mode === 'submit' ? 'messages' : `operations/${key}${mode === 'seal' ? '/resolve-not-accepted' : ''}`}`;
    if (mode !== 'lookup') this.oracle.submitted(id, intent.envelope);
    const response = await this.transport.request(path, { token: this.token,
      method: mode === 'lookup' ? 'GET' : 'POST',
      ...(mode === 'lookup' ? {} : { body: intent.envelope }), discardResponse });
    if (response.status === 'transport_unknown') {
      this.oracle.record({ type: 'operation_transport_unknown', id, mode });
      return response;
    }
    // A HTTP error is not a terminal rejected operation receipt.
    if (response.status < 200 || response.status >= 300) {
      const error = ErrorSchema.parse(response.data);
      this.oracle.record({ type: 'operation_http_error', id, mode, error: error.error });
      return { http_status: response.status, error: error.error };
    }
    const result = validateOutcome(intent, response.data);
    this.oracle.outcome(id, result.status, ['accepted', 'rejected'].includes(result.status) ? result : null);
    return result;
  }
  async snapshot(scope) {
    const snapshot = SnapshotSchema.parse(await this.json(
      `/v2/workspaces/${scope.workspace_id}/rooms/${scope.room_id}/snapshot`,
      { method: 'POST', body: { thread_id: scope.thread_id } }));
    for (const key of ['workspace_id', 'room_id', 'thread_id']) assert.equal(snapshot[key], scope[key], `snapshot ${key}`);
    return snapshot;
  }
  async replay(scope, { cursor, snapshot_id } = {}) {
    const frame = FrameSchema.parse(await this.json(
      `/v2/workspaces/${scope.workspace_id}/rooms/${scope.room_id}/replay`,
      { method: 'POST', body: { thread_id: scope.thread_id, cursor, ...(snapshot_id ? { snapshot_id } : {}) } }));
    assert.ok(frame.type === 'event_batch' || frame.type === 'reset_required', 'unexpected replay response');
    for (const key of ['workspace_id', 'room_id']) assert.equal(frame[key], scope[key], `replay ${key}`);
    return frame;
  }
}
