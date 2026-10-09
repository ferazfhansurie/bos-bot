import { compatEnv } from "./branding-env.cjs";
// External, opt-in host supervision. There is deliberately no service installer.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { acquireDataDirLease, dataDirRecoverySafe } from './data-dir-lease.mjs';
import { durableJson, readHostLifecycle, validRecoveryState } from './host-lifecycle.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; }
}
function maintenanceReason(dataDir, host) {
  // Standard HTTP restore has no main-process IPC hook. Its existing durable
  // journal is authoritative even when the parent died before recording intent.
  const read = path => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Unverifiable maintenance receipt; recovery held.'); }
  };
  const pending = read(join(dataDir, '.backups', 'pending-restore.json'));
  if (pending !== null) return 'Workspace restore is pending; explicit launch required.';
  const journal = read(join(dataDir, '.backups', 'restore-journal.json'));
  if (journal !== null && !['committed', 'rolled-back'].includes(journal?.phase)) return 'Workspace restore journal requires inspection.';
  const privateWork = read(join(dataDir, 'private-turn-dispatches.json'));
  if (privateWork !== null) {
    if (!privateWork || privateWork.version !== 1 || !Array.isArray(privateWork.records) || !privateWork.records.every(record =>
      record && typeof record.id === 'string' && typeof record.botId === 'string' && typeof record.threadId === 'string' &&
      ['dispatching', 'outcome-unknown'].includes(record.state) && Number.isInteger(record.createdAt) && record.createdAt >= 0 &&
      ((record.reviewedAt === undefined && record.reviewedBy === undefined) || (record.state === 'outcome-unknown' &&
        Number.isInteger(record.reviewedAt) && record.reviewedAt > 0 && typeof record.reviewedBy === 'string' && record.reviewedBy.trim().length > 0 && record.reviewedBy.length <= 200))) ||
      (privateWork.bindings !== undefined && (!Array.isArray(privateWork.bindings) || !privateWork.bindings.every(binding =>
        binding && typeof binding.threadId === 'string' && typeof binding.providerTurnId === 'string' && typeof binding.generation === 'string')))) {
      throw new Error('Private work journal is invalid; recovery held.');
    }
    if (privateWork.records.some(record => record.reviewedAt === undefined || record.reviewedBy === undefined)) return 'Unconfirmed private work needs manual review; no automatic host restart.';
  }
  const update = read(join(dataDir, 'desktop-update-receipt.json'));
  if (update !== null) {
    if (!update || update.version !== 1 || !Number.isSafeInteger(update.pid) || update.pid <= 0 || !['prepared', 'committed', 'cancelled'].includes(update.state) || typeof update.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(update.generation) || typeof update.nonce !== 'string' || typeof update.preparedAt !== 'string') throw new Error('Invalid update receipt; recovery held.');
    if (['prepared', 'committed'].includes(update.state) && update.generation === host.generation) return 'Prepared update handoff remains held.';
  }
  return null;
}
function readLeasePid(path) {
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Unverifiable host/child lease; recovery held.'); }
  if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid < 1 || typeof record.token !== 'string') throw new Error('Invalid host/child lease; recovery held.');
  return record.pid;
}
export function createHostRecovery(config, { now = Date.now, isAlive = alive, spawn = nodeSpawn } = {}) {
  if (!config || !isAbsolute(config.dataDir ?? '') || !isAbsolute(config.executable ?? '') || !Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) throw new Error('Recovery requires an explicit absolute executable, argv and data directory.');
  const dataDir = realpathSync(config.dataDir);
  const executable = realpathSync(config.executable);
  const ownerDir = join(dataDir, '.host-recovery-owner');
  mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  const lease = acquireDataDirLease(ownerDir);
  const statePath = join(dataDir, 'host-recovery-state.json');
  let state;
  try {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 1, attempts: 0, nextAt: 0, circuit: false, pending: null }; }
    if (!validRecoveryState(state)) throw new Error('Recovery state is invalid; automatic launch refused.');
  } catch (e) { lease.release(); throw e; }
  const maxAttempts = 3, backoffMs = 2_000, stableMs = 60_000, startupMs = 60_000;
  let closed = false;
  const save = patch => { const next = { ...state, ...patch }; durableJson(statePath, next); state = next; };
  const dead = host => {
    if (!dataDirRecoverySafe(dataDir)) return false;
    const parent = readLeasePid(join(dataDir, 'openmausbot-server.lease'));
    const child = readLeasePid(join(dataDir, '.openmausbot-server-child', 'openmausbot-server.lease'));
    return [host.pid, ...host.children, parent, child].filter(Boolean).every(value => !isAlive(value));
  };
  return Object.freeze({
    tick() {
      if (closed) throw new Error('Recovery owner has closed.');
      const host = readHostLifecycle(dataDir);
      if (!host) return { status: 'held', reason: 'No recorded host; explicit launch required.' };
      if (!['starting', 'running'].includes(host.phase)) return { status: 'held', reason: host.phase };
      const maintenance = maintenanceReason(dataDir, host);
      if (maintenance) return { status: 'held', reason: maintenance };
      if (state.pending) {
        if (host.generation !== state.pending.generation) {
          if (host.recoveredFrom !== state.pending.generation) return { status: 'held', reason: 'Another explicit launch changed generation.' };
          save({ pending: null });
        } else {
          if (state.pending.pid && isAlive(state.pending.pid)) return { status: 'held', reason: now() >= state.pending.deadline ? 'Successor startup timed out; no sibling allowed.' : 'Successor is starting.' };
          // Crash after reservation but before recording spawn identity is
          // uncertain. Hold rather than assume no executable was launched.
          if (!state.pending.pid) return { status: 'held', reason: 'Uncertain spawn identity; explicit inspection required.' };
          if (now() < state.pending.deadline) return { status: 'waiting' };
          save({ pending: null });
        }
      }
      if (isAlive(host.pid)) {
        if (host.phase === 'running' && host.readyAt && now() - host.readyAt >= stableMs && host.children.length && host.children.every(isAlive) && state.attempts) save({ attempts: 0, circuit: false, nextAt: 0 });
        return { status: 'healthy' };
      }
      if (!dead(host)) return { status: 'held', reason: 'Host or delegated child still alive.' };
      if (state.circuit || state.attempts >= maxAttempts) return { status: 'held', reason: 'Recovery circuit is open.' };
      if (now() < state.nextAt) return { status: 'waiting' };
      const token = randomUUID();
      const attempts = state.attempts + 1;
      const pending = { generation: host.generation, token, deadline: now() + startupMs, pid: null };
      save({ attempts, circuit: attempts >= maxAttempts, nextAt: now() + Math.min(30_000, backoffMs * 2 ** (attempts - 1)), pending });
      // Recheck all identities and intent after durable reservation. A manual
      // launch/quit that changed the generation must not be overwritten.
      const current = readHostLifecycle(dataDir);
      if (!current || current.generation !== host.generation || !['starting', 'running'].includes(current.phase) || maintenanceReason(dataDir, current) || !dead(current)) {
        save({ pending: null }); return { status: 'held', reason: 'Host changed during recovery reservation.' };
      }
      let child;
      try {
        child = spawn(executable, config.args, { shell: false, stdio: 'ignore', env: { ...compatEnv, OMB_DATA_DIR: dataDir, OMB_RECOVERY_GENERATION: host.generation, OMB_RECOVERY_TOKEN: token } });
        child.on('error', () => { /* durable attempt remains held/limited */ });
        if (!Number.isInteger(child.pid) || child.pid < 1) throw new Error('Recovery spawn identity unavailable.');
        save({ pending: { ...pending, pid: child.pid } });
        child.unref?.();
      } catch {
        // Do not erase an uncertain reservation or dispatch a second spawn.
        return { status: 'held', reason: 'Recovery spawn failed or is uncertain.' };
      }
      return { status: 'launched', pid: child.pid, attempt: attempts };
    },
    state: () => structuredClone(state),
    close() { if (!closed) { lease.release(); closed = true; } },
  });
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; lease: a new server must lock the same data-directory lease as an existing process; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
