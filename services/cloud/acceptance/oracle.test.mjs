import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { canonical, digest, freezeManifest, loadManifest, Oracle } from './oracle.mjs';
import { localURL, redact, Transport } from './transport.mjs';
import { bothOrders, deliverySchedule } from './schedules.mjs';

const envelope = { text: 'cafe\u0301 👩🏽‍💻\n  @fictional', mentions: [], room: 'fictional-room' };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-cloud-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, 'intent.json');
  freezeManifest(manifest, { candidate: 'test-only', protocol: 'unbound', scope: 'fictional',
    operations: [{ id: 'window:one', envelope, expected: { state: 'accepted', message: { text: envelope.text } } },
      { id: 'window:two', envelope: { ...envelope, text: 'rejected' }, expected: { state: 'rejected' } }] });
  return { dir, manifest, oracle: new Oracle(manifest, join(dir, 'observed.jsonl')) };
}
test('intent canonicalization preserves exact text and rejects non-JSON values', () => {
  assert.equal(canonical({ z: 1, a: [false, null] }), '{"a":[false,null],"z":1}');
  assert.notEqual(digest(envelope), digest({ ...envelope, text: envelope.text.normalize('NFC') }));
  assert.throws(() => digest({ missing: undefined }));
  assert.throws(() => digest(NaN));
});
test('frozen manifest cannot be overwritten and alteration is detected', t => {
  const { manifest } = setup(t);
  assert.throws(() => freezeManifest(manifest, { candidate: 'x', protocol: 'x', scope: 'x', operations: [] }), /EEXIST/);
  const data = JSON.parse(readFileSync(manifest));
  data.intents[0].envelope.text = 'server-derived replacement';
  writeFileSync(manifest, JSON.stringify(data));
  assert.throws(() => loadManifest(manifest), /manifest changed/);
});
test('unknown outcomes remain unresolved and never authorize replacing intent', t => {
  const { oracle } = setup(t);
  oracle.submitted('window:one', envelope);
  oracle.outcome('window:one', 'not_found');
  assert.throws(() => oracle.assertResolved(), /unresolved/);
  oracle.outcome('window:one', 'recovery_unknown');
  assert.throws(() => oracle.assertResolved(), /unresolved/);
  assert.throws(() => oracle.submitted('window:one', { ...envelope, text: 'different' }), /changed frozen intent/);
  assert.throws(() => oracle.submitted('replacement', envelope), /absent/);
});
test('terminal receipt and exact recipient projection reject duplicates and missing text', t => {
  const { oracle } = setup(t);
  oracle.outcome('window:one', 'accepted', 'canonical-message-1');
  oracle.outcome('window:two', 'rejected', 'operation_expired');
  const messages = [{ operation_id: 'window:one', text: envelope.text }];
  oracle.verifyMessages(messages);
  oracle.assertResolved();
  assert.throws(() => oracle.verifyMessages([...messages, ...messages]), /exactly once/);
  assert.throws(() => oracle.verifyMessages([]), /exactly once/);
  assert.throws(() => oracle.verifyMessages([{ ...messages[0], text: envelope.text.normalize('NFC') }]), /recipient text/);
  assert.throws(() => oracle.verifyMessages([...messages, { operation_id: 'window:two' }]), /nonaccepted/);
  assert.throws(() => oracle.outcome('window:one', 'rejected'), /terminal outcome changed/);
  assert.throws(() => oracle.outcome('window:one', 'accepted', 'different-message'), /receipt changed/);
});
test('raw journal preserves the independent submitted digest and observation order', t => {
  const { oracle, dir } = setup(t);
  oracle.submitted('window:one', envelope);
  oracle.outcome('window:one', 'accepted', 'm1');
  const events = readFileSync(join(dir, 'observed.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(x => x.type), ['manifest', 'submitted', 'outcome']);
  assert.equal(events[1].envelope_digest, digest(envelope));
});
test('fixture transport rejects nonloopback, credentials, redirects and cross-port routes', async t => {
  for (const url of ['https://127.0.0.1', 'http://localhost:9000', 'http://example.com', 'http://127.0.0.1.example.com', 'http://secret@127.0.0.1']) assert.throws(() => localURL(url));
  assert.equal(localURL('http://127.0.0.1:9999').port, '9999');
  const records = [];
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.com' }); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'accepted', token: 'fictional-secret' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = new Transport(`http://127.0.0.1:${server.address().port}`, x => records.push(x));
  assert.equal((await transport.request('/send', { discardResponse: true })).status, 'transport_unknown');
  assert.equal(records.find(x => x.type === 'http').response.token, '[redacted]');
  await assert.rejects(transport.request('/redirect'));
  await assert.rejects(transport.request('http://127.0.0.1:1/route'), /fixture origin/);
  assert.deepEqual(redact({ nested: { session_token: 'secret' } }), { nested: { session_token: '[redacted]' } });
});
test('race scheduler requires admission hooks and executes both orders 100 times', async () => {
  const records = [];
  const orderLog = [];
  await bothOrders({ name: 'scheduler-self-test', record: x => records.push(x),
    prepare: async () => {
      let heldSide, reach, release;
      const reached = new Promise(resolve => { reach = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      return { pauseBeforeAdmission: async side => { heldSide = side; return { boundary: 'before-protected-admission', waitUntilReached: () => reached, release: async () => release() }; },
        run: async side => { if (heldSide === side) { reach(); await released; } orderLog.push(side); }, cleanup: async () => {} };
    }, first: x => x.run('first'), second: x => x.run('second'),
    inspect: async ({ order }) => assert.deepEqual(orderLog.splice(0), order === 'first-before-second' ? ['first', 'second'] : ['second', 'first']) });
  assert.equal(records.filter(x => x.order === 'first-before-second').length, 100);
  assert.equal(records.filter(x => x.order === 'second-before-first').length, 100);
  await assert.rejects(bothOrders({ repetitions: 99 }), /minimum/);
});
test('delivery schedule enforces the 1000-operation minimum before reconciliation', async () => {
  let dispatched = 0, verified = false;
  await deliverySchedule({ name: 'scheduler-self-test', operation: async () => dispatched++, verify: async () => { assert.equal(dispatched, 1000); verified = true; }, record: () => {} });
  assert.ok(verified);
  await assert.rejects(deliverySchedule({ count: 999 }), /minimum/);
});
