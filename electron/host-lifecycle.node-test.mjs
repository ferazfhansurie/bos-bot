import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostLifecycle, readHostLifecycle } from './host-lifecycle.mjs';

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bos-lifecycle-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('durable quit precedes cleanup and only explicit launch clears it', () => fixture(dir => {
  const host = createHostLifecycle(dir);
  host.childStarted(1234);
  host.ready(1234);
  host.quit();
  assert.equal(readHostLifecycle(dir).phase, 'quit');
  assert.throws(() => createHostLifecycle(dir, { recovery: { generation: host.generation, token: 'test' } }), /recovery/);
  const next = createHostLifecycle(dir);
  assert.notEqual(next.generation, host.generation);
  assert.equal(readHostLifecycle(dir).phase, 'starting');
  assert.throws(() => host.quit(), /generation/);
}));
test('update and maintenance remain held on ordinary quit', () => fixture(dir => {
  const host = createHostLifecycle(dir);
  host.childStarted(1234); host.ready(1234);
  assert.throws(() => host.update({ state: 'prepared', nonce: 'nonce', pid: 1234, generation: host.generation }), /receipt/i);
  host.update({ state: 'committed', nonce: 'nonce', pid: 1234, generation: host.generation }); host.quit();
  assert.equal(readHostLifecycle(dir).phase, 'update');
  assert.throws(() => host.update({ state: 'committed', nonce: 'other', pid: 4321, generation: host.generation }), /child/);
  assert.throws(() => host.update({ state: 'committed', nonce: 'other', pid: 1234, generation: randomUUID() }), /generation/);
  const next = createHostLifecycle(dir);
  next.maintenance('restore'); next.quit();
  assert.equal(readHostLifecycle(dir).phase, 'maintenance');
}));
test('failed persistence blocks quit and corrupt records fail closed', () => fixture(dir => {
  let fail = false;
  const host = createHostLifecycle(dir, { beforeWrite: () => { if (fail) throw new Error('disk unavailable'); } });
  fail = true;
  assert.throws(() => host.quit(), /disk unavailable/);
  assert.equal(readHostLifecycle(dir).phase, 'starting');
  writeFileSync(join(dir, 'desktop-lifecycle.json'), '{broken');
  assert.throws(() => createHostLifecycle(dir), /invalid/);
}));
test('recovery launch is fenced to one durable runner attempt', () => fixture(dir => {
  const host = createHostLifecycle(dir); host.ready();
  const token = randomUUID();
  writeFileSync(join(dir, 'host-recovery-state.json'), JSON.stringify({ version: 1, attempts: 1, nextAt: 0, circuit: false, pending: { generation: host.generation, token, deadline: Date.now() + 60_000, pid: null } }));
  assert.throws(() => createHostLifecycle(dir, { recovery: { generation: host.generation, token: 'wrong' } }), /attempt/);
  const successor = createHostLifecycle(dir, { recovery: { generation: host.generation, token } });
  assert.equal(readHostLifecycle(dir).recoveredFrom, host.generation);
  assert.throws(() => createHostLifecycle(dir, { recovery: { generation: host.generation, token } }), /generation/);
  assert.ok(successor.generation);
  assert.equal(JSON.parse(readFileSync(join(dir, 'desktop-lifecycle.json'))).pid, process.pid);
}));
