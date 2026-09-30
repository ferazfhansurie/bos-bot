import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  HOST_BUNDLE_ID,
  WINDOWS_CUA_ATTESTATION,
  WINDOWS_CUA_MODE,
  WINDOWS_MCP_ENV,
  aclAllowsOnlyTrustedWriters,
  aclIsPrivate,
  createPowerShellWindowsProbe,
  installWindowsCuaAttestation,
  sessionAvailability,
  startServerOnlyWindowsCua,
} from "./windows-cua-host.mjs";
import {
  LOGON_SID, OTHER_SID, SELF_PID, SESSION_ID, USER_SID, createFixture, privateAcl, resourceAcl, settle,
} from "./fixtures/windows-cua-host-fixture.mjs";

const EVERYONE_READ = { sid: "S-1-1-0", type: "allow", rights: 0x120089 };
const USERS_WRITE = { sid: "S-1-5-32-545", type: "allow", rights: 0x1301bf };
const ALLOWED_PROBES = /^(identity|session|processInfo:\d+|processesNamed:cua-driver\.exe|acl|pipeInfo|restrict:S-1-[\d-]+)$/;

let fx;
beforeEach(() => { fx = createFixture(); });
afterEach(() => fx.cleanup());

async function ready(host = fx.make()) {
  const status = await host.start();
  assert.equal(status.state, "ready", `${status.reasonCode}: ${status.message}`);
  return host;
}

test("happy path publishes one exact supervised descriptor that attest() accepts", async () => {
  const host = await ready();
  const status = host.status();
  assert.equal(status.serviceHealth, "ok");
  assert.equal(status.capabilityAdvertised, true);
  assert.equal(status.actionVerified, false, "readiness never implies a verified action");
  assert.equal(fx.hosts.length, 1);
  assert.equal(fx.hosts[0].binaryPath, fx.binary);
  assert.equal(fx.hosts[0].bundleId, HOST_BUNDLE_ID);
  assert.equal(fx.loads[0].library, join(fx.resources, "cua-sdk", "native", "cua_driver_sdk.dll"));
  const descriptor = fx.readDescriptor();
  const pipe = fx.hosts[0].connection.socketPath;
  assert.deepEqual(Object.keys(descriptor).sort(), ["daemon", "driver", "environmentId", "generation", "instanceNonce", "mcp", "mode", "owner", "platform", "schemaVersion"]);
  assert.equal(descriptor.mode, WINDOWS_CUA_MODE);
  assert.deepEqual(descriptor.owner, { pid: SELF_PID, startTimeMs: 1_000, sid: USER_SID, sessionId: SESSION_ID });
  assert.deepEqual(descriptor.mcp, { command: fx.binary, args: ["mcp", "--embedded", "--socket", pipe], env: { ...WINDOWS_MCP_ENV } });
  assert.equal(descriptor.driver.path, fx.binary);
  assert.equal(host.attest(fx.descriptorPath, descriptor), true);
  assert.equal(host.attest(join(fx.privateDir, "other.json"), descriptor), false);
  assert.equal(host.attest(fx.descriptorPath, { ...descriptor, generation: "forged" }), false);
  for (const call of fx.calls) assert.match(call, ALLOWED_PROBES, `unexpected probe ${call}`);
  await host.stop();
});

test("missing SDK manifest or native library is unavailable without loading anything", async () => {
  unlinkSync(join(fx.resources, "cua-sdk", "native", "cua_driver_sdk.dll"));
  let status = await fx.make().start();
  assert.equal(status.state, "unavailable");
  assert.equal(status.reasonCode, "sdk-missing");
  unlinkSync(join(fx.resources, "cua-sdk", "manifest.json"));
  status = await fx.make().start();
  assert.equal(status.reasonCode, "sdk-missing");
  assert.equal(fx.loads.length, 0);
  assert.equal(fx.hosts.length, 0);
});

