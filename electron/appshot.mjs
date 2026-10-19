// Appshots: ChatGPT-style "attach a window" for the composer. A global
// shortcut (or the composer's attach menu) lists the open app windows as
// thumbnails; the person picks one (or the whole screen) and only then is a
// full-size image captured and handed to the composer as an attachment.
//
// Permissions. Capture runs in this (main) process through desktopCapturer,
// so macOS attributes it to BOS Bot's existing Screen Recording grant — the
// same one computer use and the screen preview rely on. Nothing here runs on
// launch: the first getSources() call, made only when the person opens the
// picker, is the one moment macOS may prompt. getMediaAccessStatus("screen")
// caches per process on macOS 15+ (it stays "denied" until relaunch after a
// grant, and capture itself keeps failing until then), and Sequoia+ asks
// again for periodic re-consent at capture time on its own. So: when the
// status is not "granted" we attempt one listing per process and never again
// (no prompt loops), and after the person opens System Settings from here the
// picker tells them to quit and reopen BOS instead of re-prompting.

/** Global shortcut. ⌘⇧3/4/5/6 are macOS screenshots and ChatGPT uses a
 * double-tap of ⌥, so ⌘⇧2 sits next to the system keys without clashing. */
export const APPSHOT_SHORTCUT = "CommandOrControl+Shift+2";
export const APPSHOT_PRIVACY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MAX_WINDOWS = 24;
const THUMB = { width: 480, height: 300 };

/** "window:1234:0" -> "1234"; anything else -> null. */
export function windowNumber(id) {
  const match = /^window:(\d+):/.exec(String(id ?? ""));
  return match ? match[1] : null;
}

/**
 * Turns desktopCapturer sources into picker rows: other apps' windows in the
 * order macOS reports them (front to back), then screens. BOS's own windows,
 * minimized/blank windows and untitled helper surfaces are left out.
 * `encode(image)` returns a data URL or null for an empty image.
 */
export function appshotRows(sources, ownMediaIds, encode) {
  const own = new Set([...ownMediaIds].map(windowNumber).filter(Boolean));
  const windows = [];
  const screens = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = String(source?.id ?? "");
    const thumbnail = encode(source?.thumbnail);
    if (!thumbnail) continue;
    if (id.startsWith("screen:")) {
      screens.push({ id, kind: "screen", title: String(source.name || "Entire screen"), thumbnail, icon: null });
      continue;
    }
    const number = windowNumber(id);
    const title = String(source?.name ?? "").trim();
    if (!number || own.has(number) || !title) continue;
    if (windows.length >= MAX_WINDOWS) continue;
    windows.push({ id, kind: "window", title, thumbnail, icon: encode(source.appIcon) });
  }
  return [...windows, ...screens];
}

/**
 * What the picker should say about Screen Recording.
 * - "ok": other apps' windows are visible, so capture works.
 * - "needs-relaunch": the person already went to System Settings from here;
 *   macOS only applies a new grant after BOS quits and reopens.
 * - "needs-permission": nothing beyond BOS itself is visible and the status
 *   is not granted, so the grant is missing (or was revoked / expired).
 * A granted status with no other windows is "ok": there may simply be no
 * other window open, and the screen row still works.
 */
export function appshotPermission({ platform, status, rows, settingsOpened }) {
  if (platform !== "darwin") return "ok";
  if (rows.some(row => row.kind === "window")) return "ok";
  if (status === "granted") return "ok";
  return settingsOpened ? "needs-relaunch" : "needs-permission";
}

