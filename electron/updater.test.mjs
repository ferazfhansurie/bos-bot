import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The updater channels answer only the local UI (electron/local-origin.cjs).
const localEvent = { senderFrame: { url: "http://127.0.0.1:8799/" } };

const { updater, handlers, readCapability, loadVendor } = vi.hoisted(() => {
  const updater = { on: vi.fn(), downloadUpdate: vi.fn(), setFeedURL: vi.fn() };
  return { updater, handlers: new Map(), readCapability: vi.fn(), loadVendor: vi.fn(() => ({ autoUpdater: updater })) };
});

vi.mock("./updater-capability.mjs", () => ({ readUpdaterCapability: readCapability }));

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused-updater-test-log" },
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
  startUpdater();
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
  startUpdater();
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
