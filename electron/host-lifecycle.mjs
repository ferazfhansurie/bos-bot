// Durable host intent. The caller must already own the data-directory lease.
// Recovery only restarts the executable; it never replays a task or restores a DB.
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const phases = new Set(['starting', 'running', 'quit', 'update', 'maintenance']);
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function validRecoveryState(value) {
  return Boolean(value && value.version === 1 && Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts <= 3 && Number.isFinite(value.nextAt) && value.nextAt >= 0 && typeof value.circuit === 'boolean' &&
    (value.pending === null || (value.attempts > 0 && value.pending && uuid(value.pending.generation) && uuid(value.pending.token) &&
      Number.isFinite(value.pending.deadline) && value.pending.deadline > 0 && (value.pending.pid === null || pid(value.pending.pid)))));
}
export function durableJson(path, value) {
  const candidate = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(candidate, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(candidate, path);
    // Flush the directory entry as well as the complete record. Windows does
    // not support opening a directory for fsync; the atomic rename still applies.
    if (process.platform !== 'win32') {
      const fd = openSync(join(path, '..'), 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  } catch (error) {
    try { unlinkSync(candidate); } catch { /* preserve the persistence failure */ }
    throw error;
  }
}
export function readHostLifecycle(dataDir) {
  let raw;
  try { raw = readFileSync(join(dataDir, 'desktop-lifecycle.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Desktop lifecycle record is invalid; recovery is held.'); }
  if (!value || value.version !== 1 || !uuid(value.generation) || !pid(value.pid) || !phases.has(value.phase) || !Array.isArray(value.children) || !value.children.every(pid) || !Number.isFinite(value.startedAt) || !(value.startedAt > 0) || (value.readyAt !== null && (!Number.isFinite(value.readyAt) || value.readyAt < value.startedAt))) {
    throw new Error('Desktop lifecycle record is invalid; recovery is held.');
  }
  return value;
}
export function createHostLifecycle(dataDir, { recovery = null, beforeWrite = () => {}, now = Date.now } = {}) {
  const previous = readHostLifecycle(dataDir);
  if (recovery) {
    if (!previous || previous.generation !== recovery.generation) throw new Error('Recovery generation changed; launch refused.');
    if (!['starting', 'running'].includes(previous.phase)) throw new Error('Intentional quit or maintenance prevents recovery.');
    let attempt;
    try {
      const record = JSON.parse(readFileSync(join(dataDir, 'host-recovery-state.json'), 'utf8'));
      if (validRecoveryState(record)) attempt = record.pending;
    } catch { /* fail closed */ }
    if (!attempt || attempt.generation !== recovery.generation || attempt.token !== recovery.token) throw new Error('Recovery attempt is not authorized by the durable runner.');
  }
  const generation = randomUUID();
  let state = { version: 1, generation, pid: process.pid, children: [], phase: 'starting', startedAt: now(), readyAt: null, ...(recovery ? { recoveredFrom: recovery.generation } : {}) };
  const publish = next => { beforeWrite(next); durableJson(join(dataDir, 'desktop-lifecycle.json'), next); state = next; };
  const change = patch => {
    if (readHostLifecycle(dataDir)?.generation !== generation) throw new Error('Desktop lifecycle generation changed; stale write refused.');
    publish({ ...state, ...patch });
  };
  publish(state);
  return Object.freeze({
    generation,
    childStarted(child) { if (!pid(child)) throw new Error('Invalid desktop child identity.'); change({ children: [...new Set([...state.children, child])], readyAt: null }); },
    childExited(child) { change({ children: state.children.filter(value => value !== child), readyAt: null }); },
    ready(child) {
      if (child !== undefined && !state.children.includes(child)) throw new Error('Desktop ready child changed.');
      if (!['starting', 'running'].includes(state.phase)) throw new Error('Desktop maintenance prevents readiness.');
      change({ phase: 'running', readyAt: now() });
    },
    update(receipt) {
      if (!receipt || receipt.state !== 'committed' || receipt.generation !== generation || typeof receipt.nonce !== 'string' || !state.children.includes(receipt.pid)) throw new Error('Update receipt belongs to another child or host generation.');
      change({ phase: 'update', receipt: { nonce: receipt.nonce, pid: receipt.pid, generation }, readyAt: null });
    },
    maintenance(reason) { change({ phase: 'maintenance', reason, readyAt: null }); },
    quit() { if (!['update', 'maintenance'].includes(state.phase)) change({ phase: 'quit', readyAt: null }); },
  });
}
