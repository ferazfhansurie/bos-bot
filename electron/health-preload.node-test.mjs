import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
function bridge(remote = false) {
  let api;
  const calls = [];
  vm.runInNewContext(source, {
    process: { platform: "fixture", argv: ["--omb-local-origin=http://127.0.0.1:48992"] },
    location: { origin: remote ? "https://remote.invalid" : "http://127.0.0.1:48992" },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { on() {}, invoke: async channel => { calls.push(channel); return { id: "diag-fixture" }; } } }),
  });
  return { api, calls };
}
test("health actions are local-only and dispatch only their narrow IPC channels", async () => {
  const local = bridge();
  await local.api.health.sendDiagnostics();
  await local.api.health.exitSafeMode();
  assert.deepEqual(local.calls, ["desktop:send-diagnostics", "desktop:exit-safe-mode"]);
  assert.equal(bridge(true).api.health, undefined);
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  for (const channel of local.calls) assert.ok(main.includes(`ipcMain.handle("${channel}", localOnly("${channel}"`));
});

test("exit-safe-mode handler requests one clean relaunch through the normal quit lifecycle", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = main.indexOf('ipcMain.handle("desktop:exit-safe-mode"');
  const end = main.indexOf('// One-click bug-report bundle.', start);
  for (const [enabled, shuttingDown, expected] of [[true, false, ["relaunch", "quit"]], [false, false, []], [true, true, []]]) {
    let handler;
    const calls = [];
    const env = { BOS_SAFE_MODE: "1", BOS_SAFE_MODE_REASON: "fixture" };
    vm.runInNewContext(main.slice(start, end), {
      ipcMain: { handle: (_channel, callback) => { handler = callback; } },
      localOnly: (_channel, callback) => callback,
      desktopSafeMode: enabled, desktopShutdownStarted: shuttingDown,
      process: { env }, app: { relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") },
    });
    await handler();
    assert.deepEqual(calls, expected);
    if (expected.length) assert.deepEqual(env, {});
  }
});

test("disabled self-heal rollout never starts a safe child or collects/uploads diagnostics", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const callback = main.slice(main.indexOf('  restartSafeMode: (reason) => {') + '  restartSafeMode: '.length, main.indexOf('\n  stop: stopUtilityServer,')).replace(/,\s*$/, '');
  const restart = vm.runInNewContext(`(${callback})`, {
    selfHealEnabled: () => false, desktopDataDir: () => "/fixture", slog() {},
    startServerOn: () => assert.fail("disabled rollout must not boot a safe child"), SERVER_PORT: 1,
  });
  assert.equal((await restart("fixture")).abort, true);
  let handler;
  const start = main.indexOf('ipcMain.handle("desktop:send-diagnostics"');
  const end = main.indexOf('ipcMain.handle("desktop:exit-safe-mode"', start);
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } }, localOnly: (_channel, callback) => callback,
    selfHealEnabled: () => false, desktopDataDir: () => "/fixture",
    gatherDiagnostics: () => assert.fail("disabled rollout must not collect a report"),
    sendDiagnosticsReport: () => assert.fail("disabled rollout must not upload"),
  });
  await assert.rejects(handler(), /not enabled/);
});
