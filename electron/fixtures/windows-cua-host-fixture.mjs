// Inert Windows fixture for electron/windows-cua-host.mjs: fake metadata
// probe, fake official SDK host and staged files with a real manifest. No
// process is spawned and nothing observes or drives a desktop.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_FILES, createWindowsCuaHost } from "../windows-cua-host.mjs";

export const USER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
export const OTHER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1002";
export const LOGON_SID = "S-1-5-5-0-424242";
export const SELF_PID = 4100;
export const SESSION_ID = 2;
const FULL = 0x1f01ff;
const READ_EXECUTE = 0x1200a9;

export const privateAcl = (owner = USER_SID, extra = []) => ({
  ownerSid: owner,
  entries: [{ sid: USER_SID, type: "allow", rights: FULL }, { sid: "S-1-5-18", type: "allow", rights: FULL }, ...extra],
});
export const resourceAcl = (extra = []) => ({
  ownerSid: USER_SID,
  entries: [
    { sid: USER_SID, type: "allow", rights: FULL },
    { sid: "S-1-5-18", type: "allow", rights: FULL },
    { sid: "S-1-5-32-544", type: "allow", rights: FULL },
    { sid: "S-1-5-32-545", type: "allow", rights: READ_EXECUTE },
    ...extra,
  ],
});

export const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
};

export function createFixture({ contractVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omb-cua-win-host-"));
  const resources = join(root, "resources");
  const dataDir = join(root, "data");
  mkdirSync(join(resources, "cua-sdk", "native"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const files = {};
  for (const name of MANIFEST_FILES) {
    const file = join(resources, ...name.split("/"));
    writeFileSync(file, `inert fixture ${name}\n`);
    files[name] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  writeFileSync(join(resources, "cua-sdk", "manifest.json"), JSON.stringify({
    schemaVersion: 1, platform: "win32-x64", version: "0.28.2", files, ...(contractVersion ? { contractVersion } : {}),
  }));
  const binary = join(resources, "cua-driver.exe");
  const calls = [];
  const state = {
    identity: { sid: USER_SID, userName: "PARTNERHOST\\owner", sessionId: SESSION_ID, logonSid: LOGON_SID },
    session: { sessionId: SESSION_ID, connectState: 0, windowStation: "WinSta0", inputDesktop: "Default" },
    processes: new Map([[SELF_PID, { pid: SELF_PID, parentPid: 1, sessionId: SESSION_ID, ownerSid: USER_SID, executablePath: "C:\\node\\node.exe", startTimeMs: 1_000 }]]),
    acl: new Map(),
    defaultResourceAcl: resourceAcl(),
    defaultPrivateAcl: privateAcl(),
    pipes: new Map(),
    daemon: {},
    pipeOverride: null,
    pipeExtraEntries: [],
    startError: null,
    startGate: null,
    loadError: null,
  };
  const privateDir = join(dataDir, "cua-windows");
  const probe = {
    identity: async () => { calls.push("identity"); return { ...state.identity }; },
    session: async () => { calls.push("session"); return { ...state.session }; },
    processInfo: async (pid) => { calls.push(`processInfo:${pid}`); return state.processes.has(pid) ? { ...state.processes.get(pid) } : null; },
    processesNamed: async (name) => {
      calls.push(`processesNamed:${name}`);
      return [...state.processes.values()].filter((entry) => entry.executablePath.toLowerCase().endsWith(name.toLowerCase()));
    },
    acl: async (target) => {
      calls.push("acl");
      if (state.acl.has(target)) return state.acl.get(target);
      return target.startsWith(privateDir) ? state.defaultPrivateAcl : state.defaultResourceAcl;
    },
    pipeInfo: async (pipe) => {
      calls.push("pipeInfo");
      return state.pipeOverride ?? state.pipes.get(pipe) ?? null;
    },
    restrictDirectory: async (directory, sid) => { calls.push(`restrict:${sid}`); },
  };
  const hosts = [];
  let nextPid = 7000;
  class EmbeddedCuaDriverHost {
    constructor(binaryPath, bundleId) {
      this.binaryPath = binaryPath;
      this.bundleId = bundleId;
      this.events = [];
      this.destroyed = false;
      hosts.push(this);
    }
    async start({ signal }) {
      if (state.startGate) {
        await new Promise((resolve, reject) => {
          state.startGate = resolve;
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      if (state.startError) throw state.startError;
      const pid = nextPid++;
      state.processes.set(pid, {
        pid, parentPid: SELF_PID, sessionId: SESSION_ID, ownerSid: USER_SID, executablePath: this.binaryPath, startTimeMs: 2_000 + pid, ...state.daemon,
      });
      this.connection = {
        socketPath: `\\\\.\\pipe\\cua-driver-embedded-${pid}`,
        pid,
        generation: `generation-${pid}`,
        driverVersion: "0.28.2",
        contractVersion: "1.0.0",
        mcpProtocolVersion: "2025-06-18",
        mcp: { command: this.binaryPath, args: [], environment: [] },
      };
      state.pipes.set(this.connection.socketPath, { serverPid: pid, ...privateAcl(USER_SID, [{ sid: LOGON_SID, type: "allow", rights: FULL }, ...state.pipeExtraEntries]) });
      return this.connection;
    }
    waitForExit(generation, { signal }) {
      return new Promise((resolve, reject) => {
        this.exit = (success = false) => {
          state.processes.delete(this.connection.pid);
          resolve({ generation, success, code: success ? 0 : 1 });
        };
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    async stop() {
      let descriptorMode = "absent";
      try { descriptorMode = JSON.parse(readFileSync(join(privateDir, "cua-connection.json"), "utf8")).mode; } catch { /* absent */ }
      this.events.push(`stop:descriptor=${descriptorMode}`);
      if (this.connection) state.processes.delete(this.connection.pid);
    }
    uniffiDestroy() { this.destroyed = true; }
    static withOptions(options) {
      const host = new EmbeddedCuaDriverHost(options.binaryPath, options.hostBundleId);
      host.options = options;
      return host;
    }
  }
  // Mirrors the staged Windows bundle, which exports only the host class.
  const sdk = { EmbeddedCuaDriverHost };
  const loads = [];
  const loadSdk = async (staged) => {
    loads.push(staged);
    if (state.loadError) throw state.loadError;
    return sdk;
  };
  const timers = [];
  const setTimer = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  const clearTimer = (timer) => { if (timer) timer.cleared = true; };
  const runTimers = async () => {
    const due = timers.splice(0).filter((timer) => !timer.cleared);
    for (const timer of due) timer.fn();
    await settle();
  };
  let clock = 10_000_000;
  const maintenanceMarker = join(root, "maintenance.lock");
  const make = (overrides = {}) => createWindowsCuaHost({
    dataDir,
    resourcesPath: resources,
    environmentId: "00000000-0000-4000-8000-000000000001",
    maintenanceMarker,
    platform: "win32",
    probe,
    loadSdk,
    now: () => clock,
    isProcessAlive: (pid) => state.processes.has(pid),
    selfPid: SELF_PID,
    restartBudget: { max: 2, windowMs: 60_000, cooldownMs: 600_000 },
    setTimer,
    clearTimer,
    ...overrides,
  });
  return {
    root, resources, dataDir, privateDir, binary, maintenanceMarker, state, probe, calls, hosts, loads, timers, runTimers, make,
    advance(ms) { clock += ms; },
    descriptorPath: join(privateDir, "cua-connection.json"),
    leasePath: join(privateDir, "controller.lease"),
    readDescriptor() { return JSON.parse(readFileSync(join(privateDir, "cua-connection.json"), "utf8")); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}
