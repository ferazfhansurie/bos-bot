import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The updater channels answer only the local UI (electron/local-origin.cjs).
const localEvent = { senderFrame: { url: "http://127.0.0.1:8799/" } };

const { updater, handlers, readCapability, loadVendor } = vi.hoisted(() => {
  const updater = { on: vi.fn(), downloadUpdate: vi.fn(), setFeedURL: vi.fn() };
  return { updater, handlers: new Map(), readCapability: vi.fn(), loadVendor: vi.fn(() => ({ autoUpdater: updater })) };
});

vi.mock("./updater-capability.mjs", () => ({ readUpdaterCapability: readCapability }));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "2.1.2", quit: vi.fn(), getPath: () => "/unused-updater-test-log" },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
}));
vi.mock("node:module", () => ({
  createRequire: () => loadVendor,
}));

const metadata = { provider: "generic", url: "https://updates.example.test/bos", updaterCacheDirName: "bos-updater" };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  const { default: localOriginModule } = await import("./local-origin.cjs");
  localOriginModule.setLocalOrigin("http://127.0.0.1:8799");
  readCapability.mockReturnValue({ available: true, reason: "configured", metadata });
  delete updater.isUserWithinRollout;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("sends updater progress to a reopened window without restarting the updater", async () => {
  const { attachUpdaterWindow, registerUpdaterIpc, startUpdater } = await import("./updater.mjs");
  vi.useFakeTimers();
  const first = { webContents: { send: vi.fn() } };
  const reopened = { webContents: { send: vi.fn() } };
  attachUpdaterWindow(first);
  registerUpdaterIpc();
  startUpdater({ fetchPolicy: async () => ({minimumVersion:null,autoUpdates:true}) });
  await vi.advanceTimersByTimeAsync(0);
  expect(updater.setFeedURL).toHaveBeenCalledWith(metadata);
  expect(updater.allowPrerelease).toBe(false);
  const listenerCount = updater.on.mock.calls.length;
  const timerCount = vi.getTimerCount();

  first.webContents.send.mockImplementation(() => { throw new Error("window destroyed"); });
  first.webContents.send.mockClear();
  attachUpdaterWindow(reopened);
  const emit = (name, payload) => {
    for (const [event, listener] of updater.on.mock.calls) {
      if (event === name) listener(payload);
    }
  };
  updater.downloadUpdate.mockImplementation(async () => {
    emit("download-progress", { percent: 50 });
    emit("update-downloaded", { version: "2.0.0" });
    return ["/unused-staged-update.zip"];
  });

  await handlers.get("update:download")(localEvent);

  expect(first.webContents.send).not.toHaveBeenCalled();
  expect(reopened.webContents.send.mock.calls.map(([, state]) => state.status))
    .toEqual(["downloading", "downloading", ...(process.platform === "darwin" ? ["preparing"] : []), "downloaded"]);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({ status: "downloaded", version: "2.0.0" });
  expect(updater.on.mock.calls).toHaveLength(listenerCount);
  expect(vi.getTimerCount()).toBe(timerCount);
});

