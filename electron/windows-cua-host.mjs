// Electron-independent owner for the official Windows EmbeddedCuaDriverHost.
//
// electron/cua.mjs starts the same staged SDK from Electron main. A
// server-only install (a node process launched by a Scheduled Task in the
// user's interactive session) has no Electron, so this module owns that
// lifecycle instead:
//
//  - the staged cua-sdk.mjs + cua_driver_sdk.dll + cua-driver.exe must match
//    the build manifest and must not be writable by anyone but this user,
//    SYSTEM, Administrators or TrustedInstaller;
//  - one controller per data directory (a lease bound to pid + process start
//    time + SID + session) and no other cua-driver in this session;
//  - the daemon must be this process's direct child in the same SID and
//    interactive session, and its named pipe must be served by that pid with a
//    private DACL;
//  - a locked, disconnected or absent interactive desktop is reported as
//    unavailable, never worked around;
//  - a maintenance marker or an exhausted, persisted restart budget stops
//    starts and restarts. There is no detached daemon and no second retry loop.
//
// Agents still reach the daemon only through the server's per-turn proxy gate
// (server/local-computer-proxy.ts). The descriptor this module publishes is
// honoured by server/local-computer.ts only while attest() confirms it.
// Nothing here captures the screen, enumerates windows, clicks or types.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WINDOWS_CUA_MODE = "windows-embedded-supervised";
export const WINDOWS_CUA_DRIVER_VERSION = "0.28.2";
export const WINDOWS_CUA_ATTESTATION = Symbol.for("openmausbot.windows-cua-attestation.v1");
export const HOST_BUNDLE_ID = "com.openmausbot.app";
export const MANIFEST_FILES = Object.freeze([
  "cua-driver.exe",
  "cua-sdk/cua-sdk.mjs",
  "cua-sdk/native/cua_driver_sdk.dll",
  "cua-sdk/native/cua_driver_node_runtime.node",
]);
// Same variables electron/cua.mjs hands the embedded MCP proxy on Windows.
export const WINDOWS_MCP_ENV = Object.freeze({
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  CUA_DRIVER_EMBEDDED: "1",
  CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID,
});

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const WTS_ACTIVE = 0;
const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENVIRONMENT_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// Access-mask bits (winnt.h). Only READ_CONTROL, SYNCHRONIZE and attribute
// reads are harmless for a principal outside the trusted set.
const FILE_WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const HARMLESS_BITS = 0x80 | 0x20000 | 0x100000; // FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE

export class WindowsCuaUnavailable extends Error {
  name = "WindowsCuaUnavailable";
  constructor(reasonCode, message, options) {
    super(message, options);
    this.reasonCode = reasonCode;
  }
}

const unavailable = (reasonCode, message, cause) => new WindowsCuaUnavailable(reasonCode, message, cause ? { cause } : undefined);
const sameSid = (a, b) => typeof a === "string" && typeof b === "string" && a.toUpperCase() === b.toUpperCase();
const samePath = (a, b) => typeof a === "string" && typeof b === "string" &&
  path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const isPid = (value) => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
const isTime = (value) => Number.isSafeInteger(value) && value > 0;

function validAcl(acl) {
  return Boolean(acl && typeof acl === "object" && typeof acl.ownerSid === "string" && Array.isArray(acl.entries) &&
    acl.entries.every((entry) => entry && SID.test(entry.sid) && (entry.type === "allow" || entry.type === "deny") &&
      Number.isInteger(entry.rights) && entry.rights >= 0));
}

/** Staged resources may be read by anyone; only trusted principals may change them. */
export function aclAllowsOnlyTrustedWriters(acl, identity) {
  if (!validAcl(acl)) return false;
  const writers = [identity.sid, SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID];
  if (!writers.some((sid) => sameSid(sid, acl.ownerSid))) return false;
  return acl.entries.every((entry) => entry.type === "deny" || entry.inheritOnly === true ||
    (entry.rights & FILE_WRITE_BITS) === 0 || writers.some((sid) => sameSid(sid, entry.sid)));
}

/** Private objects: owned by this user; nobody outside user/SYSTEM/Administrators
 * (plus this logon session for pipes) holds any meaningful access. */
export function aclIsPrivate(acl, identity, { allowLogonSid = false } = {}) {
  if (!validAcl(acl) || !sameSid(acl.ownerSid, identity.sid)) return false;
  const trusted = [identity.sid, SYSTEM_SID, ADMINISTRATORS_SID, ...(allowLogonSid && identity.logonSid ? [identity.logonSid] : [])];
  return acl.entries.some((entry) => entry.type === "allow" && sameSid(entry.sid, identity.sid)) &&
    acl.entries.every((entry) => entry.type === "deny" || entry.inheritOnly === true ||
      (entry.rights & ~HARMLESS_BITS) === 0 || trusted.some((sid) => sameSid(sid, entry.sid)));
}

