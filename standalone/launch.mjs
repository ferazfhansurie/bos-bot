// Launcher for a headless BOS server (enterprise clients without the desktop
// app, e.g. a Windows PC started by a scheduled task):
//
//   node launch.mjs config.json            supervisor: keeps the server running,
//                                          applies updates the server handed off
//   node launch.mjs --child config.json    the server itself (+ the optional
//                                          Windows computer-use host, which must
//                                          share the server's process)
//
// Update handoff (server/enterprise-update.ts): the server stages a verified
// bundle in <dir>/updates/staged, writes <dir>/updates/request.json and exits.
// The supervisor then swaps resources/{server,ui,skills,build-commit.json}
// for the staged ones (old ones go to updates/rollback-<id>), starts the
// server and waits for /api/health. Unhealthy or crashed within the window:
// it swaps the old tree back and starts that. Either way it writes the plan's
// result.json, which the coordinator in the new server reads on boot. A new
// build that dies within the stable window after its health check is rolled
// back too. A journal makes a swap cut short by a power loss roll back on the
// next start. server/vendor (native modules for this OS) is not in a bundle
// and moves from the old server tree to the new one.
//
// config.json: host, account, dataDir, resources, port, version, publicUrl,
// logsDir, maintenanceMarker, computerUse?, trustedBrowser? (cua unrestricted mode,
// lets bots attach to the signed-in Chrome), label?, feed? (enterprise feed url)
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SWAPPED = ["server", "ui", "skills", "build-commit.json"];
const KEEP_ROLLBACKS = 2;
const PROVIDER_ENV = /^(?:OMB_|OGB_|OPENMAUSBOT_|CLAUDE_|CODEX_|OPENCODE_|GROK_|KIMI_|HERMES_|FACTORY_|PI_)/;
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameRetry(tmp, file);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Windows refuses a rename while a scanner or the indexer briefly holds a handle. */
export function renameRetry(from, to, attempts = 8) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (i >= attempts || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

export const dirsFor = configPath => {
  const root = path.dirname(path.resolve(configPath));
  const updates = path.join(root, "updates");
  return { root, updates, staged: path.join(updates, "staged"), request: path.join(updates, "request.json"), journal: path.join(updates, "swap-journal.json"), feedState: path.join(updates, "feed-state.json") };
};

// ── the server process ────────────────────────────────────────────────────

// Opt-in (config.computerUse === true): the server honours only the owned
// host's descriptor, attested in this process by resources/cua-host.
export function windowsCuaEnvironment(config) {
  return config.computerUse === true ? { OMB_CUA_WINDOWS_SUPERVISED: "1", OMB_CUA_WINDOWS_DESCRIPTOR: path.join(config.dataDir, "cua-windows", "cua-connection.json") } : {};
}

/** supervisorPid: the launcher that spawned this child; the server only hands
 * an update off when its parent really is that launcher. */
export function serverEnvironment(base, config, configPath, supervisorPid = process.ppid) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (SECRET_ENV.test(key) || PROVIDER_ENV.test(key)) delete env[key];
  const home = path.join(config.dataDir, "provider-home");
  const stamp = readJson(path.join(config.resources, "build-commit.json"));
  return {
    ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CACHE_HOME: path.join(home, ".cache"),
    LOCALAPPDATA: path.join(home, "AppData/Local"), CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    OMB_DISABLE_LEGACY_MIGRATION: "1", OMB_DATA_DIR: config.dataDir, OMB_PORT: String(config.port), OMB_WEBHOOK_PORT: String(config.port + 1),
    OMB_STATIC_DIR: path.join(config.resources, "ui"), OMB_RESOURCES_PATH: config.resources, OMB_SKILLS_DIR: path.join(config.resources, "skills"),
    OMB_APP_VERSION: config.version, ...(typeof stamp?.commit === "string" ? { OMB_APP_SHA: stamp.commit } : {}),
    OMB_ENVIRONMENT_LABEL: config.label || "BOS", OMB_PUBLIC_URL: config.publicUrl,
    OMB_STANDALONE_DIR: dirsFor(configPath).root, OMB_STANDALONE_SUPERVISED: "1", OMB_STANDALONE_SUPERVISOR_PID: String(supervisorPid),
    ...(config.feed ? { OMB_ENTERPRISE_FEED: config.feed } : {}), ...(config.channel ? { OMB_ENTERPRISE_CHANNEL: config.channel } : {}),
    ...windowsCuaEnvironment(config),
  };
}

