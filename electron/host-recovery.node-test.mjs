import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostLifecycle, readHostLifecycle } from './host-lifecycle.mjs';
import { createHostRecovery } from './host-recovery.mjs';

test('dead host restart is one-owner, fenced and bounded across runner restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-runner-'));
  const fakeAlive = new Set(); let time = Date.now(), launches = 0;
  const config = { dataDir: dir, executable: process.execPath, args: [] };
  const options = { now: () => time, isAlive: value => fakeAlive.has(value), spawn: (_executable, _args, options) => { assert.equal(options.env.OMB_DATA_DIR, realpathSync(dir)); launches++; const child = new EventEmitter(); child.pid = 20000 + launches; return child; } };
  let runner;
  try {
    const host = createHostLifecycle(dir); host.childStarted(1234); host.ready(1234);
    fakeAlive.add(1234);
    runner = createHostRecovery(config, options);
    assert.throws(() => createHostRecovery(config, options), /already using/);
    assert.equal(runner.tick().status, 'held'); assert.equal(launches, 0);
    fakeAlive.delete(1234);
    assert.equal(runner.tick().status, 'launched');
    assert.equal(runner.tick().status, 'waiting');
    runner.close(); runner = createHostRecovery(config, options);
    assert.equal(runner.tick().status, 'waiting'); assert.equal(launches, 1);
    time += 61_000; assert.equal(runner.tick().status, 'launched');
    time += 61_000; assert.equal(runner.tick().status, 'launched');
    time += 61_000; assert.match(runner.tick().reason, /circuit/); assert.equal(launches, 3);
    runner.close(); runner = createHostRecovery(config, options);
    assert.match(runner.tick().reason, /circuit/);
  } finally { runner?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('malformed durable pending identities fail closed and release runner ownership', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-runner-invalid-'));
  const config = { dataDir: dir, executable: process.execPath, args: [] };
  try {
    const host = createHostLifecycle(dir);
    for (const pending of [
      { generation: host.generation, token: 'broken', pid: null, deadline: Date.now() },
      { generation: host.generation, token: host.generation, pid: '123', deadline: Date.now() },
      { generation: host.generation, token: host.generation, pid: -1, deadline: Date.now() },
      { generation: 'broken', token: host.generation, pid: null, deadline: Date.now() },
    ]) {
      writeFileSync(join(dir, 'host-recovery-state.json'), JSON.stringify({ version: 1, attempts: 1, nextAt: 0, circuit: false, pending }));
      assert.throws(() => createHostRecovery(config), /invalid/);
    }
    writeFileSync(join(dir, 'host-recovery-state.json'), JSON.stringify({ version: 1, attempts: 0, nextAt: 0, circuit: false, pending: null }));
    createHostRecovery(config).close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('an asynchronous failed spawn is handled and never starts another executable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-runner-spawn-'));
  let launches = 0, runner;
  try {
    createHostLifecycle(dir);
    runner = createHostRecovery({ dataDir: dir, executable: process.execPath, args: [] }, { isAlive: () => false, spawn: () => {
      launches++; const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('spawn refused'))); return child;
    } });
    assert.equal(runner.tick().status, 'held');
    await Promise.resolve();
    assert.equal(runner.tick().status, 'held'); assert.equal(launches, 1);
  } finally { runner?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('ordinary restore journals and prepared child receipts hold recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-runner-maintenance-'));
  let runner;
  try {
    const host = createHostLifecycle(dir); host.childStarted(1234); host.ready(1234);
    runner = createHostRecovery({ dataDir: dir, executable: process.execPath, args: [] }, { isAlive: () => false, spawn: () => { throw new Error('must not launch'); } });
    mkdirSync(join(dir, '.backups'));
    writeFileSync(join(dir, '.backups', 'pending-restore.json'), '{}');
    assert.match(runner.tick().reason, /restore/);
    rmSync(join(dir, '.backups', 'pending-restore.json'));
    writeFileSync(join(dir, '.backups', 'restore-journal.json'), JSON.stringify({ phase: 'applying' }));
    assert.match(runner.tick().reason, /restore/);
    rmSync(join(dir, '.backups', 'restore-journal.json'));
    for (const state of ['prepared', 'committed']) {
      writeFileSync(join(dir, 'desktop-update-receipt.json'), JSON.stringify({ version: 1, pid: 1234, generation: host.generation, state, nonce: host.generation, preparedAt: new Date().toISOString() }));
      assert.match(runner.tick().reason, /update/);
    }
  } finally { runner?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('unconfirmed private work prevents automatic host recovery without replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-runner-work-')); let runner;
  try {
    const host = createHostLifecycle(dir);
    runner = createHostRecovery({ dataDir: dir, executable: process.execPath, args: [] }, { isAlive: () => false, spawn: () => { throw new Error('must not launch'); } });
    for (const state of ['dispatching', 'outcome-unknown']) {
      writeFileSync(join(dir, 'private-turn-dispatches.json'), JSON.stringify({ version: 1, records: [{ id: host.generation, botId: 'synthetic-bot', threadId: 'synthetic-thread', state, createdAt: Date.now() }] }));
      assert.match(runner.tick().reason, /private work/);
    }
    writeFileSync(join(dir, 'private-turn-dispatches.json'), '{}');
    assert.throws(() => runner.tick(), /private.*invalid/i);
  } finally { runner?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('foreign-machine or corrupt data-directory owners never authorize a launch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-runner-foreign-'));
  let runner;
  try {
    const host = createHostLifecycle(dir);
    writeFileSync(join(dir, 'openmausbot-server.lease'), JSON.stringify({ version: 1, pid: 9999999, host: 'different-machine', token: host.generation, createdAt: Date.now(), boot: null, uptime: 0 }));
    runner = createHostRecovery({ dataDir: dir, executable: process.execPath, args: [] }, { isAlive: () => false, spawn: () => { throw new Error('must not launch'); } });
    assert.throws(() => runner.tick(), /machine/);
    writeFileSync(join(dir, 'openmausbot-server.lease'), '{}');
    assert.throws(() => runner.tick(), /invalid/);
  } finally { runner?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('quit, maintenance, corrupt state and uncertain spawn never replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-runner-hold-')); let launches = 0;
  let runner;
  const config = { dataDir: dir, executable: process.execPath, args: [] };
  try {
    let host = createHostLifecycle(dir); host.quit();
    runner = createHostRecovery(config, { isAlive: () => false, spawn: () => { launches++; throw new Error('failed'); } });
    assert.equal(runner.tick().reason, 'quit');
    runner.close(); runner = createHostRecovery(config, { isAlive: () => false, spawn: () => { launches++; throw new Error('failed'); } });
    assert.equal(runner.tick().reason, 'quit');
    host = createHostLifecycle(dir); host.maintenance('restore'); assert.equal(runner.tick().reason, 'maintenance');
    createHostLifecycle(dir); assert.equal(runner.tick().status, 'held'); assert.equal(launches, 1);
    assert.match(runner.tick().reason, /Uncertain spawn/); assert.equal(launches, 1);
    writeFileSync(join(dir, 'desktop-lifecycle.json'), '{broken');
    assert.throws(() => runner.tick(), /invalid/);
  } finally { runner?.close(); rmSync(dir, { recursive: true, force: true }); }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { const value = fn(); if (value) return value; await delay(50); }
  throw new Error('fixture condition timed out');
}
test('actual external runner survives host death, preserves state, and respects quit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bos-external-fixture-'));
  const lifecycleUrl = new URL('./host-lifecycle.mjs', import.meta.url).href;
  const leaseUrl = new URL('./data-dir-lease.mjs', import.meta.url).href;
  const fixture = join(dir, 'host.mjs');
  const synthetic = JSON.stringify({ drafts: ['unsent'], pairing: 'synthetic', approvals: ['pending'], requests: [{ state: 'outcome-unknown' }] });
  writeFileSync(join(dir, 'synthetic-data.json'), synthetic);
  writeFileSync(fixture, `import {spawn} from 'node:child_process'; import {createHostLifecycle} from ${JSON.stringify(lifecycleUrl)}; import {acquireDataDirLease} from ${JSON.stringify(leaseUrl)};
const dir=process.env.OMB_DATA_DIR; const lease=acquireDataDirLease(dir); const host=createHostLifecycle(dir,{recovery: process.env.OMB_RECOVERY_GENERATION ? {generation:process.env.OMB_RECOVERY_GENERATION,token:process.env.OMB_RECOVERY_TOKEN}:null});
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});host.childStarted(child.pid);
process.on('SIGTERM',()=>{host.quit();child.once('exit',()=>{host.childExited(child.pid);lease.release();process.exit(0)});child.kill()}); host.ready(child.pid); setInterval(()=>{},1000);`);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ dataDir: dir, executable: process.execPath, args: [fixture] }));
  let host, runner, successor, childPid;
  try {
    host = spawn(process.execPath, [fixture], { stdio: 'ignore', env: { ...process.env, OMB_DATA_DIR: dir } });
    const first = await poll(() => { const state = readHostLifecycle(dir); return state?.phase === 'running' && state; });
    childPid = first.children[0];
    runner = spawn(process.execPath, [fileURLToPath(new URL('../scripts/host-recovery.mjs', import.meta.url)), '--config', configPath], { stdio: 'ignore' });
    host.kill('SIGKILL'); await new Promise(resolve => host.once('exit', resolve));
    await delay(1_300);
    assert.equal(readHostLifecycle(dir).generation, first.generation, 'surviving child prevents a successor');
    process.kill(childPid, 'SIGTERM'); childPid = null;
    const next = await poll(() => { const state = readHostLifecycle(dir); return state?.phase === 'running' && state.generation !== first.generation && state; });
    successor = next.pid; childPid = next.children[0];
    assert.equal(next.recoveredFrom, first.generation);
    assert.equal(JSON.parse(readFileSync(join(dir, 'host-recovery-state.json'))).attempts, 1);
    assert.equal(readFileSync(join(dir, 'synthetic-data.json'), 'utf8'), synthetic);
    process.kill(successor, 'SIGTERM');
    await poll(() => readHostLifecycle(dir)?.phase === 'quit');
    await delay(1_300);
    runner.kill('SIGTERM'); await new Promise(resolve => runner.once('exit', resolve));
    runner = spawn(process.execPath, [fileURLToPath(new URL('../scripts/host-recovery.mjs', import.meta.url)), '--config', configPath], { stdio: 'ignore' });
    await delay(1_300); assert.equal(readHostLifecycle(dir).phase, 'quit');
    assert.equal(JSON.parse(readFileSync(join(dir, 'host-recovery-state.json'))).attempts, 1);
  } finally {
    for (const pid of [host?.pid, successor, childPid, runner?.pid].filter(Boolean)) try { process.kill(pid, 'SIGTERM'); } catch { /* fixture already exited */ }
    await delay(200); rmSync(dir, { recursive: true, force: true });
  }
});