/** Interactive-desktop gate. Metadata only: session state and desktop names. */
export function sessionAvailability(identity, session) {
  if (!session || !Number.isInteger(session.sessionId)) return { available: false, reasonCode: "session-unknown" };
  if (session.sessionId === 0) return { available: false, reasonCode: "no-interactive-session" };
  if (session.sessionId !== identity.sessionId) return { available: false, reasonCode: "wrong-session" };
  if (session.connectState !== WTS_ACTIVE) return { available: false, reasonCode: "session-disconnected" };
  if (typeof session.windowStation !== "string" || session.windowStation.toLowerCase() !== "winsta0") {
    return { available: false, reasonCode: "no-interactive-desktop" };
  }
  if (typeof session.inputDesktop !== "string" || session.inputDesktop.toLowerCase() !== "default") {
    // OpenInputDesktop fails, or names Winlogon/Screen-saver, while locked.
    return { available: false, reasonCode: "desktop-locked" };
  }
  return { available: true, reasonCode: null };
}

function fileIdentity(fileSystem, file) {
  const stat = fileSystem.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export function sha256File(file, fileSystem = fs) {
  return createHash("sha256").update(fileSystem.readFileSync(file)).digest("hex");
}

/** Verify the packaged SDK, DLL, runtime and executable before anything loads. */
export async function verifyStagedWindowsCua({ resourcesPath, identity, probe, fileSystem = fs, hashFile = sha256File }) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) {
    throw unavailable("sdk-missing", "Computer use resources path is not configured");
  }
  const manifestPath = path.join(resourcesPath, "cua-sdk", "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fileSystem.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw unavailable("sdk-missing", "Computer use SDK manifest is missing or unreadable", error);
  }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.version !== WINDOWS_CUA_DRIVER_VERSION ||
      manifest.platform !== "win32-x64" || !manifest.files || typeof manifest.files !== "object" ||
      Object.keys(manifest.files).length !== MANIFEST_FILES.length ||
      !MANIFEST_FILES.every((name) => SHA256.test(manifest.files[name] ?? "")) ||
      (manifest.contractVersion !== undefined && typeof manifest.contractVersion !== "string")) {
    throw unavailable("sdk-integrity", "Computer use SDK manifest does not match this build");
  }
  const files = {};
  const identities = {};
  for (const name of MANIFEST_FILES) {
    const file = path.join(resourcesPath, ...name.split("/"));
    let stat;
    try {
      stat = fileSystem.lstatSync(file);
    } catch (error) {
      throw unavailable("sdk-missing", `Computer use SDK file is missing: ${name}`, error);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable("sdk-integrity", `Computer use SDK file is not a regular file: ${name}`);
    const before = fileIdentity(fileSystem, file);
    if (hashFile(file, fileSystem) !== manifest.files[name] || fileIdentity(fileSystem, file) !== before) {
      throw unavailable("sdk-integrity", `Computer use SDK file does not match the build manifest: ${name}`);
    }
    files[name] = file;
    identities[name] = before;
  }
  for (const target of [resourcesPath, path.join(resourcesPath, "cua-sdk"), path.join(resourcesPath, "cua-sdk", "native"), manifestPath, ...Object.values(files)]) {
    let acl;
    try {
      acl = await probe.acl(target);
    } catch (error) {
      throw unavailable("sdk-acl", "Computer use SDK permissions could not be verified", error);
    }
    if (!aclAllowsOnlyTrustedWriters(acl, identity)) {
      throw unavailable("sdk-acl", `Computer use SDK path is writable by an untrusted principal: ${path.basename(target)}`);
    }
  }
  return Object.freeze({
    version: manifest.version,
    contractVersion: manifest.contractVersion ?? null,
    binary: files["cua-driver.exe"],
    bundle: files["cua-sdk/cua-sdk.mjs"],
    library: files["cua-sdk/native/cua_driver_sdk.dll"],
    binarySha256: manifest.files["cua-driver.exe"],
    sdkSha256: manifest.files["cua-sdk/native/cua_driver_sdk.dll"],
    identities: Object.freeze(identities),
  });
}

/** Load the staged SDK exactly as electron/cua.mjs does in a packaged app. */
export async function loadStagedWindowsSdk(staged, environment = process.env) {
  environment.OPENMAUSBOT_CUA_SDK_LIBRARY = staged.library;
  environment.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
  return import(pathToFileURL(staged.bundle).href);
}

// ---------------------------------------------------------------------------
// Controller lease: one owner per data directory, bound to pid + start time.