export async function launchChild(config, configPath) {
  if (hostname().toLowerCase() !== config.host.toLowerCase() || userInfo().username.toLowerCase() !== config.account.toLowerCase()) throw new Error("wrong host/account");
  if (existsSync(config.maintenanceMarker)) return "maintenance";
  if (!existsSync(config.dataDir) || !existsSync(path.join(config.resources, "server/index.js"))) throw new Error("configured workspace/runtime missing");
  const wanted = serverEnvironment(process.env, config, configPath);
  Object.assign(process.env, wanted);
  for (const key of Object.keys(process.env)) if ((PROVIDER_ENV.test(key) || SECRET_ENV.test(key)) && !(key in wanted)) delete process.env[key];
  mkdirSync(config.logsDir, { recursive: true });
  const out = path.join(config.logsDir, "server.log");
  process.stdout.write = value => { appendFileSync(out, value); return true; };
  process.stderr.write = value => { appendFileSync(out, value); return true; };
  if (config.computerUse === true) {
    // Starts before the server so the attestation exists before any turn. A
    // refusal leaves the server running without computer tools.
    let cua = null;
    try {
      const { startServerOnlyWindowsCua } = await import(pathToFileURL(path.join(config.resources, "cua-host/windows-cua-host.mjs")).href);
      cua = await startServerOnlyWindowsCua(config);
      if (cua?.env?.OMB_CUA_WINDOWS_DESCRIPTOR !== process.env.OMB_CUA_WINDOWS_DESCRIPTOR) throw new Error("descriptor path mismatch");
      console.error(`[cua-win] ${JSON.stringify({ ...cua.host.status(), startTimedOut: cua.startTimedOut === true })}`);
    } catch (error) { console.error("[cua-win] computer use host did not start:", error?.message ?? error); }
    if (cua?.stopRequested?.()) return "stopping";
  }
  await import(pathToFileURL(path.join(config.resources, "server/index.js")).href);
  return "started";
}

// ── swap / rollback (pure filesystem, unit-tested) ────────────────────────

/** Move the live tree aside and the staged one in. The journal is written
 * first so an interrupted swap can be undone by recoverInterrupted(). */
export function swapIn({ resources, staged, rollback, journal, updateId, oldVersion, plan, publishedAt }) {
  for (const name of ["server", "ui", "build-commit.json"]) if (!existsSync(path.join(staged, name))) throw new Error(`staged update is missing ${name}`);
  mkdirSync(rollback, { recursive: true });
  writeJson(journal, { updateId, rollback, resources, staged, oldVersion, plan, publishedAt, at: new Date().toISOString() });
  const vendor = path.join(resources, "server", "vendor"), stagedVendor = path.join(staged, "server", "vendor");
  if (existsSync(vendor) && !existsSync(stagedVendor)) renameRetry(vendor, stagedVendor);
  for (const name of SWAPPED) {
    if (existsSync(path.join(resources, name))) renameRetry(path.join(resources, name), path.join(rollback, name));
    if (existsSync(path.join(staged, name))) renameRetry(path.join(staged, name), path.join(resources, name));
  }
  rmSync(staged, { recursive: true, force: true });
}

/** Put the rollback tree back; the failed one goes to rollback/failed. */
export function swapBack({ resources, rollback, staged }) {
  const failed = path.join(rollback, "failed");
  mkdirSync(failed, { recursive: true });
  for (const name of SWAPPED) {
    if (!existsSync(path.join(rollback, name))) continue;
    if (existsSync(path.join(resources, name))) renameRetry(path.join(resources, name), path.join(failed, name));
    renameRetry(path.join(rollback, name), path.join(resources, name));
  }
  // the native modules went with the new server tree (or were parked in the
  // staged one when the swap stopped early); bring them back
  const vendor = path.join(resources, "server", "vendor");
  for (const from of [path.join(failed, "server", "vendor"), ...(staged ? [path.join(staged, "server", "vendor")] : [])]) {
    if (existsSync(path.join(resources, "server")) && !existsSync(vendor) && existsSync(from)) renameRetry(from, vendor);
  }
}

export function pruneRollbacks(updates, keep = KEEP_ROLLBACKS) {
  let names;
  try { names = readdirSync(updates).filter(name => name.startsWith("rollback-")); } catch { return; }
  const dated = names.map(name => ({ name, at: readJson(path.join(updates, name, "rollback.json"))?.at ?? "" })).sort((a, b) => b.at.localeCompare(a.at));
  for (const { name } of dated.slice(keep)) rmSync(path.join(updates, name), { recursive: true, force: true });
}

function setConfigVersion(configPath, version) {
  const config = readJson(configPath);
  if (!config || !version || config.version === version) return;
  writeJson(configPath, { ...config, version });
}

// ── supervisor ────────────────────────────────────────────────────────────

