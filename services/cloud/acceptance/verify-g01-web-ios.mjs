import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Independent readback: the expected strings come from the pre-dispatch file,
// never from a client projection or the service's response.
const [statePath, evidence, workspace, room] = process.argv.slice(2);
const require = createRequire(new URL('../package.json', import.meta.url));
const { Client } = require('pg');
const state = JSON.parse(readFileSync(statePath));
const intentBytes = readFileSync(`${evidence}/intents.json`);
const intents = JSON.parse(intentBytes);
const client = new Client({ connectionString: state.migration_url });
await client.connect();
try {
  const rows = (await client.query(
    'SELECT message_id,actor_id,client_operation_id,sequence,text,version,deleted FROM cloud.messages WHERE workspace_id=$1 AND room_id=$2 ORDER BY sequence',
    [workspace, room],
  )).rows;
  const members = (await client.query(
    'SELECT m.account_id,m.role,a.subject,a.issuer FROM cloud.members m JOIN cloud.accounts a USING(account_id) WHERE m.workspace_id=$1 ORDER BY m.role', [workspace],
  )).rows;
  const operations = (await client.query('SELECT account_id,client_operation_id,digest,result FROM cloud.operations WHERE workspace_id=$1 AND room_id=$2 ORDER BY created_at', [workspace, room])).rows;
  const events = (await client.query('SELECT event_id,sequence,kind FROM cloud.room_events WHERE workspace_id=$1 AND room_id=$2 ORDER BY sequence', [workspace, room])).rows;
  writeFileSync(`${evidence}/pg-readback.json`, JSON.stringify({ rows, members, operations, events }, null, 2));
  const web = JSON.parse(readFileSync(`${evidence}/web-observations.json`));
  const iosLog = readFileSync(`${evidence}/ios.private.log`, 'utf8');
  const ios = [...iosLog.matchAll(/CLOUD_INTEROP (\{[^\n]+\})/g)].map(x => JSON.parse(x[1]));
  writeFileSync(`${evidence}/ios-observations.json`, JSON.stringify(ios, null, 2));
  const expected = intents.web.flatMap((text, index) => [text, intents.ios[index]]);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(x => x.text), expected);
  // Invite redemption occupies sequence 1 before the six frozen messages.
  assert.deepEqual(rows.map(x => x.sequence), ['2', '3', '4', '5', '6', '7']);
  assert.equal(new Set(rows.map(x => x.message_id)).size, 6);
  assert.equal(new Set(rows.map(x => x.client_operation_id)).size, 6);
  assert.equal(operations.length, 6);
  assert.equal(events.length, 7);
  assert.equal(events[0].sequence, '1');
  assert.ok(!events[0].kind.startsWith('message.'));
  assert.ok(rows.every(x => x.version === 1 && x.deleted === false));
  assert.equal(members.length, 2);
  const owner = members.find(x => x.role === 'owner');
  const member = members.find(x => x.role === 'member');
  assert.ok(owner && member);
  assert.equal(owner.subject, web.subject);
  assert.equal(member.subject, ios.find(x => x.event === 'signedIn').subject);
  assert.notEqual(owner.account_id, member.account_id);
  assert.ok(members.every(x => x.issuer === 'http://127.0.0.1:60557'));
  assert.deepEqual(rows.map(x => x.actor_id), expected.map((_, i) => i % 2 ? member.account_id : owner.account_id));
  const iosMessages = ios.filter(x => ['received', 'sent'].includes(x.event));
  assert.equal(iosMessages.length, 6);
  for (const [i, row] of rows.entries()) {
    const observed = iosMessages[i];
    assert.equal(observed.text, expected[i]);
    assert.equal(observed.messageId, row.message_id);
    assert.equal(observed.event, i % 2 ? 'sent' : 'received');
    assert.equal(observed.step, String(i));
    assert.equal(web.projection[i], expected[i]);
    const realtime = web.messages.find(x => x.message.message_id === row.message_id);
    assert.ok(realtime, `web realtime missing ${row.message_id}`);
    assert.equal(realtime.message.text, expected[i]);
    assert.equal(realtime.message.sequence, row.sequence);
    assert.equal(realtime.message.actor_id, row.actor_id);
    const operation = operations.find(x => x.client_operation_id === row.client_operation_id);
    assert.ok(operation);
    assert.equal(operation.account_id, row.actor_id);
    assert.equal(operation.result.status, 'accepted');
    assert.equal(operation.result.message_id, row.message_id);
    assert.equal(operation.result.sequence, row.sequence);
    assert.equal(operation.result.digest, operation.digest);
  }
  assert.equal(web.sends.length, 3);
  for (const [i, send] of web.sends.entries()) {
    assert.equal(send.status, 200);
    assert.equal(send.request.text, intents.web[i]);
    assert.equal(send.response.status, 'accepted');
    assert.equal(send.response.message_id, rows[i * 2].message_id);
    assert.equal(send.response.sequence, rows[i * 2].sequence);
    assert.equal(send.response.client_operation_id, rows[i * 2].client_operation_id);
    assert.deepEqual(send.response, operations.find(x => x.client_operation_id === send.response.client_operation_id).result);
  }
  assert.equal(JSON.parse(readFileSync(`${evidence}/ios-exit.json`)).exit_code, 0);
  assert.match(iosLog, /Executed 1 test, with 0 failures/);
  const summary = { case: 'g01', status: 'passed', exchanges: 3, messages: 6, intent_sha256: createHash('sha256').update(intentBytes).digest('hex'), workspace, room, message_ids: rows.map(x => x.message_id), sequence: rows.map(x => x.sequence), byte_exact: true, ios_test_exit: 0, target: 'web dev renderer + iOS simulator', remaining_gates: ['other slice-2 matrix cases', 'installed desktop', 'physical phone'] };
  writeFileSync(`${evidence}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await client.end();
}