test("a substituted binary fails integrity before the SDK loads", async () => {
  writeFileSync(fx.binary, "substituted\n");
  const status = await fx.make().start();
  assert.equal(status.reasonCode, "sdk-integrity");
  assert.equal(fx.loads.length, 0);
});

test("resources writable by an untrusted principal are refused", async () => {
  fx.state.acl.set(join(fx.resources, "cua-sdk", "native"), resourceAcl([USERS_WRITE]));
  const status = await fx.make().start();
  assert.equal(status.reasonCode, "sdk-acl");
  assert.equal(fx.loads.length, 0);
});

test("locked, disconnected, session-0 and non-interactive desktops are unavailable", async (t) => {
  const cases = [
    ["desktop-locked", () => { fx.state.session.inputDesktop = "Winlogon"; }],
    ["desktop-locked", () => { fx.state.session.inputDesktop = null; }],
    ["session-disconnected", () => { fx.state.session.connectState = 4; }],
    ["no-interactive-desktop", () => { fx.state.session.windowStation = "Service-0x0-3e7$"; }],
    ["no-interactive-session", () => { fx.state.session.sessionId = 0; fx.state.identity.sessionId = 0; }],
  ];
  for (const [code, arrange] of cases) {
    await t.test(code, async () => {
      fx.cleanup();
      fx = createFixture();
      arrange();
      const status = await fx.make().start();
      assert.equal(status.state, "unavailable");
      assert.equal(status.reasonCode, code);
      assert.equal(status.capabilityAdvertised, false);
      assert.equal(fx.hosts.length, 0, "nothing starts without an unlocked desktop");
      assert.equal(existsSync(fx.leasePath), false, "the lease is released while waiting");
    });
  }
});

test("a locked desktop at boot is waited out by metadata polling only", async () => {
  fx.state.session.inputDesktop = "Winlogon";
  const host = fx.make();
  assert.equal((await host.start()).reasonCode, "desktop-locked");
  await fx.runTimers();
  assert.equal(host.status().reasonCode, "desktop-locked");
  assert.equal(fx.hosts.length, 0);
  fx.state.session.inputDesktop = "Default";
  await fx.runTimers();
  assert.equal(host.status().state, "ready");
  await host.stop();
});

test("sessionAvailability requires the owner's own active WinSta0 Default desktop", () => {
  const who = { sessionId: 2 };
  assert.equal(sessionAvailability(who, { sessionId: 3, connectState: 0, windowStation: "WinSta0", inputDesktop: "Default" }).reasonCode, "wrong-session");
  assert.equal(sessionAvailability(who, null).reasonCode, "session-unknown");
  assert.equal(sessionAvailability(who, { sessionId: 2, connectState: 0, windowStation: "winsta0", inputDesktop: "default" }).available, true);
});

for (const [name, daemon, code] of [
  ["daemon in another session", { sessionId: 3 }, "wrong-session"],
  ["daemon as another SID", { ownerSid: OTHER_SID }, "wrong-sid"],
  ["daemon not our child", { parentPid: 1 }, "daemon-substituted"],
  ["daemon from another binary", { executablePath: "C:\\Temp\\cua-driver.exe" }, "daemon-substituted"],
]) {
  test(`${name} is refused and torn down`, async () => {
    fx.state.daemon = daemon;
    const status = await fx.make().start();
    assert.equal(status.reasonCode, code);
    assert.equal(fx.hosts[0].destroyed, true);
    assert.equal(fx.hosts[0].events.length, 1, "owned host stopped once");
    assert.equal(existsSync(fx.leasePath), false);
  });
}

test("a pipe served by another process is refused", async () => {
  fx.state.pipeOverride = { serverPid: 1, ...privateAcl() };
  assert.equal((await fx.make().start()).reasonCode, "pipe-substituted");
});

test("a pipe readable by Everyone is refused", async () => {
  fx.state.pipeExtraEntries = [EVERYONE_READ];
  assert.equal((await fx.make().start()).reasonCode, "pipe-acl");
});