export function createSupervisor(configPath, deps = {}) {
  const dirs = dirsFor(configPath);
  const log = deps.log ?? (line => {
    const config = readJson(configPath);
    const dir = config?.logsDir ?? dirs.root;
    try { mkdirSync(dir, { recursive: true }); appendFileSync(path.join(dir, "launcher.log"), `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
  });
  const startChild = deps.startChild ?? (() => spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", configPath], { stdio: "ignore", windowsHide: true }));
  const healthy = deps.healthy ?? (async port => {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) }); return response.ok; }
    catch { return false; }
  });
  const now = deps.now ?? (() => new Date());
  const stableMs = deps.stableMs ?? 120_000;
  const tryTo = (what, fn) => { try { fn(); } catch (error) { log(`${what} failed: ${error?.message ?? error}`); } };

  const result = (plan, value) => {
    if (!plan?.resultPath) return;
    mkdirSync(path.dirname(plan.resultPath), { recursive: true });
    writeJson(plan.resultPath, { updateId: plan.updateId, mode: plan.mode, at: now().toISOString(), ...value });
  };

  /** Start the server. `exited` resolves with its exit code; `health` with
   * whether /api/health answered within `healthSeconds` while it was alive
   * (true straight away when no window is asked for). */
  function run(healthSeconds, port) {
    const child = startChild();
    let alive = true;
    const exited = new Promise(resolve => child.on("exit", code => { alive = false; resolve(code); }));
    child.on("error", error => log(`server failed to start: ${error.message}`));
    const health = !healthSeconds ? Promise.resolve(true) : (async () => {
      const deadline = Date.now() + healthSeconds * 1000;
      while (alive && Date.now() < deadline) {
        if (await healthy(port)) return alive;
        await sleep(deps.pollMs ?? 2000);
      }
      return false;
    })();
    return { child, exited, health, alive: () => alive };
  }

  /** Record a healthy update. The journal goes last: until it is gone a
   * restart of the launcher re-runs this instead of rolling back. */
  function commit(plan, staged, rollback) {
    writeJson(dirs.feedState, { publishedAt: staged.publishedAt, commit: staged.sha });
    result(plan, { state: "done", detail: `installed ${staged.version} (${staged.sha.slice(0, 8)})`, version: staged.version, sha: staged.sha, rollback });
    rmSync(dirs.journal, { force: true });
    tryTo("pruning old rollbacks", () => pruneRollbacks(dirs.updates));
  }

  /** Put the old build back and say so. The journal is only removed once the
   * old tree is really back, so a failed restore is retried on the next start. */
  function rollBack(plan, rollback, oldVersion, detail, staged) {
    swapBack({ resources: readJson(configPath)?.resources, rollback, staged });
    if (oldVersion) setConfigVersion(configPath, oldVersion);
    if (plan?.installedPath) writeJson(plan.installedPath, { version: plan.oldVersion, sha: plan.oldSha });
    if (plan) {
      result(plan, { state: "rolled_back", detail, version: plan.oldVersion, sha: plan.oldSha, rollback });
      // the new build may already have recorded a done result; let the old one record this instead
      rmSync(path.join(path.dirname(plan.resultPath), "consumed.json"), { force: true });
    }
    rmSync(dirs.journal, { force: true });
  }

  /** A swap cut short by a crash or power loss: undo it before anything starts,
   * unless the new build had already passed its health check. */
  function recoverInterrupted() {
    const journal = readJson(dirs.journal);
    if (!journal) return;
    const plan = journal.plan ? readJson(journal.plan) : null;
    const done = plan?.resultPath ? readJson(plan.resultPath) : null;
    if (done?.state === "done" && done.sha === plan.sha) {
      log(`update ${journal.updateId} was healthy before the launcher stopped; keeping it`);
      writeJson(dirs.feedState, { publishedAt: journal.publishedAt, commit: plan.sha });
      rmSync(dirs.journal, { force: true });
      return;
    }
    log(`found an unfinished swap for ${journal.updateId}; rolling back`);
    try { rollBack(plan, journal.rollback, journal.oldVersion, "the update was interrupted mid-swap; the previous build was restored", journal.staged); }
    catch (error) { log(`rollback of interrupted swap failed (retried next start): ${error.message}`); }
  }

  /** One handoff from the server. Returns once the server is running again. */
  async function handle(request) {
    const config = readJson(configPath);
    const plan = request?.plan ? readJson(request.plan) : null;
    rmSync(dirs.request, { force: true });
    if (!plan || !config) { log("update request without a readable plan or config; starting normally"); return false; }
    const healthSeconds = plan.healthSeconds ?? 90;
    if (plan.mode === "restart") {
      const started = await run(healthSeconds, config.port);
      const ok = await started.health;
      result(plan, ok ? { state: "done", detail: "restarted", version: plan.oldVersion, sha: plan.oldSha } : { state: "failed", detail: "restarted, but the server did not answer its health check" });
      log(`restart ${plan.updateId}: ${ok ? "healthy" : "unhealthy"}`);
      return started;
    }
    const staged = readJson(path.join(dirs.staged, "staged.json"));
    if (!staged || staged.sha !== plan.sha) {
      result(plan, { state: "failed", detail: staged ? `staged build ${String(staged.sha).slice(0, 8)} is not the planned ${plan.sha.slice(0, 8)}` : "nothing staged to install" });
      return false;
    }
    const rollback = path.join(dirs.updates, `rollback-${plan.updateId}`);
    try {
      swapIn({ resources: config.resources, staged: dirs.staged, rollback, journal: dirs.journal, updateId: plan.updateId, oldVersion: config.version, plan: request.plan, publishedAt: staged.publishedAt });
      writeJson(path.join(rollback, "rollback.json"), { at: now().toISOString(), version: config.version, sha: plan.oldSha });
      setConfigVersion(configPath, staged.version);
      writeJson(plan.installedPath, { version: staged.version, sha: staged.sha });
    } catch (error) {
      log(`swap ${plan.updateId} failed: ${error.message}; restoring`);
      try {
        rollBack(plan, rollback, config.version, `could not swap the new build in: ${error.message}`, dirs.staged);
        result(plan, { state: "failed", detail: `could not swap the new build in: ${error.message}`, version: plan.oldVersion, sha: plan.oldSha });
      } catch (inner) { log(`restore failed (retried next start): ${inner.message}`); }
      return false;
    }
    log(`swapped in ${staged.version} (${staged.sha.slice(0, 8)}); waiting up to ${healthSeconds}s for health`);
    const started = await run(healthSeconds, config.port);
    if (await started.health) {
      // Tell the new server now (it waits for this to resume turns), but keep
      // the journal: a build that dies in the stable window still goes back.
      result(plan, { state: "done", detail: `installed ${staged.version} (${staged.sha.slice(0, 8)})`, version: staged.version, sha: staged.sha, rollback });
      log(`update ${plan.updateId}: healthy; watching ${Math.round(stableMs / 1000)}s`);
      const crashed = await Promise.race([started.exited.then(code => ({ code })), sleep(stableMs).then(() => null)]);
      if (!crashed) { commit(plan, staged, rollback); log(`update ${plan.updateId}: stable`); return started; }
      log(`update ${plan.updateId}: exited (${crashed.code}) inside the stable window; rolling back`);
      rollBack(plan, rollback, config.version, `${staged.version} (${staged.sha.slice(0, 8)}) stopped right after starting; the previous build is back`);
      return false;
    }
    log(`update ${plan.updateId}: not healthy within ${healthSeconds}s; rolling back`);
    await stop(started);
    rollBack(plan, rollback, config.version, `${staged.version} (${staged.sha.slice(0, 8)}) did not pass its health check; the previous build is back`);
    return false;
  }

  async function stop(started) {
    if (!started.alive()) return;
    started.child.kill();
    const timer = setTimeout(() => { try { started.child.kill("SIGKILL"); } catch { /* gone */ } }, 10_000);
    await started.exited;
    clearTimeout(timer);
  }

  /** Forever: start the server, and when it exits either apply its handoff or restart it. */
  // Nothing in here may throw out of the loop: the launcher dying takes the
  // server with it (Windows job object), and nobody is there to restart it.
  async function loop({ once = false } = {}) {
    let backoff = 5_000;
    for (;;) {
      const config = readJson(configPath);
      if (config?.maintenanceMarker && existsSync(config.maintenanceMarker)) { await sleep(deps.maintenancePollMs ?? 10_000); continue; }
      tryTo("recovering an interrupted swap", recoverInterrupted);
      let started = false;
      try {
        const request = readJson(dirs.request);
        if (request) started = await handle(request);
      } catch (error) {
        log(`update handoff failed: ${error?.message ?? error}`);
        tryTo("clearing the update request", () => rmSync(dirs.request, { force: true }));
      }
      if (!started) {
        try { started = run(0, config?.port); }
        catch (error) { log(`server did not start: ${error?.message ?? error}`); if (once) return; await sleep(backoff); backoff = Math.min(backoff * 2, 60_000); continue; }
      }
      const startedAt = Date.now();
      const code = await started.exited;
      if (existsSync(dirs.request)) { log(`server exited (${code}) with an update request`); backoff = 5_000; if (once) return; continue; }
      if (Date.now() - startedAt > 5 * 60_000) backoff = 5_000;
      log(`server exited (${code}); restarting in ${Math.round(backoff / 1000)}s`);
      if (once) return;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  return { loop, handle, recoverInterrupted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const child = process.argv[2] === "--child";
  const configPath = path.resolve(process.argv[child ? 3 : 2] ?? "config.json");
  if (child) {
    try { await launchChild(JSON.parse(readFileSync(configPath, "utf8")), configPath); }
    catch { console.error("BOS server startup failed; inspect protected server logs."); process.exitCode = 1; }
  } else {
    await createSupervisor(configPath).loop();
  }
}
