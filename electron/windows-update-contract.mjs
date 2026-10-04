// Private utility-process RPC only. HTTP authorization/checkpoint/resume live
// in the server; Windows keeps its existing sha512-verified NSIS installer.
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { durableJson } from "./host-lifecycle.mjs";

const prefix = "openmausbot:update-";
const types = new Set([`${prefix}candidate`, `${prefix}admit`, `${prefix}execute`]);
const refuse = message => Object.assign(new Error(message), { status: 409 });
const tick = () => new Promise(setImmediate);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);

function validatePlan(plan, dataDir) {
  if (!plan || !/^[a-f0-9-]{36}$/.test(plan.updateId) || !["update", "restart"].includes(plan.mode) ||
      ![plan.version, plan.sha, plan.oldVersion, plan.oldSha].every(text) || typeof plan.force !== "boolean" ||
      !Array.isArray(plan.ports) || !plan.ports.length || !plan.ports.every(port => Number.isInteger(port) && port > 0 && port <= 65535) ||
      !Number.isFinite(plan.healthSeconds) || plan.healthSeconds <= 0 || plan.healthSeconds > 300 ||
      !Number.isFinite(plan.gracefulSeconds) || plan.gracefulSeconds < 0 || plan.gracefulSeconds > 300) throw refuse("Invalid Windows update plan");
  const health = new URL(plan.health);
  if (health.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(health.hostname) ||
      health.pathname !== "/api/health" || health.username || health.password || health.search || health.hash ||
      Number(health.port) !== plan.ports[0]) throw refuse("Windows update health must be the owned loopback endpoint");
  if (typeof plan.resultPath !== "string" || typeof plan.installedPath !== "string" ||
      resolve(plan.resultPath) !== resolve(dataDir, "updates", plan.updateId, "result.json") ||
      resolve(plan.installedPath) !== resolve(dataDir, "updates", "installed.json")) throw refuse("Windows update result path is outside the operation");
  return structuredClone(plan);
}