/** A safe, readable attachment name: "appshot-safari-2026-10-16-1907.png". */
export function appshotFileName(title, now = new Date()) {
  const slug = String(title ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "screen";
  const pad = n => String(n).padStart(2, "0");
  return `appshot-${slug}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
}

function encodeThumb(image) {
  if (!image || typeof image.isEmpty !== "function" || image.isEmpty()) return null;
  return `data:image/jpeg;base64,${image.toJPEG(78).toString("base64")}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wires the appshot IPC and shortcut. `deps` carries the electron modules so
 * the pure parts above stay testable without electron.
 */
export function createAppshots({ desktopCapturer, systemPreferences, globalShortcut, BrowserWindow, screen, shell, platform, mainWindow, showsLocalUi, focusMain, log }) {
  let listedWithoutGrant = false;
  let settingsOpened = false;
  let registered = false;
  let lastRows = new Map();

  const status = () => platform === "darwin" ? systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown" : "granted";
  const ownIds = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => w.getMediaSourceId());

  async function list() {
    const current = status();
    // One attempt per process without a grant: a denied listing can raise the
    // macOS prompt, and repeating it would nag. After that, report the state.
    if (current !== "granted" && listedWithoutGrant) {
      return { permission: appshotPermission({ platform, status: current, rows: [], settingsOpened }), rows: [], shortcut: registered ? APPSHOT_SHORTCUT : null };
    }
    if (current !== "granted") listedWithoutGrant = true;
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: THUMB, fetchWindowIcons: true });
    } catch (error) {
      log?.(`appshot listing failed: ${error?.message ?? error}`);
    }
    const rows = appshotRows(sources, ownIds(), encodeThumb);
    const permission = appshotPermission({ platform, status: current, rows, settingsOpened });
    const visible = permission === "ok" ? rows : [];
    lastRows = new Map(visible.map(row => [row.id, row]));
    return { permission, rows: visible, shortcut: registered ? APPSHOT_SHORTCUT : null };
  }

  /** Full-size capture of one listed source, only after the person picked it. */
  async function capture(id) {
    const row = typeof id === "string" ? lastRows.get(id) : undefined;
    if (!row) throw new Error("That window is no longer in the list. Open appshots again.");
    const largest = screen.getAllDisplays().reduce((best, d) => {
      const w = Math.round(d.size.width * d.scaleFactor), h = Math.round(d.size.height * d.scaleFactor);
      return w * h > best.width * best.height ? { width: w, height: h } : best;
    }, { width: 1920, height: 1080 });
    // A whole-screen shot would otherwise show BOS's own window on top: fade
    // BOS out for the grab (no focus change), then fade back.
    const faded = row.kind === "screen"
      ? BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.isVisible() && w.getOpacity() > 0)
      : [];
    try {
      for (const w of faded) w.setOpacity(0);
      if (faded.length) await sleep(180);
      const sources = await desktopCapturer.getSources({ types: [row.kind], thumbnailSize: largest, fetchWindowIcons: false });
      const source = sources.find(s => s.id === row.id);
      if (!source || source.thumbnail.isEmpty()) throw new Error(row.kind === "window" ? "That window closed or was minimized." : "Could not capture the screen.");
      return { name: appshotFileName(row.kind === "screen" ? "screen" : row.title), data: source.thumbnail.toPNG() };
    } finally {
      for (const w of faded) if (!w.isDestroyed()) w.setOpacity(1);
    }
  }

  async function openSettings() {
    if (platform !== "darwin") return false;
    settingsOpened = true;
    await shell.openExternal(APPSHOT_PRIVACY_PANE);
    return true;
  }

  /** The shortcut lists windows while the other app is still in front (so
   * the first row is the window he was looking at), then brings BOS up. */
  async function onShortcut() {
    const win = mainWindow();
    if (!win || win.isDestroyed() || !showsLocalUi()) return;
    const result = await list();
    win.webContents.send("appshot:open", { ...result, source: "shortcut" });
    focusMain(win);
  }

  function register() {
    if (registered || (platform !== "darwin" && platform !== "win32")) return registered;
    try {
      registered = globalShortcut.register(APPSHOT_SHORTCUT, () => { void onShortcut(); });
    } catch (error) {
      registered = false;
      log?.(`appshot shortcut failed: ${error?.message ?? error}`);
    }
    if (!registered) log?.(`appshot shortcut ${APPSHOT_SHORTCUT} is taken by another app`);
    return registered;
  }

  function unregister() {
    if (!registered) return;
    try { globalShortcut.unregister(APPSHOT_SHORTCUT); } catch {}
    registered = false;
  }

  return { list, capture, openSettings, register, unregister, onShortcut };
}