test("a descriptor readable by other principals is revoked", async () => {
  fx.state.acl.set(fx.descriptorPath, privateAcl(USER_SID, [EVERYONE_READ]));
  const status = await fx.make().start();
  assert.equal(status.reasonCode, "descriptor-acl");
  assert.equal(fx.readDescriptor().mode, "unavailable");
});

test("a state directory owned by someone else is refused before the lease", async () => {
  fx.state.defaultPrivateAcl = privateAcl(OTHER_SID);
  assert.equal((await fx.make().start()).reasonCode, "descriptor-acl");
  assert.equal(fx.hosts.length, 0);
});

test("a stale lease from a dead or recycled pid is reclaimed", async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(fx.privateDir, { recursive: true });
  // pid 5555 is alive but started later: pid reuse, not the owner.
  fx.state.processes.set(5555, { pid: 5555, parentPid: 1, sessionId: SESSION_ID, ownerSid: USER_SID, executablePath: "C:\\x.exe", startTimeMs: 99_999 });
  writeFileSync(fx.leasePath, JSON.stringify({ version: 1, pid: 5555, startTimeMs: 1_234, sid: USER_SID, sessionId: SESSION_ID, nonce: "8b1f0e0a-58d5-4b8e-9c55-1e9f3f2a8c11" }));
  const host = await ready();
  assert.equal(JSON.parse(readFileSync(fx.leasePath, "utf8")).pid, SELF_PID);
  await host.stop();
});

test("a live lease owner keeps the workspace and the contender does not touch its descriptor", async () => {
  const first = await ready();
  const before = readFileSync(fx.descriptorPath, "utf8");
  const second = fx.make();
  const status = await second.start();
  assert.equal(status.reasonCode, "controller-busy");
  assert.equal(readFileSync(fx.descriptorPath, "utf8"), before);
  assert.equal(first.attest(fx.descriptorPath, JSON.parse(before)), true);
  assert.equal(fx.hosts.length, 1);
  await first.stop();
});

test("an unreadable lease is not taken over", async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(fx.privateDir, { recursive: true });
  writeFileSync(fx.leasePath, "{");
  assert.equal((await fx.make().start()).reasonCode, "controller-lease");
});

test("a foreign cua-driver in the same session blocks start", async () => {
  fx.state.processes.set(6000, { pid: 6000, parentPid: 1, sessionId: SESSION_ID, ownerSid: USER_SID, executablePath: "C:\\Other\\cua-driver.exe", startTimeMs: 5 });
  assert.equal((await fx.make().start()).reasonCode, "another-controller");
  assert.equal(fx.hosts.length, 0);
});

test("SDK load failure and daemon start failure are unavailable", async () => {
  fx.state.loadError = new Error("dll missing dependency");
  assert.equal((await fx.make().start()).reasonCode, "sdk-load-failed");
  fx.state.loadError = null;
  fx.state.startError = new Error("spawn failed");
  assert.equal((await fx.make().start()).reasonCode, "daemon-start-failed");
});

test("a pinned contract version must match the daemon", async () => {
  fx.cleanup();
  fx = createFixture({ contractVersion: "9.9.9" });
  assert.equal((await fx.make().start()).reasonCode, "driver-mismatch");
});

test("a maintenance marker blocks start", async () => {
  writeFileSync(fx.maintenanceMarker, "");
  const host = fx.make();
  const status = await host.start();
  assert.equal(status.state, "maintenance");
  assert.equal(fx.hosts.length, 0);
  unlinkSync(fx.maintenanceMarker);
  assert.equal((await host.start()).state, "ready", "an explicit start after maintenance proceeds");
  await host.stop();
});