export function createWindowsUpdateResultWriter({ dataDir, currentVersion, hostPid = process.pid, hostId = String(hostPid), verifyHealth, now = () => new Date() }) {
  const pendingPath = join(dataDir, "updates", "windows-pending.json");
  function readPending() {
    let record;
    try { record = JSON.parse(readFileSync(pendingPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw refuse("Windows update intent is unreadable; installation remains held"); }
    if (record.version !== 1 || !Number.isSafeInteger(record.hostPid) || record.hostPid <= 0 || !text(record.hostId)) throw refuse("Invalid Windows update intent");
    return { ...record, plan: validatePlan(record.plan, dataDir) };
  }
  function persistPlan(input) {
    const plan = validatePlan(input, dataDir);
    if (readPending()) throw refuse("Windows update intent is already pending");
    mkdirSync(dirname(pendingPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(plan.resultPath), { recursive: true, mode: 0o700 });
    durableJson(pendingPath, { version: 1, hostPid, hostId, at: now().toISOString(), plan });
  }
  let completing = null;
  async function completePending() {
    const pending = readPending();
    // The old server/host is still alive until NSIS/relaunch owns the exit.
    if (!pending || pending.hostId === hostId) return;
    const { plan } = pending;
    // Crash after result persistence but before clearing intent is idempotent.
    if (existsSync(plan.resultPath)) { unlinkSync(pendingPath); return; }
    let healthy = false;
    try { healthy = Boolean(await verifyHealth(plan)); } catch { /* fail closed */ }
    const success = healthy && currentVersion() === plan.version;
    const result = { state: success ? "done" : "failed", at: now().toISOString(), updateId: plan.updateId, mode: plan.mode,
      detail: success ? `BOS ${plan.mode === "restart" ? "restarted" : `updated to ${plan.version}`} and passed health checks.` : "Windows relaunch failed version or health verification. NSIS rollback is unavailable; manual recovery is required.",
      ...(success ? { version: plan.version, sha: plan.sha } : { manualRecoveryRequired: true }) };
    if (success) durableJson(plan.installedPath, { version: plan.version, sha: plan.sha });
    durableJson(plan.resultPath, result);
    unlinkSync(pendingPath);
  }
  return { validate: input => validatePlan(input, dataDir), readPending, persistPlan,
    complete() { return completing ??= completePending().finally(() => { completing = null; }); } };
}

export function createWindowsUpdateContract({ coordinator, lifecycleClient, relaunch, resultWriter, log = () => {} }) {
  let active = false;
  function admit(mode) {
    if (active || resultWriter.readPending()) throw refuse("Windows update is already pending");
    coordinator.admit(mode);
  }
  function receive(proc, message) {
    if (!types.has(message?.type)) return false;
    const { requestId, type } = message;
    if (typeof requestId !== "string" || !requestId.length || requestId.length > 100) return true;
    let replied = false;
    const reply = body => { if (!replied) { proc.postMessage({ type: `${type}-result`, requestId, ...body }); replied = true; } };
    void (async () => {
      try {
        if (type === `${prefix}candidate`) { reply({ candidate: coordinator.candidate() }); return; }
        if (type === `${prefix}admit`) { admit(message.mode); reply({ ok: true }); return; }
        const plan = resultWriter.validate(message.plan);
        admit(plan.mode);
        if (plan.mode === "update") {
          const candidate = coordinator.candidate();
          if (!candidate || candidate.version !== plan.version || candidate.sha !== plan.sha) throw refuse("Staged Windows installer changed");
        }
        active = true;
        coordinator.hold?.();
        // Retain intent on every ambiguous failure. Do not arm another installer.
        resultWriter.persistPlan(plan);
        const prepareInstall = async () => {
          await lifecycleClient.prepareInstall(plan);
          reply({ ok: true });
          // Acknowledge before quit; acceptance is not update completion.
          await tick();
        };
        if (plan.mode === "restart") { await prepareInstall(); relaunch(); }
        else {
          const outcome = await coordinator.install({ prepareInstall });
          if (!outcome?.dispatched || outcome.error) throw refuse(outcome?.error ?? "Windows install was not dispatched");
        }
      } catch (error) {
        if (!replied) reply({ ok: false, error: error?.message ?? "Windows updater refused", status: error?.status ?? 409, ...(active ? { pending: true } : {}) });
        else log(`Windows update handoff remains held: ${error?.message ?? error}`);
      }
    })().catch(error => log(`Windows update private reply failed: ${error?.message ?? error}`));
    return true;
  }
  return { receive, onServerHealthy: () => resultWriter.complete() };
}

// The new coordinator already owns the workspace maintenance gate. Running
// the legacy HTTP prepare here would try to acquire it under a second nonce.
export function createCheckpointUpdateLifecycle({ dataDir, isOwned, recordIntent }) {
  return { async prepareInstall(plan) {
    validatePlan(plan, dataDir);
    if (!isOwned()) throw refuse("Desktop update owner changed; installation held");
    let checkpoint;
    try { checkpoint = JSON.parse(readFileSync(join(dataDir, "updates", plan.updateId, "checkpoint.json"), "utf8")); }
    catch { throw refuse("Stopped update checkpoint is unavailable"); }
    if (checkpoint.version !== 1 || checkpoint.updateId !== plan.updateId || checkpoint.mode !== plan.mode ||
        !Array.isArray(checkpoint.turns) || !Number.isFinite(Date.parse(checkpoint.stoppedAt))) throw refuse("Stopped update checkpoint does not match the plan");
    await recordIntent(plan);
  } };
}

function listening(port, timeoutMs) {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolvePromise(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
export function createWindowsUpdateHealthVerifier({ getConnection, fetch: request = globalThis.fetch, checkPort = listening }) {
  return async plan => {
    const deadline = Date.now() + plan.healthSeconds * 1000;
    while (Date.now() < deadline) {
      const connection = getConnection();
      if (!connection || new URL(plan.health).origin !== connection.url) return false;
      try {
        const response = await request(plan.health, { headers: connection.token ? { "x-openmausbot-desktop-owner": connection.token } : {},
          redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) });
        const health = await response.json();
        if (!response.ok || health.app !== "openmausbot" || health.pid !== connection.pid || !health.static) return false;
        const ports = await Promise.all(plan.ports.map(port => checkPort(port, Math.max(1, Math.min(1000, deadline - Date.now())))));
        if (ports.every(Boolean) && Date.now() < deadline && getConnection()?.pid === connection.pid) return true;
      } catch { /* readiness can precede companion gateway startup */ }
      if (Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(250, deadline - Date.now())));
    }
    return false;
  };
}
