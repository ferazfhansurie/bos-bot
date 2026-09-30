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
  WINDOWS_PROBE_SCRIPT,
  createPowerShellWindowsProbe,
  encodeWindowsProbeCommand,
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

// Values captured from the fixed probe on PARTNERHOST/kings over SSH (session 0,
// 2026-09-30), used to pin the real reply shapes.
const PARTNERHOST_SID = "S-1-5-21-1494927478-50599041-3459622598-1001";
const PARTNERHOST = {
  identity: { sid: PARTNERHOST_SID, userName: "PartnerHost\\owner", sessionId: 0, logonSid: "S-1-5-5-0-47089391" },
  session: { sessionId: 0, connectState: 4, windowStation: "Service-0x0-2ce86f0$", inputDesktop: null },
  processInfo: { pid: 9052, parentPid: 14104, sessionId: 0, ownerSid: PARTNERHOST_SID, executablePath: "C:\\Program Files\\nodejs\\node.exe", startTimeMs: 1790781039036 },
  acl: { ownerSid: "S-1-5-32-544", entries: [
    { sid: "S-1-5-18", type: "allow", rights: 2032127, inheritOnly: false },
    { sid: PARTNERHOST_SID, type: "allow", rights: 2032127, inheritOnly: false },
  ] },
};
const frame = (op, value, extra = {}) => `OMBCUA1:${JSON.stringify({ schema: "omb-cua-probe/1", op, ok: true, value, ...extra })}`;

function scriptedProbe(reply) {
  const runs = [];
  const run = (file, args, options, callback) => {
    const request = JSON.parse(options.env?.OMB_CUA_PROBE_REQUEST ?? "{}");
    const record = { file, args, options, request, stdinEnded: false, stdinText: undefined };
    runs.push(record);
    queueMicrotask(() => {
      const [error, stdout] = reply(request, file);
      callback(error, stdout, "");
    });
    return { stdin: { end(text) { record.stdinEnded = true; record.stdinText = text; } } };
  };
  return { runs, probe: createPowerShellWindowsProbe({ run, environment: { SystemRoot: "C:\\Windows" } }) };
}