test("daemon exit relaunches once through the same owner", async () => {
  const host = await ready();
  fx.hosts[0].exit();
  await settle();
  assert.equal(host.status().state, "ready");
  assert.equal(fx.hosts.length, 2);
  assert.equal(fx.readDescriptor().daemon.pid, fx.hosts[1].connection.pid);
  await host.stop();
});

test("maintenance before a restart prevents the relaunch", async () => {
  const host = await ready();
  writeFileSync(fx.maintenanceMarker, "");
  assert.equal(host.attest(fx.descriptorPath, fx.readDescriptor()), false);
  fx.hosts[0].exit();
  await settle();
  assert.equal(host.status().state, "maintenance");
  assert.equal(fx.hosts.length, 1);
  assert.equal(fx.readDescriptor().mode, "unavailable");
  assert.equal(existsSync(fx.leasePath), false);
});

test("repeated exits open a persisted circuit that a new process honours", async () => {
  const host = await ready();
  for (let i = 0; i < 3; i++) {
    fx.hosts.at(-1).exit();
    await settle();
  }
  assert.equal(host.status().state, "circuit-open");
  assert.equal(host.status().reasonCode, "restart-budget-exhausted");
  assert.equal(fx.hosts.length, 3);
  assert.equal(fx.timers.filter((t) => !t.cleared).length, 0, "no background retry after the circuit opens");
  // Task Scheduler restarts the launcher: the persisted circuit stays open.
  const restarted = fx.make();
  assert.equal((await restarted.start()).reasonCode, "restart-budget-exhausted");
  assert.equal(fx.hosts.length, 3);
  fx.advance(600_001);
  assert.equal((await restarted.start()).state, "ready");
  await restarted.stop();
});

test("a corrupt circuit file holds the circuit closed to starts", async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(fx.privateDir, { recursive: true });
  writeFileSync(join(fx.privateDir, "circuit.json"), "not json");
  assert.equal((await fx.make().start()).reasonCode, "restart-budget-exhausted");
});

test("stop revokes the descriptor before the daemon stops and attest fails afterwards", async () => {
  const host = await ready();
  const descriptor = fx.readDescriptor();
  const status = await host.stop();
  assert.equal(status.state, "stopped");
  assert.deepEqual(fx.hosts[0].events, ["stop:descriptor=unavailable"]);
  assert.equal(host.attest(fx.descriptorPath, descriptor), false);
  assert.equal(existsSync(fx.leasePath), false);
});

test("stop during an in-flight start aborts it without publishing", async () => {
  fx.state.startGate = true;
  const host = fx.make();
  const starting = host.start();
  await settle();
  assert.equal(fx.hosts.length, 1);
  const stopped = await host.stop();
  await starting;
  assert.equal(stopped.state, "stopped");
  assert.equal(host.status().state, "stopped");
  assert.equal(existsSync(fx.leasePath), false);
  assert.notEqual(existsSync(fx.descriptorPath) ? fx.readDescriptor().mode : "absent", WINDOWS_CUA_MODE);
});

test("concurrent start() calls construct exactly one host", async () => {
  const host = fx.make();
  const [a, b] = await Promise.all([host.start(), host.start()]);
  assert.equal(a.state, "ready");
  assert.equal(b.state, "ready");
  assert.equal(fx.hosts.length, 1);
  await host.stop();
});

test("lock and unlock during polling revoke then re-verify the same daemon", async () => {
  const host = await ready();
  fx.state.session.inputDesktop = "Winlogon";
  await fx.runTimers();
  let status = host.status();
  assert.equal(status.reasonCode, "desktop-locked");
  assert.equal(status.capabilityAdvertised, false);
  assert.equal(fx.readDescriptor().mode, "unavailable");
  fx.state.session.inputDesktop = "Default";
  await fx.runTimers();
  status = host.status();
  assert.equal(status.capabilityAdvertised, true);
  assert.equal(fx.hosts.length, 1, "unlock reuses the verified daemon");
  assert.equal(host.attest(fx.descriptorPath, fx.readDescriptor()), true);
  await host.stop();
});

