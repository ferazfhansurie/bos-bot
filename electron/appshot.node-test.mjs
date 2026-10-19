import test from "node:test";
import assert from "node:assert/strict";
import { APPSHOT_SHORTCUT, appshotFileName, appshotPermission, appshotRows, createAppshots, windowNumber } from "./appshot.mjs";

const img = (label) => ({ label, isEmpty: () => !label, toJPEG: () => Buffer.from(label ?? ""), toPNG: () => Buffer.from(`png:${label}`) });
const encode = (image) => (image && !image.isEmpty() ? `data:${image.label}` : null);

test("windowNumber reads desktopCapturer and media source ids", () => {
  assert.equal(windowNumber("window:1234:0"), "1234");
  assert.equal(windowNumber("screen:1:0"), null);
  assert.equal(windowNumber(undefined), null);
});

test("rows keep other apps' windows in front-to-back order, then screens, and drop BOS, blank and untitled windows", () => {
  const rows = appshotRows([
    { id: "window:10:0", name: "Safari - Inbox", thumbnail: img("a"), appIcon: img("i") },
    { id: "window:20:0", name: "BOS Bot", thumbnail: img("b") },
    { id: "window:30:0", name: "Minimized", thumbnail: img(null) },
    { id: "window:40:0", name: "  ", thumbnail: img("c") },
    { id: "screen:1:0", name: "Entire Screen", thumbnail: img("s") },
    { id: "window:50:0", name: "Notes", thumbnail: img("d"), appIcon: img(null) },
  ], ["window:20:0"], encode);
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.icon]), [
    ["window:10:0", "window", "data:i"],
    ["window:50:0", "window", null],
    ["screen:1:0", "screen", null],
  ]);
});

test("permission: works when other windows are visible, even if the cached status says denied", () => {
  const rows = [{ kind: "window" }];
  assert.equal(appshotPermission({ platform: "darwin", status: "denied", rows, settingsOpened: false }), "ok");
  assert.equal(appshotPermission({ platform: "darwin", status: "granted", rows: [], settingsOpened: false }), "ok");
  assert.equal(appshotPermission({ platform: "darwin", status: "denied", rows: [{ kind: "screen" }], settingsOpened: false }), "needs-permission");
  assert.equal(appshotPermission({ platform: "darwin", status: "not-determined", rows: [], settingsOpened: true }), "needs-relaunch");
  assert.equal(appshotPermission({ platform: "win32", status: "denied", rows: [], settingsOpened: false }), "ok");
});

test("file names are readable and safe", () => {
  const at = new Date(2026, 9, 16, 19, 7);
  assert.equal(appshotFileName("Safari — Inbox (3) / Gmail", at), "appshot-safari-inbox-3-gmail-2026-10-16-1907.png");
  assert.equal(appshotFileName("../../", at), "appshot-screen-2026-10-16-1907.png");
});

function harness({ status = "granted", sources = [], register = () => true } = {}) {
  const calls = { getSources: 0, opened: [], registered: [], unregistered: [], sent: [], opacity: [] };
  const own = { isDestroyed: () => false, getMediaSourceId: () => "window:99:0", isVisible: () => true, getOpacity: () => 1, setOpacity: (v) => calls.opacity.push(v), webContents: { send: (...a) => calls.sent.push(a) } };
  const appshots = createAppshots({
    desktopCapturer: { getSources: async () => { calls.getSources++; return sources; } },
    systemPreferences: { getMediaAccessStatus: () => status },
    globalShortcut: { register: (acc, fn) => { calls.registered.push(acc); calls.fire = fn; return register(); }, unregister: (acc) => calls.unregistered.push(acc) },
    BrowserWindow: { getAllWindows: () => [own] },
    screen: { getAllDisplays: () => [{ size: { width: 1512, height: 982 }, scaleFactor: 2 }] },
    shell: { openExternal: async (url) => calls.opened.push(url) },
    platform: "darwin",
    mainWindow: () => own,
    showsLocalUi: () => true,
    focusMain: () => { calls.focused = true; },
  });
  return { appshots, calls };
}

test("without a grant the listing is attempted once per process, never again (no prompt loops)", async () => {
  const { appshots, calls } = harness({ status: "denied", sources: [{ id: "screen:1:0", name: "Entire Screen", thumbnail: img("s") }] });
  assert.equal((await appshots.list()).permission, "needs-permission");
  assert.equal((await appshots.list()).permission, "needs-permission");
  assert.equal(calls.getSources, 1);
  await appshots.openSettings();
  assert.deepEqual(calls.opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
  assert.equal((await appshots.list()).permission, "needs-relaunch");
  assert.equal(calls.getSources, 1);
});

test("capture only works on a listed id, and a screen grab fades BOS out and back", async () => {
  const sources = [{ id: "window:10:0", name: "Safari", thumbnail: img("a") }, { id: "screen:1:0", name: "Entire Screen", thumbnail: img("s") }, { id: "window:99:0", name: "BOS Bot", thumbnail: img("b") }];
  const { appshots, calls } = harness({ sources });
  const listing = await appshots.list();
  assert.deepEqual(listing.rows.map((r) => r.id), ["window:10:0", "screen:1:0"]);
  await assert.rejects(appshots.capture("window:99:0"), /no longer in the list/);
  const shot = await appshots.capture("window:10:0");
  assert.match(shot.name, /^appshot-safari-/);
  assert.equal(String(shot.data), "png:a");
  assert.deepEqual(calls.opacity, []);
  await appshots.capture("screen:1:0");
  assert.deepEqual(calls.opacity, [0, 1]);
});

test("the global shortcut registers once, lists before focusing BOS, and unregisters on quit", async () => {
  const { appshots, calls } = harness({ sources: [{ id: "window:10:0", name: "Safari", thumbnail: img("a") }] });
  assert.equal(appshots.register(), true);
  assert.equal(appshots.register(), true);
  assert.deepEqual(calls.registered, [APPSHOT_SHORTCUT]);
  await appshots.onShortcut();
  assert.equal(calls.sent[0][0], "appshot:open");
  assert.equal(calls.sent[0][1].rows[0].id, "window:10:0");
  assert.equal(calls.sent[0][1].shortcut, APPSHOT_SHORTCUT);
  assert.equal(calls.focused, true);
  appshots.unregister();
  assert.deepEqual(calls.unregistered, [APPSHOT_SHORTCUT]);
});

test("a shortcut another app owns is reported, not retried", () => {
  const { appshots } = harness({ register: () => false });
  assert.equal(appshots.register(), false);
});
