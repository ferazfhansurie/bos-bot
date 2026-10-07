import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { digest, freezeManifest, Oracle } from './oracle.mjs';
import { Transport, redact } from './transport.mjs';
import { corpus, PROTOCOL_COMMIT, frozenOperation, operationEnvelope,
  validateOutcome, recipientMessages, CloudDriver } from './protocol.mjs';

for (const [index, vector] of corpus.digest_vectors.entries()) {
  test(`independent digest vector ${index + 1}`, () => assert.equal(digest(vector.envelope), vector.sha256));
}
const envelope = corpus.digest_vectors[0].envelope;
const intent = { ...frozenOperation(envelope), envelope_digest: digest(envelope) };
const accepted = { status: 'accepted', client_operation_id: intent.id, digest: intent.envelope_digest,
  message_id: 'fictional_m1', room_id: envelope.room_id, thread_id: envelope.thread_id,
  sequence: '9007199254740993', redacted: false, retry: 'none' };

test('frozen wire envelope preserves exact UTF-16 text and metadata', () => {
  const built = operationEnvelope({ window: { namespace: envelope.namespace, window_id: 'window1',
    window_token: envelope.window_token }, room: { room_id: envelope.room_id, thread_id: envelope.thread_id,
    policy_revision: envelope.expected_policy_revision }, text: envelope.text,
    nonce: 'abcdefghijklmnop', mentions: envelope.mentions });
  assert.deepEqual(built, envelope);
  assert.throws(() => operationEnvelope({ window: {}, room: {}, text: 'x' }), /nonce/);
});

test('receipt validation rejects wrong digest, operation, scope and invalid sequence', () => {
  assert.equal(validateOutcome(intent, accepted).sequence, '9007199254740993');
  for (const changed of [{ digest: '0'.repeat(64) }, { client_operation_id: 'other' },
    { room_id: 'other' }, { thread_id: 'other' }, { sequence: '01' }]) {
    assert.throws(() => validateOutcome(intent, { ...accepted, ...changed }));
  }
});

test('recipient identity and sequence must match the independent receipt', () => {
  const oracle = { receipts: new Map([[intent.id, { state: 'accepted', reference: accepted }]]) };
  const message = { ...intent.expected.message, client_operation_id: intent.id,
    message_id: accepted.message_id, sequence: accepted.sequence, created_at: '2026-10-07T00:00:00Z' };
  assert.equal(recipientMessages([message], oracle)[0].operation_id, intent.id);
  assert.throws(() => recipientMessages([{ ...message, sequence: '2' }], oracle), /sequence/);
  assert.throws(() => recipientMessages([{ ...message, message_id: 'other' }], oracle), /message ID/);
});

test('wire credentials are redacted recursively without rewriting text', () => {
  assert.deepEqual(redact({ window_token: 'secret', token: 'secret', nested: { bearer: 'secret' }, text: 'window_token literal' }),
    { window_token: '[redacted]', token: '[redacted]', nested: { bearer: '[redacted]' }, text: 'window_token literal' });
});

test('HTTP driver keeps lost responses unresolved, uses frozen key for lookup and refuses mismatched receipts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'check-cloud-binding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'intent.json');
  freezeManifest(path, { candidate: 'self-test-only', protocol: PROTOCOL_COMMIT, scope: 'fictional', operations: [frozenOperation(envelope)] });
  const oracle = new Oracle(path, join(dir, 'journal.jsonl'));
  const requests = [];
  let receipt = accepted;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(receipt));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const records = [];
  const driver = new CloudDriver(new Transport(`http://127.0.0.1:${server.address().port}`, x => records.push(x)), 'fictional-secret', oracle);
  await driver.operation(intent.id, { discardResponse: true });
  assert.throws(() => oracle.assertResolved(), /unresolved/);
  assert.deepEqual(requests[0].body, envelope);
  assert.equal(records[0].body.window_token, '[redacted]');
  assert.ok(!JSON.stringify(records).includes('fixture.signature'));
  await driver.operation(intent.id, { mode: 'lookup' });
  oracle.assertResolved();
  assert.deepEqual(requests[1], { method: 'GET', url: `/v2/workspaces/w1/operations/${intent.id}`, body: null });
  receipt = { ...accepted, digest: '0'.repeat(64) };
  await assert.rejects(driver.operation(intent.id, { mode: 'lookup' }), /digest/);
  assert.equal(requests.length, 3, 'no implicit retries');
});
