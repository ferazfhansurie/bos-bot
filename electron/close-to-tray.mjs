import { compatEnvironment } from "./branding-env.cjs";
// Windows close-to-tray, kept Electron-free so the rules stay unit-testable.
//
// On Windows the window IS the app: closing it fired window-all-closed and
// quit the embedded server, routines, phone link and computer use. With a tray
// icon, closing the main window only hides it; "Quit" (tray menu, app menu,
// updater, signals, Windows shutdown) still runs the normal before-quit path.
// If the tray can't be created the old behaviour stands, so the app is never
// left running with no way back to it.

export function closeToTrayEnabled({ platform, env }) {
  // Smoke runs close the window to end the app; keep that path intact.
  return platform === "win32" && compatEnvironment(env).OMB_SMOKE_TEST !== "1";
}

export function createCloseToTray({ createTray, buildMenu, title, onOpen, onQuit, log = () => {} }) {
  let quitting = false;
  let hinted = false;
  let tray = null;
  try {
    tray = createTray();
    tray.setToolTip(title);
    tray.setContextMenu(buildMenu([
      { label: `Open ${title}`, click: onOpen },
      { type: "separator" },
      { label: `Quit ${title}`, click: onQuit },
    ]));
    tray.on("click", onOpen);
  } catch (error) {
    log(`tray unavailable, closing the window will quit: ${error?.message ?? error}`);
    try { tray?.destroy(); } catch {}
    tray = null;
  }
  return {
    get active() {
      return tray !== null;
    },
    // Called from before-quit and Windows session end: from here on a window
    // close is a real close.
    markQuitting() {
      quitting = true;
    },
    // Returns true when the close was turned into a hide.
    handleClose(event, win) {
      if (quitting || !tray || win.isDestroyed()) return false;
      event.preventDefault();
      win.hide();
      if (!hinted) {
        hinted = true;
        try {
          tray.displayBalloon({
            iconType: "info",
            title: `${title} is still running`,
            content: "Bots, routines and your phone link keep working. Right-click the tray icon and choose Quit to stop them.",
          });
        } catch {}
      }
      return true;
    },
    destroy() {
      try { tray?.destroy(); } catch {}
      tray = null;
    },
  };
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