test("a session or user switch during polling tears the host down", async () => {
  const host = await ready();
  fx.state.identity.sid = OTHER_SID;
  await fx.runTimers();
  assert.equal(host.status().state, "unavailable");
  assert.equal(host.status().reasonCode, "wrong-session");
  assert.equal(fx.hosts[0].destroyed, true);
});

test("a rewritten descriptor or a touched binary fails attestation", async () => {
  const host = await ready();
  const descriptor = fx.readDescriptor();
  writeFileSync(fx.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  assert.equal(host.attest(fx.descriptorPath, descriptor), false);
  await host.stop();

  const again = await ready();
  const fresh = fx.readDescriptor();
  assert.equal(again.attest(fx.descriptorPath, fresh), true);
  utimesSync(fx.binary, new Date(), new Date(Date.now() + 5_000));
  assert.equal(again.attest(fx.descriptorPath, fresh), false);
  await again.stop();
});

test("a dead daemon pid fails attestation immediately", async () => {
  const host = await ready();
  fx.state.processes.delete(fx.hosts[0].connection.pid);
  assert.equal(host.attest(fx.descriptorPath, fx.readDescriptor()), false);
  await host.stop();
});

test("non-Windows and invalid configuration never start", async () => {
  assert.equal((await fx.make({ platform: "linux" }).start()).reasonCode, "unsupported-platform");
  assert.equal((await fx.make({ environmentId: "x" }).start()).reasonCode, "invalid-config");
  assert.equal((await fx.make({ dataDir: "relative" }).start()).reasonCode, "invalid-config");
  assert.equal(fx.calls.length, 0);
});

test("ACL helpers only accept trusted writers and private owners", () => {
  const who = { sid: USER_SID, logonSid: LOGON_SID };
  assert.equal(aclAllowsOnlyTrustedWriters(resourceAcl(), who), true);
  assert.equal(aclAllowsOnlyTrustedWriters(resourceAcl([USERS_WRITE]), who), false);
  assert.equal(aclAllowsOnlyTrustedWriters({ ownerSid: OTHER_SID, entries: [] }, who), false);
  assert.equal(aclIsPrivate(privateAcl(), who), true);
  assert.equal(aclIsPrivate(privateAcl(USER_SID, [EVERYONE_READ]), who), false);
  assert.equal(aclIsPrivate(privateAcl(USER_SID, [{ sid: LOGON_SID, type: "allow", rights: 0x1f01ff }]), who), false);
  assert.equal(aclIsPrivate(privateAcl(USER_SID, [{ sid: LOGON_SID, type: "allow", rights: 0x1f01ff }]), who, { allowLogonSid: true }), true);
  assert.equal(aclIsPrivate(privateAcl(USER_SID, [{ sid: "S-1-1-0", type: "allow", rights: 0x100080 }]), who), true, "attribute reads are harmless");
  assert.equal(aclIsPrivate({ ownerSid: USER_SID, entries: [{ sid: "not-a-sid", type: "allow", rights: 1 }] }, who), false);
});

test("attestation installs once and cannot be replaced", () => {
  const target = {};
  installWindowsCuaAttestation({ attest: () => true }, target);
  assert.equal(target[WINDOWS_CUA_ATTESTATION].attest("x", {}), true);
  assert.throws(() => installWindowsCuaAttestation({ attest: () => false }, target), /already installed/);
  assert.throws(() => { "use strict"; target[WINDOWS_CUA_ATTESTATION] = null; });
});

test("PowerShell probe sends one request per call and parses metadata", async () => {
  const runs = [];
  const replies = {
    identity: JSON.stringify({ sid: USER_SID, sessionId: 2 }),
    processesNamed: JSON.stringify({ pid: 9, sessionId: 2 }),
    pipeInfo: "",
  };
  const run = (file, args, options, callback) => {
    const request = JSON.parse(options.env?.OMB_CUA_PROBE_REQUEST ?? "{}");
    runs.push({ file, args, options, request });
    const stdin = { script: "", end(text) { this.script = text; } };
    queueMicrotask(() => callback(null, replies[request.op] ?? "null"));
    return { stdin };
  };
  const probe = createPowerShellWindowsProbe({ run, environment: { SystemRoot: "C:\\Windows" } });
  assert.deepEqual(await probe.identity(), { sid: USER_SID, sessionId: 2 });
  assert.deepEqual(await probe.processesNamed("cua-driver.exe"), [{ pid: 9, sessionId: 2 }]);
  assert.equal(await probe.pipeInfo("\\\\.\\pipe\\x"), null);
  assert.equal(runs[0].file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(runs[0].args, ["-NoProfile", "-NonInteractive", "-Command", "-"]);
  assert.equal(runs[0].options.windowsHide, true);
  await probe.restrictDirectory("C:\\data\\cua-windows", USER_SID);
  assert.equal(runs.at(-1).file, "C:\\Windows\\System32\\icacls.exe");
  assert.deepEqual(runs.at(-1).args, ["C:\\data\\cua-windows", "/inheritance:r", "/grant:r", `*${USER_SID}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
  await assert.rejects(probe.restrictDirectory("C:\\data", "Everyone"), (error) => error.reasonCode === "identity-unknown");
  const failing = createPowerShellWindowsProbe({ run: (f, a, o, cb) => { queueMicrotask(() => cb(new Error("exit 1"))); return {}; } });
  await assert.rejects(failing.session(), (error) => error.reasonCode === "probe-failed");
  const garbage = createPowerShellWindowsProbe({ run: (f, a, o, cb) => { queueMicrotask(() => cb(null, "<html>")); return {}; } });
  await assert.rejects(garbage.session(), (error) => error.reasonCode === "probe-failed");
});

test("the probe script is metadata-only", async () => {
  let script = "";
  const run = (file, args, options, callback) => { queueMicrotask(() => callback(null, "null")); return { stdin: { end(text) { script = text; } } }; };
  await createPowerShellWindowsProbe({ run }).session();
  assert.match(script, /OpenInputDesktop/);
  for (const forbidden of [/CopyFromScreen/i, /BitBlt/i, /SendInput/i, /keybd_event/i, /mouse_event/i, /EnumWindows/i, /SetForegroundWindow/i, /Start-Process/i]) {
    assert.doesNotMatch(script, forbidden);
  }
});

test("server-only launcher start is opt-in and wires env, attestation and signals", async () => {
  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  assert.equal(await startServerOnlyWindowsCua({ computerUse: false }, { processRef }), null);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);

  const created = [];
  const events = [];
  const fake = {
    descriptorPath: "C:\\data\\cua-windows\\cua-connection.json",
    start: async () => { events.push("start"); return { state: "ready" }; },
    stop: async () => { events.push("stop"); },
  };
  const config = { computerUse: true, dataDir: "C:\\data", resources: "C:\\res", environmentId: "partner-server-01", maintenanceMarker: "C:\\m.lock" };
  const result = await startServerOnlyWindowsCua(config, {
    processRef,
    createHost: (options) => { created.push(options); return fake; },
    install: (host) => events.push(host === fake ? "install" : "wrong"),
  });
  assert.deepEqual(created, [{ dataDir: "C:\\data", resourcesPath: "C:\\res", environmentId: "partner-server-01", maintenanceMarker: "C:\\m.lock" }]);
  assert.deepEqual(result.env, { OMB_CUA_WINDOWS_SUPERVISED: "1", OMB_CUA_WINDOWS_DESCRIPTOR: fake.descriptorPath });
  assert.deepEqual(events, ["install", "start"]);
  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  await settle();
  assert.deepEqual(events, ["install", "start", "stop"], "one stop for any number of signals");
  assert.deepEqual(exits, [0]);
});