it.each(["offline", "unconfigured"])("%s package never loads the vendor or starts native update actions", async reason => {
  vi.useFakeTimers();
  readCapability.mockReturnValue({ available: false, reason, message: "Native updates unavailable." });
  const { registerUpdaterIpc, startUpdater, windowsUpdateCoordinator } = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({ fetchPolicy: async () => ({minimumVersion:null,autoUpdates:true}) });
  for (const action of ["check", "download", "install"]) {
    expect(await handlers.get(`update:${action}`)(localEvent)).toMatchObject({ available: false, capability: reason, retryable: false });
  }
  expect(windowsUpdateCoordinator.candidate()).toBeNull();
  expect(() => windowsUpdateCoordinator.admit("update")).toThrow("No verified Windows installer is staged");
  expect(windowsUpdateCoordinator.install({})).toBeUndefined();
  expect(loadVendor).not.toHaveBeenCalled();
  expect(updater.on).not.toHaveBeenCalled();
  expect(updater.setFeedURL).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

function emitUpdate(name, payload) {
  for (const [event, listener] of updater.on.mock.calls) if (event === name) listener(payload);
}

it("downloads quietly, then installs on quit through the lifecycle gate", async () => {
  vi.useFakeTimers();
  const prepareInstall = vi.fn(async () => ({}));
  updater.quitAndInstall = vi.fn();
  updater.checkForUpdates = vi.fn(async () => emitUpdate("update-available", {version: "2.1.3"}));
  updater.downloadUpdate.mockImplementation(async () => {
    emitUpdate("update-downloaded", {version: "2.1.3"});
    return ["update.zip"];
  });
  const {startUpdater, handleUpdaterQuit, registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({prepareInstall, fetchPolicy: async () => ({minimumVersion:null,autoUpdates:true})});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({status: "downloaded"});
  const event = {preventDefault: vi.fn()};
  expect(handleUpdaterQuit(event)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(prepareInstall).toHaveBeenCalledTimes(1);
  if (process.platform !== "darwin") expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  expect(handleUpdaterQuit(event)).toBe(false);
});

it("a fetched minimum blocks old desktops and installs as soon as native staging finishes", async () => {
  vi.useFakeTimers();
  const prepareInstall = vi.fn(async () => ({}));
  updater.quitAndInstall = vi.fn();
  updater.checkForUpdates = vi.fn(async () => emitUpdate("update-available", {version: "2.1.3"}));
  updater.downloadUpdate.mockImplementation(async () => {
    emitUpdate("update-downloaded", {version: "2.1.3"});
    return ["update.zip"];
  });
  const {startUpdater, registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({prepareInstall, fetchPolicy: async () => ({minimumVersion:"2.1.3",autoUpdates:false})});
  await vi.advanceTimersByTimeAsync(0);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({required: true, minimumVersion: "2.1.3", status: "installing"});
  expect(prepareInstall).toHaveBeenCalledTimes(1);
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
});

it("offline config never gates launch and automatic feed errors become visible state", async () => {
  vi.useFakeTimers();
  updater.checkForUpdates = vi.fn(async () => { throw new Error("ENOTFOUND updates.example"); });
  const {startUpdater, registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({fetchPolicy: async () => { throw new Error("offline"); }});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({status: "error"});
  expect(handlers.get("update:get-state")(localEvent).required).toBeUndefined();
});

it("a lagging feed cannot restart into a version below the configured minimum", async () => {
  vi.useFakeTimers();
  updater.quitAndInstall = vi.fn();
  updater.checkForUpdates = vi.fn(async () => emitUpdate("update-available", {version: "2.1.3"}));
  updater.downloadUpdate.mockImplementation(async () => {
    emitUpdate("update-downloaded", {version: "2.1.3"});
    return ["update.zip"];
  });
  const {startUpdater, registerUpdaterIpc, handleUpdaterQuit} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({prepareInstall: async () => ({}), fetchPolicy: async () => ({minimumVersion:"2.2.0",autoUpdates:false})});
  await vi.advanceTimersByTimeAsync(0);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({required: true, status: "error", retryable: false});
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(handleUpdaterQuit({preventDefault: vi.fn()})).toBe(false);
});

it("manual downloads wait for minimum config before native staging", async () => {
  vi.useFakeTimers();
  let resolveMinimum;
  const minimum = new Promise(resolve => { resolveMinimum = resolve; });
  updater.quitAndInstall = vi.fn();
  updater.downloadUpdate.mockImplementation(async () => {
    emitUpdate("update-downloaded", {version: "2.1.3"});
    return ["update.zip"];
  });
  const {startUpdater, registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({prepareInstall: async () => ({}), fetchPolicy: () => minimum});
  const downloading = handlers.get("update:download")(localEvent);
  await Promise.resolve();
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  resolveMinimum({minimumVersion:"2.1.3",autoUpdates:false});
  await downloading;
  await vi.advanceTimersByTimeAsync(0);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({required: true, status: "installing"});
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
});

it("persists bounded failure classes after the coordinator sanitizes feed errors", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "bos-update-errors-"));
  try {
    const {startUpdater, registerUpdaterIpc} = await import("./updater.mjs");
    registerUpdaterIpc();
    startUpdater({dataDir: dir, fetchPolicy: async () => ({minimumVersion:null,autoUpdates:true})});
    for (const [message, kind] of [["ENOTFOUND secret.example", "network"], ["404 cannot find latest.yml", "feed"], ["checksum secret mismatch", "verification"]]) {
      updater.checkForUpdates = vi.fn(async () => { throw new Error(message); });
      await handlers.get("update:check")(localEvent);
      const raw = readFileSync(join(dir, "update-state.json"), "utf8");
      expect(JSON.parse(raw).update_state).toBe(`failed:${kind}`);
      expect(raw).not.toContain("secret");
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

it("the remote rollout flag keeps ordinary updates manual until enabled", async () => {
  vi.useFakeTimers();
  updater.checkForUpdates = vi.fn(async () => emitUpdate("update-available", {version:"2.1.3"}));
  const {startUpdater,registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({fetchPolicy:async()=>({minimumVersion:"0.0.0",autoUpdates:false})});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({status:"available",automaticUpdates:false});
});

it("a manual check bypasses the staged rollout; background checks keep it", async () => {
  vi.useFakeTimers();
  // Model the vendor: isUpdateAvailable asks isUserWithinRollout mid-check.
  updater.isUserWithinRollout = vi.fn(() => false);
  updater.checkForUpdates = vi.fn(async () => {
    if (await updater.isUserWithinRollout({version:"2.1.3", stagingPercentage: 10})) emitUpdate("update-available", {version:"2.1.3"});
    else emitUpdate("update-not-available", {version:"2.1.3"});
  });
  const {startUpdater,registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({fetchPolicy:async()=>({minimumVersion:null,autoUpdates:false})});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({status:"idle"});
  await handlers.get("update:check")(localEvent);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({status:"available",version:"2.1.3"});
  // The next hourly background check is rollout-gated again.
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
  expect(handlers.get("update:get-state")(localEvent)).toMatchObject({status:"idle"});
});

it("a required floor bypasses the staged rollout for background checks too", async () => {
  vi.useFakeTimers();
  updater.isUserWithinRollout = vi.fn(() => false);
  updater.checkForUpdates = vi.fn(async () => {});
  const {startUpdater,registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({fetchPolicy:async()=>({minimumVersion:"2.1.3",autoUpdates:false})});
  await vi.advanceTimersByTimeAsync(0);
  expect(updater.isUserWithinRollout({stagingPercentage: 1})).toBe(true);
});

it("refetches the update policy hourly; a later offline fetch keeps the last policy", async () => {
  vi.useFakeTimers();
  updater.checkForUpdates = vi.fn(async () => {});
  const policies = [null, {minimumVersion:null,autoUpdates:true}, null, {minimumVersion:"2.1.3",autoUpdates:false}, {minimumVersion:null,autoUpdates:false}];
  const fetchPolicy = vi.fn(async () => policies.shift());
  const {startUpdater,registerUpdaterIpc} = await import("./updater.mjs");
  registerUpdaterIpc();
  startUpdater({fetchPolicy});
  await vi.advanceTimersByTimeAsync(15_000);
  const state = () => handlers.get("update:get-state")(localEvent);
  expect(state()).toMatchObject({automaticUpdates:false});
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(state()).toMatchObject({automaticUpdates:true});
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(state()).toMatchObject({automaticUpdates:true});
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(state()).toMatchObject({automaticUpdates:true, required:true, minimumVersion:"2.1.3"});
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(state()).toMatchObject({automaticUpdates:false, required:false});
  expect(fetchPolicy).toHaveBeenCalledTimes(5);
});