function readJson(fileSystem, file) {
  try {
    return JSON.parse(fileSystem.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return undefined;
  }
}

function validLease(value) {
  return Boolean(value && value.version === 1 && isPid(value.pid) && isTime(value.startTimeMs) &&
    SID.test(value.sid ?? "") && Number.isInteger(value.sessionId) && UUID.test(value.nonce ?? ""));
}

async function leaseOwnerAlive(probe, lease) {
  const owner = await probe.processInfo(lease.pid);
  return Boolean(owner && owner.startTimeMs === lease.startTimeMs && sameSid(owner.ownerSid, lease.sid));
}

export async function acquireControllerLease({ directory, record, probe, fileSystem = fs }) {
  const leasePath = path.join(directory, "controller.lease");
  const candidate = `${leasePath}.${record.nonce}.candidate`;
  fileSystem.writeFileSync(candidate, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fileSystem.linkSync(candidate, leasePath);
        return leasePath;
      } catch (error) {
        if (error?.code !== "EEXIST") throw unavailable("controller-lease", "Computer use controller lease could not be created", error);
      }
      const current = readJson(fileSystem, leasePath);
      if (current === null) continue;
      if (!validLease(current)) throw unavailable("controller-lease", "Computer use controller lease is invalid; refusing to take over");
      if (await leaseOwnerAlive(probe, current)) {
        throw unavailable("controller-busy", `Another computer-use controller (process ${current.pid}) owns this workspace`);
      }
      // Stale: move exactly that record aside, then confirm it was the one judged.
      const tombstone = `${leasePath}.stale-${current.nonce}`;
      try {
        fileSystem.renameSync(leasePath, tombstone);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw unavailable("controller-lease", "Stale computer-use controller lease could not be retired", error);
      }
      const moved = readJson(fileSystem, tombstone);
      if (moved?.nonce !== current.nonce) {
        // A newer owner replaced the stale record between read and rename. Put
        // it back and stand down rather than guess.
        try { fileSystem.linkSync(tombstone, leasePath); } catch { /* the newer owner will fail its own lease check */ }
        try { fileSystem.unlinkSync(tombstone); } catch { /* best effort */ }
        throw unavailable("controller-busy", "Another computer-use controller is starting for this workspace");
      }
      fileSystem.unlinkSync(tombstone);
    }
    throw unavailable("controller-busy", "Computer use controller lease is contended");
  } finally {
    try { fileSystem.unlinkSync(candidate); } catch { /* already gone */ }
  }
}

function leaseStillOurs(fileSystem, leasePath, nonce) {
  const current = readJson(fileSystem, leasePath);
  return Boolean(current && current.nonce === nonce);
}

// ---------------------------------------------------------------------------
// Persisted circuit breaker: Task Scheduler restarts must not reset it.

function readCircuit(fileSystem, file, now) {
  const value = readJson(fileSystem, file);
  if (value === null) return { version: 1, failures: [], openUntil: 0 };
  if (!value || value.version !== 1 || !Array.isArray(value.failures) || !value.failures.every(isTime) ||
      !Number.isSafeInteger(value.openUntil) || value.openUntil < 0) {
    // Unreadable state holds the circuit open instead of granting fresh retries.
    return { version: 1, failures: [], openUntil: now + 1 };
  }
  return value;
}