test("PowerShell probe uses -EncodedCommand and parses the captured PARTNERHOST replies", async () => {
  const { runs, probe } = scriptedProbe((request, file) => {
    if (file.endsWith("icacls.exe")) return [null, ""];
    const value = request.op === "processesNamed" ? [] : request.op === "pipeInfo" ? null : PARTNERHOST[request.op];
    // Stray progress text before the frame is ignored; only the frame counts.
    return [null, `Preparing modules for first use.\r\n${frame(request.op, value)}\r\n`];
  });
  assert.deepEqual(await probe.identity(), PARTNERHOST.identity);
  assert.deepEqual(await probe.session(), PARTNERHOST.session);
  assert.equal(sessionAvailability(PARTNERHOST.identity, PARTNERHOST.session).reasonCode, "no-interactive-session");
  assert.deepEqual(await probe.processInfo(9052), PARTNERHOST.processInfo);
  assert.deepEqual(await probe.acl("C:\\Users\\owner\\AppData\\Local\\BOSServerStandalone\\resources"), PARTNERHOST.acl);
  assert.equal(aclAllowsOnlyTrustedWriters(PARTNERHOST.acl, PARTNERHOST.identity), true);
  assert.deepEqual(await probe.processesNamed("cua-driver.exe"), []);
  assert.equal(await probe.pipeInfo("\\\\.\\pipe\\x"), null);
  const first = runs[0];
  assert.equal(first.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(first.args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeWindowsProbeCommand()]);
  assert.equal(Buffer.from(first.args.at(-1), "base64").toString("utf16le"), WINDOWS_PROBE_SCRIPT);
  assert.ok(!first.args.includes("-Command"), "never feeds the script through stdin");
  assert.equal(first.stdinEnded, true);
  assert.equal(first.stdinText, undefined, "stdin is closed empty");
  assert.equal(first.options.windowsHide, true);
  assert.deepEqual(first.request, { op: "identity" });
  await probe.restrictDirectory("C:\\data\\cua-windows", USER_SID);
  assert.equal(runs.at(-1).file, "C:\\Windows\\System32\\icacls.exe");
  assert.deepEqual(runs.at(-1).args, ["C:\\data\\cua-windows", "/inheritance:r", "/grant:r", `*${USER_SID}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
  await assert.rejects(probe.restrictDirectory("C:\\data", "Everyone"), (error) => error.reasonCode === "identity-unknown");
});

test("the encoded probe fits the Windows command-line limit", () => {
  assert.ok(encodeWindowsProbeCommand().length < 30_000);
  assert.throws(() => encodeWindowsProbeCommand("x".repeat(20_000)), /too long/);
});

test("missing, empty or malformed probe output fails closed, never as null", async (t) => {
  const cases = [
    // Exactly what `-Command -` produced on PARTNERHOST: exit 0, nothing on stdout.
    ["empty stdout with exit 0", () => [null, ""]],
    ["bare null", () => [null, "null"]],
    ["unframed JSON", (r) => [null, JSON.stringify(PARTNERHOST[r.op] ?? {})]],
    ["html", () => [null, "<html>"]],
    ["truncated frame", () => [null, "OMBCUA1:{\"schema\":\"omb-cua-probe/1\""]],
    ["two frames", (r) => [null, `${frame(r.op, PARTNERHOST[r.op])}\n${frame(r.op, PARTNERHOST[r.op])}`]],
    ["wrong schema", (r) => [null, frame(r.op, PARTNERHOST[r.op], { schema: "other/1" })]],
    ["answer for another op", (r) => [null, frame(r.op === "session" ? "identity" : "session", r.op === "session" ? PARTNERHOST.identity : PARTNERHOST.session)]],
    ["ok without value", (r) => [null, `OMBCUA1:${JSON.stringify({ schema: "omb-cua-probe/1", op: r.op, ok: true })}`]],
    ["null value", (r) => [null, frame(r.op, null)]],
    ["script error frame", (r) => [Object.assign(new Error("exit 3"), { code: 3 }), `OMBCUA1:${JSON.stringify({ schema: "omb-cua-probe/1", op: r.op, ok: false, error: "System.InvalidCastException" })}`]],
    ["non-zero exit with a valid frame", (r) => [Object.assign(new Error("exit 1"), { code: 1 }), frame(r.op, PARTNERHOST[r.op])]],
    ["spawn failure", () => [Object.assign(new Error("ENOENT"), { code: "ENOENT" }), ""]],
  ];
  for (const [name, reply] of cases) {
    await t.test(name, async () => {
      const { probe } = scriptedProbe(reply);
      for (const op of ["identity", "session", "acl"]) {
        await assert.rejects(op === "acl" ? probe.acl("C:\\x") : probe[op](), (error) => error.reasonCode === "probe-failed", `${op} must fail`);
      }
    });
  }
});

test("script error frames surface only the exception type", async () => {
  const { probe } = scriptedProbe((r) => [Object.assign(new Error("exit 3"), { code: 3 }),
    `OMBCUA1:${JSON.stringify({ schema: "omb-cua-probe/1", op: r.op, ok: false, error: "System.InvalidCastException<script>SECRET=1" })}`]);
  await assert.rejects(probe.acl("C:\\x"), (error) => {
    assert.equal(error.reasonCode, "probe-failed");
    assert.equal(error.message, "Windows acl probe failed (System.InvalidCastExceptionscriptSECRET1)");
    return true;
  });
});

test("probe values with the wrong shape fail closed", async (t) => {
  const bad = {
    identity: [{ sid: "kings", sessionId: 1 }, { sid: PARTNERHOST_SID, sessionId: -1 }, { sid: PARTNERHOST_SID, sessionId: 1, logonSid: "x" }],
    session: [{ sessionId: "1", connectState: 0 }, { sessionId: 1 }],
    acl: [
      { ownerSid: "S-1-5-32-544", entries: [{ sid: "S-1-1-0", type: "allow", rights: -1610612736, inheritOnly: false }] },
      { ownerSid: "S-1-5-32-544", entries: [{ sid: "S-1-1-0", type: "allow", rights: 4294967296, inheritOnly: false }] },
      { ownerSid: "S-1-5-32-544", entries: [{ sid: "S-1-1-0", type: "allow", rights: 1.5, inheritOnly: false }] },
      { ownerSid: "S-1-5-32-544", entries: [{ sid: "S-1-1-0", type: "allow", rights: 1 }] },
      { ownerSid: "S-1-5-32-544", entries: [{ sid: "S-1-1-0", type: "audit", rights: 1, inheritOnly: false }] },
      { ownerSid: "S-1-5-32-544", entries: {} },
    ],
    processInfo: [{ pid: 0, parentPid: 1, sessionId: 1, ownerSid: PARTNERHOST_SID, startTimeMs: 1 }, { pid: 5, parentPid: 1, sessionId: 1, ownerSid: PARTNERHOST_SID }],
    processesNamed: [{ pid: 5 }, null],
  };
  for (const [op, values] of Object.entries(bad)) {
    for (const value of values) {
      await t.test(`${op} ${JSON.stringify(value)}`, async () => {
        const { probe } = scriptedProbe((r) => [null, frame(r.op, value)]);
        const call = op === "processInfo" ? probe.processInfo(5) : op === "processesNamed" ? probe.processesNamed("x.exe") : op === "acl" ? probe.acl("C:\\x") : probe[op]();
        await assert.rejects(call, (error) => error.reasonCode === "probe-failed");
      });
    }
  }
});

test("unsigned access masks from the PARTNERHOST SDDL smoke keep the ACL policy strict", () => {
  // Parsed by the real PowerShell Acl() on PARTNERHOST from synthetic SDDL.
  const who = { sid: PARTNERHOST_SID, logonSid: "S-1-5-5-0-47089391" };
  const system = { sid: "S-1-5-18", type: "allow", rights: 2032127, inheritOnly: false };
  const admins = { sid: "S-1-5-32-544", type: "allow", rights: 2032127, inheritOnly: false };
  const acl = (...entries) => ({ ownerSid: "S-1-5-32-544", entries });
  // (A;OICIIO;GA;;;CO)(A;;GRGX;;;BU): inherit-only GENERIC_ALL, GENERIC_READ|EXECUTE = 0xA0000000.
  const readExecute = acl({ sid: "S-1-3-0", type: "allow", rights: 268435456, inheritOnly: true }, { sid: "S-1-5-32-545", type: "allow", rights: 2684354560, inheritOnly: false }, system);
  assert.equal(aclAllowsOnlyTrustedWriters(readExecute, who), true);
  assert.equal(aclIsPrivate(readExecute, who), false);
  // (A;;GW;;;BU) = 0x40000000.
  assert.equal(aclAllowsOnlyTrustedWriters(acl({ sid: "S-1-5-32-545", type: "allow", rights: 1073741824, inheritOnly: false }, system), who), false);
  // (A;;0x80000000;;;WD): GENERIC_READ only.
  const everyoneRead = acl({ sid: "S-1-1-0", type: "allow", rights: 2147483648, inheritOnly: false }, admins);
  assert.equal(aclAllowsOnlyTrustedWriters(everyoneRead, who), true);
  assert.equal(aclIsPrivate({ ...everyoneRead, ownerSid: PARTNERHOST_SID }, who), false);
  // (A;;0xffffffff;;;WD), and an object ACE mapped to Everyone/all bits.
  assert.equal(aclAllowsOnlyTrustedWriters(acl({ sid: "S-1-1-0", type: "allow", rights: 4294967295, inheritOnly: false }), who), false);
  // (D;;FA;;;AN): deny entries never widen access.
  assert.equal(aclAllowsOnlyTrustedWriters(acl({ sid: "S-1-5-7", type: "deny", rights: 2032127, inheritOnly: false }, admins), who), true);
  // D:(A;;FA;;;BA) with no owner.
  assert.equal(aclAllowsOnlyTrustedWriters({ ownerSid: null, entries: [admins] }, who), false);
  // Out-of-range masks never reach policy as "valid".
  assert.equal(aclAllowsOnlyTrustedWriters(acl({ sid: "S-1-1-0", type: "allow", rights: 4294967296, inheritOnly: false }), who), false);
  assert.equal(aclAllowsOnlyTrustedWriters(acl({ sid: "S-1-1-0", type: "allow", rights: -1, inheritOnly: false }), who), false);
});

test("the probe script handles signed masks, enum flags and the logon SID explicitly", () => {
  const script = WINDOWS_PROBE_SCRIPT;
  assert.doesNotMatch(script, /\[uint32\]\s*\$ace/i, "a [uint32] cast of a negative Int32 mask throws in PS 5.1");
  assert.doesNotMatch(script, /\[bool\]\s*\(\s*\$ace\.AceFlags/i, "[bool] of a flags enum throws InvalidCastException");
  assert.match(script, /\$m \+= 4294967296/);
  assert.match(script, /\(\[int\]\$ace\.AceFlags\) -band 8/);
  assert.match(script, /0xC0000000u/, "logon SID comes from TOKEN_GROUPS, not WindowsIdentity.Groups");
  assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.doesNotMatch(script, /\bswitch\s*\(/, "switch unrolls arrays and nulls");
});

test("the probe script is metadata-only", () => {
  assert.match(WINDOWS_PROBE_SCRIPT, /OpenInputDesktop/);
  for (const forbidden of [/CopyFromScreen/i, /BitBlt/i, /SendInput/i, /keybd_event/i, /mouse_event/i, /EnumWindows/i, /SetForegroundWindow/i, /Start-Process/i, /Set-Acl/i, /icacls/i]) {
    assert.doesNotMatch(WINDOWS_PROBE_SCRIPT, forbidden);
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

test("server-only host never pre-empts the server's own graceful exit", async () => {
  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  let finishStop;
  const events = [];
  const fake = {
    descriptorPath: "C:\\data\\cua-windows\\cua-connection.json",
    start: async () => ({ state: "ready" }),
    stop: () => new Promise((resolve) => { events.push("stop"); finishStop = resolve; }),
  };
  const config = { computerUse: true, dataDir: "C:\\data", resources: "C:\\res", environmentId: "partner-server-01", maintenanceMarker: "C:\\m.lock" };
  await startServerOnlyWindowsCua(config, { processRef, createHost: () => fake, install: () => {} });
  // The server registers its own handler after the host starts.
  processRef.on("SIGINT", () => events.push("server-cleanup"));
  processRef.emit("SIGINT");
  await settle();
  assert.deepEqual(events, ["stop", "server-cleanup"]);
  assert.deepEqual(exits, [], "host does not exit while the server handles the signal");
  processRef.exit(0); // server finished persisting sessions/db/lease
  await settle();
  assert.deepEqual(exits, [], "server exit waits for the host stop");
  finishStop();
  await settle();
  assert.deepEqual(exits, [0]);
});