function writeDurable(fileSystem, file, value, nonce = randomUUID()) {
  const temporary = `${file}.${nonce}.tmp`;
  try {
    const handle = fileSystem.openSync(temporary, "wx", 0o600);
    try {
      fileSystem.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fileSystem.fsyncSync(handle);
    } finally {
      fileSystem.closeSync(handle);
    }
    fileSystem.renameSync(temporary, file);
  } catch (error) {
    try { fileSystem.unlinkSync(temporary); } catch { /* not created */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------

const SESSION_WAIT_CODES = new Set(["desktop-locked", "session-disconnected", "no-interactive-desktop", "no-interactive-session"]);

/**
 * One owned embedded host for one data directory. start() never throws;
 * every refusal becomes an unavailable status with a reason code. All
 * lifecycle work (start, daemon exit, session polls, stop) runs on one queue,
 * so there is exactly one owner of the daemon at any moment.
 */
export function createWindowsCuaHost({
  dataDir,
  resourcesPath,
  environmentId,
  maintenanceMarker,
  platform = process.platform,
  probe = createPowerShellWindowsProbe(),
  loadSdk = loadStagedWindowsSdk,
  fileSystem = fs,
  hashFile = sha256File,
  now = Date.now,
  nonce = randomUUID,
  isProcessAlive = processAlive,
  selfPid = process.pid,
  restartBudget = { max: 2, windowMs: 10 * 60_000, cooldownMs: 30 * 60_000 },
  sessionPollMs = 15_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
} = {}) {
  const privateDir = typeof dataDir === "string" && path.isAbsolute(dataDir) ? path.join(dataDir, "cua-windows") : null;
  const descriptorPath = privateDir ? path.join(privateDir, "cua-connection.json") : null;
  const circuitPath = privateDir ? path.join(privateDir, "circuit.json") : null;
  const listeners = new Set();
  let state = "stopped";
  let reasonCode = null;
  let message = null;
  let identity = null;
  let staged = null;
  let sdk = null;
  let host = null;
  let hostAbort = null;
  let connection = null;
  let descriptor = null;
  let descriptorIdentity = null;
  let lease = null; // { path, nonce }
  let instanceNonce = null;
  let selfStartTimeMs = null;
  let sessionAvailable = false;
  let timer = null;
  let epoch = 0;
  let queue = Promise.resolve();

  const serial = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const notify = () => {
    const snapshot = status();
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* observers never steer lifecycle */ }
    }
  };
  const set = (nextState, code = null, text = null) => {
    state = nextState;
    reasonCode = code;
    message = text;
    notify();
  };
  const maintenance = () => typeof maintenanceMarker === "string" && fileSystem.existsSync(maintenanceMarker);
  const assertCurrent = (expected) => {
    if (expected !== epoch) throw unavailable("stopping", "Computer-use host is stopping");
    if (maintenance()) throw unavailable("maintenance", "Maintenance is in progress");
  };

  function status() {
    return Object.freeze({
      state,
      reasonCode,
      message,
      generation: connection?.generation ?? null,
      serviceHealth: state === "ready" ? "ok" : "unavailable",
      capabilityAdvertised: state === "ready" && sessionAvailable,
      sessionAvailable,
      // Only an authorized, isolated acceptance run establishes this. Readiness never implies it.
      actionVerified: false,
    });
  }

  function revoke(code) {
    // Only the lease holder may touch the file: a contender that lost the lease
    // must not clobber the owner's live descriptor.
    const hadDescriptor = descriptor !== null || (lease !== null && descriptorPath !== null && fileSystem.existsSync(descriptorPath));
    descriptor = null;
    descriptorIdentity = null;
    if (!hadDescriptor) return;
    try {
      writeDurable(fileSystem, descriptorPath, { schemaVersion: 1, mode: "unavailable", reasonCode: code }, nonce());
    } catch (error) {
      // Never leave a usable descriptor behind a failed revocation.
      try { fileSystem.unlinkSync(descriptorPath); } catch { /* missing is revoked */ }
      log("[cua-win] descriptor revocation fell back to unlink", error);
    }
  }

  /** Record one daemon failure; true when the persisted circuit is open. */
  function recordFailure() {
    const current = readCircuit(fileSystem, circuitPath, now());
    const cutoff = now() - restartBudget.windowMs;
    const failures = [...current.failures.filter((at) => at >= cutoff), now()];
    const openUntil = failures.length > restartBudget.max ? now() + restartBudget.cooldownMs : current.openUntil;
    try {
      writeDurable(fileSystem, circuitPath, { version: 1, failures, openUntil }, nonce());
    } catch (error) {
      log("[cua-win] circuit write failed", error);
      return true;
    }
    return openUntil > now();
  }

  function clearTimerIfAny() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function schedule(task) {
    clearTimerIfAny();
    const expected = epoch;
    timer = setTimer(() => {
      timer = null;
      if (expected === epoch) serial(() => (expected === epoch ? task() : undefined));
    }, sessionPollMs);
    timer?.unref?.();
  }

  async function destroyHost() {
    const owned = host;
    host = null;
    connection = null;
    hostAbort?.abort();
    hostAbort = null;
    if (!owned) return;
    try { await owned.stop(); } catch (error) { log("[cua-win] host stop failed", error); }
    try { owned.uniffiDestroy?.(); } catch { /* already destroyed */ }
  }

  function releaseLease() {
    if (lease && leaseStillOurs(fileSystem, lease.path, lease.nonce)) {
      try { fileSystem.unlinkSync(lease.path); } catch { /* the next owner will find it stale */ }
    }
    lease = null;
  }

  async function teardown(code) {
    clearTimerIfAny();
    sessionAvailable = false;
    // Revoke before the daemon goes away so no turn picks up a dying pipe.
    revoke(code);
    await destroyHost();
    releaseLease();
  }

  async function verifySession() {
    const [who, session] = await Promise.all([probe.identity(), probe.session()]);
    if (!who || !SID.test(who.sid ?? "") || !Number.isInteger(who.sessionId)) {
      throw unavailable("identity-unknown", "Windows user identity could not be read");
    }
    if (identity && (!sameSid(identity.sid, who.sid) || identity.sessionId !== who.sessionId)) {
      throw unavailable("wrong-session", "Windows user or session changed under the computer-use host");
    }
    const gate = sessionAvailability(who, session);
    if (!gate.available) throw unavailable(gate.reasonCode, "No unlocked interactive Windows desktop is available for computer use");
    return who;
  }

  async function verifyDaemon(conn) {
    if (!conn || typeof conn.socketPath !== "string" || !conn.socketPath.startsWith("\\\\.\\pipe\\") ||
        !isPid(conn.pid) || typeof conn.generation !== "string" || !conn.generation ||
        conn.driverVersion !== staged.version || typeof conn.contractVersion !== "string" || !conn.contractVersion ||
        (staged.contractVersion && conn.contractVersion !== staged.contractVersion) ||
        typeof conn.mcpProtocolVersion !== "string" || !conn.mcpProtocolVersion) {
      throw unavailable("driver-mismatch", "Embedded computer-use driver reported an unexpected connection");
    }
    const daemon = await probe.processInfo(conn.pid);
    if (!daemon || !isTime(daemon.startTimeMs)) throw unavailable("daemon-missing", "Embedded computer-use daemon is not running");
    if (daemon.parentPid !== selfPid || !samePath(daemon.executablePath, staged.binary)) {
      throw unavailable("daemon-substituted", "Computer-use daemon is not this host's staged child process");
    }
    if (!sameSid(daemon.ownerSid, identity.sid)) throw unavailable("wrong-sid", "Computer-use daemon runs as a different Windows user");
    if (daemon.sessionId !== identity.sessionId) throw unavailable("wrong-session", "Computer-use daemon runs in a different Windows session");
    const pipe = await probe.pipeInfo(conn.socketPath);
    if (!pipe || pipe.serverPid !== conn.pid) throw unavailable("pipe-substituted", "Computer-use pipe is not served by the owned daemon");
    if (!aclIsPrivate(pipe, identity, { allowLogonSid: true })) throw unavailable("pipe-acl", "Computer-use pipe is accessible to other principals");
    return daemon;
  }

  async function publish(conn, daemon) {
    const next = {
      schemaVersion: 1,
      mode: WINDOWS_CUA_MODE,
      platform: "win32",
      environmentId,
      instanceNonce,
      generation: conn.generation,
      owner: { pid: selfPid, startTimeMs: selfStartTimeMs, sid: identity.sid, sessionId: identity.sessionId },
      daemon: {
        pid: conn.pid,
        startTimeMs: daemon.startTimeMs,
        socketPath: conn.socketPath,
        driverVersion: conn.driverVersion,
        contractVersion: conn.contractVersion,
        mcpProtocolVersion: conn.mcpProtocolVersion,
      },
      driver: { path: staged.binary, version: staged.version, sha256: staged.binarySha256, sdkSha256: staged.sdkSha256 },
      mcp: { command: staged.binary, args: ["mcp", "--embedded", "--socket", conn.socketPath], env: { ...WINDOWS_MCP_ENV } },
    };
    writeDurable(fileSystem, descriptorPath, next, nonce());
    for (const target of [privateDir, descriptorPath]) {
      if (!aclIsPrivate(await probe.acl(target), identity)) {
        throw unavailable("descriptor-acl", "Computer-use descriptor is accessible to other principals");
      }
    }
    descriptor = next;
    descriptorIdentity = fileIdentity(fileSystem, descriptorPath);
  }

  /** Start one daemon under the held lease, verify it, publish its descriptor. */
  async function launchDaemon(expected) {
    assertCurrent(expected);
    identity = await verifySession();
    // Re-verify on every launch: a restart must not trust a binary swapped since boot.
    staged = await verifyStagedWindowsCua({ resourcesPath, identity, probe, fileSystem, hashFile });
    const others = (await probe.processesNamed("cua-driver.exe"))
      .filter((entry) => entry?.sessionId === identity.sessionId && entry.parentPid !== selfPid);
    if (others.length) throw unavailable("another-controller", "Another computer-use driver is already active in this Windows session");
    try {
      sdk ??= await loadSdk(staged);
    } catch (error) {
      throw unavailable("sdk-load-failed", "Computer use SDK could not be loaded", error);
    }
    if (typeof sdk?.EmbeddedCuaDriverHost !== "function") throw unavailable("sdk-load-failed", "Computer use SDK does not export EmbeddedCuaDriverHost");
    assertCurrent(expected);
    const owned = new sdk.EmbeddedCuaDriverHost(staged.binary, HOST_BUNDLE_ID);
    const abort = new AbortController();
    host = owned;
    hostAbort = abort;
    let conn;
    try {
      conn = await owned.start({ signal: abort.signal });
    } catch (error) {
      await destroyHost();
      if (expected !== epoch) throw unavailable("stopping", "Computer-use host is stopping");
      throw unavailable("daemon-start-failed", "Embedded computer-use daemon failed to start", error);
    }
    connection = conn;
    try {
      assertCurrent(expected);
      const daemon = await verifyDaemon(conn);
      assertCurrent(expected);
      await publish(conn, daemon);
      assertCurrent(expected);
    } catch (error) {
      revoke(error?.reasonCode ?? "verification-failed");
      await destroyHost();
      throw error;
    }
    sessionAvailable = true;
    watchExit(owned, conn.generation, abort.signal, expected);
    schedule(poll);
  }

  function watchExit(owned, generation, signal, expected) {
    if (typeof owned.waitForExit !== "function") return;
    owned.waitForExit(generation, { signal }).then(
      (exit) => serial(() => (host === owned && expected === epoch && !signal.aborted ? handleExit(exit) : undefined)),
      () => { /* aborted by stop */ },
    );
  }

  async function handleExit(exit) {
    log("[cua-win] embedded daemon exited", exit);
    const expected = epoch;
    sessionAvailable = false;
    revoke("daemon-exited");
    host = null;
    connection = null;
    hostAbort = null;
    if (maintenance()) return fail(unavailable("maintenance", "Maintenance is in progress"));
    if (recordFailure()) return fail(unavailable("restart-budget-exhausted", "Computer-use daemon kept exiting; restart budget exhausted"));
    set("starting");
    try {
      await launchDaemon(expected);
      set("ready");
    } catch (error) {
      await fail(error, { countDaemonFailure: true });
    }
  }

  async function fail(error, { countDaemonFailure = false } = {}) {
    let code = error?.reasonCode ?? "start-failed";
    if (code === "stopping") return;
    if (countDaemonFailure && code === "daemon-start-failed" && recordFailure()) code = "restart-budget-exhausted";
    await teardown(code);
    const nextState = code === "maintenance" ? "maintenance" : code === "restart-budget-exhausted" ? "circuit-open" : "unavailable";
    set(nextState, code, error?.message ?? String(error));
    // A locked or disconnected desktop is waited out by metadata polling only;
    // nothing is started until the session is interactive again.
    if (nextState === "unavailable" && SESSION_WAIT_CODES.has(code)) schedule(() => startInternal());
  }

  async function poll() {
    if (state !== "ready") return;
    const expected = epoch;
    try {
      assertCurrent(expected);
      await verifySession();
      if (!sessionAvailable) {
        // Unlocked again: the same daemon must prove itself before re-publishing.
        const daemon = await verifyDaemon(connection);
        assertCurrent(expected);
        await publish(connection, daemon);
        sessionAvailable = true;
        set("ready");
      }
    } catch (error) {
      const code = error?.reasonCode ?? "session-probe-failed";
      if (code === "stopping") return;
      if (code === "maintenance" || code === "wrong-session") return fail(error);
      sessionAvailable = false;
      revoke(code);
      set("ready", code, error?.message ?? String(error));
    }
    schedule(poll);
  }

  async function startInternal() {
    const expected = epoch;
    if (platform !== "win32") return set("unavailable", "unsupported-platform", "Server-only computer use requires Windows");
    if (!privateDir || typeof environmentId !== "string" || !ENVIRONMENT_ID.test(environmentId)) {
      return set("unavailable", "invalid-config", "Computer use host configuration is invalid");
    }
    if (maintenance()) return set("maintenance", "maintenance", "Maintenance is in progress");
    set("starting");
    try {
      fileSystem.mkdirSync(privateDir, { recursive: true });
      if (readCircuit(fileSystem, circuitPath, now()).openUntil > now()) {
        throw unavailable("restart-budget-exhausted", "Computer-use restart budget is exhausted; waiting for cooldown");
      }
      identity = null;
      identity = await verifySession();
      await probe.restrictDirectory(privateDir, identity.sid);
      if (!aclIsPrivate(await probe.acl(privateDir), identity)) {
        throw unavailable("descriptor-acl", "Computer-use state directory is accessible to other principals");
      }
      const self = await probe.processInfo(selfPid);
      if (!self || !isTime(self.startTimeMs) || !sameSid(self.ownerSid, identity.sid) || self.sessionId !== identity.sessionId) {
        throw unavailable("wrong-session", "Computer-use host process identity does not match this session");
      }
      selfStartTimeMs = self.startTimeMs;
      instanceNonce = nonce();
      assertCurrent(expected);
      const record = { version: 1, pid: selfPid, startTimeMs: selfStartTimeMs, sid: identity.sid, sessionId: identity.sessionId, nonce: instanceNonce, environmentId };
      lease = { path: await acquireControllerLease({ directory: privateDir, probe, fileSystem, record }), nonce: instanceNonce };
      // A descriptor left by a crashed predecessor is retired before anything starts.
      revoke("starting");
      await launchDaemon(expected);
      set("ready");
    } catch (error) {
      await fail(error);
    }
  }

  return Object.freeze({
    descriptorPath,
    status,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      return serial(async () => {
        // startInternal re-checks the maintenance marker and the persisted circuit.
        if (["stopped", "unavailable", "maintenance", "circuit-open"].includes(state)) await startInternal();
        return status();
      });
    },
    async stop() {
      epoch++;
      clearTimerIfAny();
      hostAbort?.abort();
      if (state !== "stopped") set("stopping");
      return serial(async () => {
        await teardown("desktop-host-stopped");
        set("stopped");
        return status();
      });
    },
    /** Synchronous check for server/local-computer.ts; cheap and fail-closed. */
    attest(file, raw) {
      try {
        if (state !== "ready" || !sessionAvailable || !descriptor || !connection || !host || !lease) return false;
        if (!samePath(file, descriptorPath) || JSON.stringify(raw) !== JSON.stringify(descriptor)) return false;
        if (fileIdentity(fileSystem, descriptorPath) !== descriptorIdentity) return false;
        if (JSON.stringify(readJson(fileSystem, descriptorPath)) !== JSON.stringify(descriptor)) return false;
        if (fileIdentity(fileSystem, staged.binary) !== staged.identities["cua-driver.exe"]) return false;
        if (!leaseStillOurs(fileSystem, lease.path, lease.nonce) || maintenance()) return false;
        return isProcessAlive(connection.pid) && isProcessAlive(selfPid);
      } catch {
        return false;
      }
    },
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Expose attest() to server/local-computer.ts in this process. Installed once;
 * later code cannot replace it. */
export function installWindowsCuaAttestation(host, target = globalThis) {
  if (Object.prototype.hasOwnProperty.call(target, WINDOWS_CUA_ATTESTATION)) {
    throw new Error("Windows computer-use attestation is already installed in this process");
  }
  Object.defineProperty(target, WINDOWS_CUA_ATTESTATION, {
    value: Object.freeze({ attest: (file, raw) => host.attest(file, raw) }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

// ---------------------------------------------------------------------------
// Server-only launcher integration.

/** Environment the server needs to find (only) the supervised descriptor. */
export function serverOnlyCuaEnvironment(descriptorPath) {
  return { OMB_CUA_WINDOWS_SUPERVISED: "1", OMB_CUA_WINDOWS_DESCRIPTOR: descriptorPath };
}

/**
 * Start the owned host inside the launcher process, before the server module
 * loads. Opt-in through config.computerUse === true. Returns null when off.
 * Signals stop the host (revoking its descriptor) before the process exits;
 * the daemon's parent-liveness pipe covers a hard kill.
 */
export async function startServerOnlyWindowsCua(config, {
  createHost = createWindowsCuaHost,
  install = installWindowsCuaAttestation,
  processRef = process,
} = {}) {
  if (config?.computerUse !== true) return null;
  const host = createHost({
    dataDir: config.dataDir,
    resourcesPath: config.resources,
    environmentId: config.environmentId,
    maintenanceMarker: config.maintenanceMarker,
  });
  install(host);
  const env = serverOnlyCuaEnvironment(host.descriptorPath);
  let stopping = null;
  const stopAndExit = (signal) => {
    stopping ??= host.stop().catch(() => {}).finally(() => processRef.exit(signal === "SIGINT" ? 130 : 0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) processRef.once(signal, () => stopAndExit(signal));
  await host.start();
  return { host, env };
}

// ---------------------------------------------------------------------------
// Real probe: one short PowerShell call per question. Metadata only.

const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$req = $env:OMB_CUA_PROBE_REQUEST | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class OmbCuaProbe {
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr s, int id, int cls, out IntPtr buf, out int n);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int i, StringBuilder b, int len, out int need);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr h, out uint pid);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr h, int t, int i, out IntPtr o, out IntPtr g, out IntPtr d, out IntPtr s, out IntPtr sd);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd, uint r, int i, out IntPtr str, out uint n);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  static string Name(IntPtr h) { var b = new StringBuilder(256); int n; return GetUserObjectInformation(h, 2, b, b.Capacity * 2, out n) ? b.ToString() : null; }
  public static int ConnectState(int id) { IntPtr b; int n; if (!WTSQuerySessionInformation(IntPtr.Zero, id, 8, out b, out n)) return -1; try { return Marshal.ReadInt32(b); } finally { WTSFreeMemory(b); } }
  public static string InputDesktop() { IntPtr h = OpenInputDesktop(0, false, 0x0001); if (h == IntPtr.Zero) return null; try { return Name(h); } finally { CloseDesktop(h); } }
  public static string WindowStation() { return Name(GetProcessWindowStation()); }
  public static string Pipe(string path, out uint pid) {
    pid = 0;
    IntPtr h = CreateFile(path, 0x00020080, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return null;
    try {
      if (!GetNamedPipeServerProcessId(h, out pid)) return null;
      IntPtr o, g, d, s, sd;
      if (GetSecurityInfo(h, 1, 5, out o, out g, out d, out s, out sd) != 0) return null;
      try { IntPtr str; uint n; if (!ConvertSecurityDescriptorToStringSecurityDescriptor(sd, 1, 5, out str, out n)) return null; try { return Marshal.PtrToStringUni(str); } finally { LocalFree(str); } }
      finally { LocalFree(sd); }
    } finally { CloseHandle(h); }
  }
}
'@
function Acl($sddl) {
  if (-not $sddl) { return $null }
  $sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
  $entries = @(foreach ($ace in $sd.DiscretionaryAcl) {
    if ($ace -is [System.Security.AccessControl.CommonAce]) {
      [ordered]@{ sid = $ace.SecurityIdentifier.Value; type = $(if ($ace.AceQualifier -eq 'AccessAllowed') { 'allow' } else { 'deny' }); rights = [int64]([uint32]$ace.AccessMask); inheritOnly = [bool]($ace.AceFlags -band [System.Security.AccessControl.AceFlags]::InheritOnly) }
    } else { [ordered]@{ sid = 'S-1-0-0'; type = 'allow'; rights = 4294967295; inheritOnly = $false } }
  })
  [ordered]@{ ownerSid = $sd.Owner.Value; entries = $entries }
}
function Proc($p) {
  if (-not $p) { return $null }
  $owner = (Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid
  [ordered]@{ pid = [int]$p.ProcessId; parentPid = [int]$p.ParentProcessId; sessionId = [int]$p.SessionId; ownerSid = $owner; executablePath = $p.ExecutablePath; startTimeMs = [int64](([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()) }
}
$out = switch ($req.op) {
  'identity' { $id = [System.Security.Principal.WindowsIdentity]::GetCurrent(); [ordered]@{ sid = $id.User.Value; userName = $id.Name; sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; logonSid = @($id.Groups | Where-Object { $_.Value -like 'S-1-5-5-*' } | Select-Object -First 1 | ForEach-Object { $_.Value })[0] } }
  'session' { $sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; [ordered]@{ sessionId = $sid; connectState = [OmbCuaProbe]::ConnectState($sid); windowStation = [OmbCuaProbe]::WindowStation(); inputDesktop = [OmbCuaProbe]::InputDesktop() } }
  'processInfo' { Proc (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$req.pid)) }
  'processesNamed' { @(Get-CimInstance Win32_Process -Filter ("Name='" + ($req.name -replace "'", "") + "'") | ForEach-Object { Proc $_ }) }
  'acl' { Acl (Get-Acl -LiteralPath $req.path).Sddl }
  'pipeInfo' { $serverPid = [uint32]0; $sddl = [OmbCuaProbe]::Pipe($req.path, [ref]$serverPid); if ($sddl) { $a = Acl $sddl; $a.serverPid = [int]$serverPid; $a } else { $null } }
  default { throw 'unknown probe op' }
}
ConvertTo-Json -InputObject $out -Depth 6 -Compress
`;

export function createPowerShellWindowsProbe({ run = execFile, timeoutMs = 10_000, environment = process.env } = {}) {
  const powershell = path.win32.join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const call = (request) => new Promise((resolve, reject) => {
    const child = run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      env: { ...environment, OMB_CUA_PROBE_REQUEST: JSON.stringify(request) },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1 << 20,
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout) => {
      if (error) return reject(unavailable("probe-failed", `Windows ${request.op} probe failed`, error));
      try {
        const text = String(stdout).trim();
        resolve(text === "" || text === "null" ? null : JSON.parse(text));
      } catch (parseError) {
        reject(unavailable("probe-failed", `Windows ${request.op} probe returned invalid output`, parseError));
      }
    });
    child?.stdin?.end(PROBE_SCRIPT);
  });
  const restrict = (directory, sid) => new Promise((resolve, reject) => {
    if (!SID.test(sid)) return reject(unavailable("identity-unknown", "Invalid SID"));
    const icacls = path.win32.join(environment.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    run(icacls, [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`], {
      timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1 << 16,
    }, (error) => (error ? reject(unavailable("descriptor-acl", "Computer-use state directory could not be made private", error)) : resolve()));
  });
  return Object.freeze({
    identity: () => call({ op: "identity" }),
    session: () => call({ op: "session" }),
    processInfo: (pid) => call({ op: "processInfo", pid }),
    // PowerShell's switch unrolls arrays: none is null, one is a bare object.
    processesNamed: async (name) => {
      const found = await call({ op: "processesNamed", name });
      return Array.isArray(found) ? found : found ? [found] : [];
    },
    acl: (target) => call({ op: "acl", path: target }),
    pipeInfo: (pipePath) => call({ op: "pipeInfo", path: pipePath }),
    restrictDirectory: restrict,
  });
}
