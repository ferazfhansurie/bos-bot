// A thread workspace tab (terminal, files, changes) moved into its own
// window. The window runs the same renderer from the same local origin, so
// the server's loopback auth and the preload bridge behave exactly as in the
// main window; the query parameter tells the renderer to draw only that tab.
// It gets no webview tag and no primary browser: the browser stays in the
// main window.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_SPEC = 4096;

export function createWorkspaceWindows({ BrowserWindow, shell, icon, preload, rendererArguments, externalWebUrl }) {
  const windows = new Set();

  function open(sender, rawSpec) {
    if (typeof rawSpec !== "string" || !rawSpec || rawSpec.length > MAX_SPEC) return false;
    try { JSON.parse(rawSpec); } catch { return false; }
    let origin;
    try { origin = new URL(sender.getURL()).origin; } catch { return false; }
    const owner = BrowserWindow.fromWebContents(sender);
    const bounds = owner && !owner.isDestroyed() ? owner.getBounds() : null;
    const win = new BrowserWindow({
      width: 820,
      height: 600,
      ...(bounds ? { x: bounds.x + 48, y: bounds.y + 48 } : {}),
      minWidth: 420,
      minHeight: 280,
      show: false,
      title: "BOS Bot",
      icon,
      backgroundColor: "#070707",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        preload,
        plugins: true,
        additionalArguments: rendererArguments(),
      },
    });
    windows.add(win);
    win.once("ready-to-show", () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
    win.once("closed", () => windows.delete(win));
    win.webContents.setWindowOpenHandler(({ url }) => {
      try { void shell.openExternal(externalWebUrl(url)).catch(() => {}); } catch {}
      return { action: "deny" };
    });
    const guard = (event, url) => {
      try { if (new URL(url).origin === origin) return; } catch {}
      event.preventDefault();
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", guard);
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const url = new URL("/", origin);
    url.searchParams.set("bos-detached", rawSpec);
    void win.loadURL(url.toString()).catch(() => {});
    return true;
  }

  /** Open a file from the workspace in another app. Only absolute paths
   * that exist; the editors are launched without a shell. */
  async function openIn(rawPath, app) {
    if (typeof rawPath !== "string" || !path.isAbsolute(rawPath) || rawPath.includes("\0")) return false;
    try { await fs.promises.access(rawPath); } catch { return false; }
    if (app === "reveal") { shell.showItemInFolder(rawPath); return true; }
    if (app === "default") return (await shell.openPath(rawPath)) === "";
    if (app !== "cursor" && app !== "vscode") return false;
    const [command, args] = process.platform === "darwin"
      ? ["open", ["-a", app === "cursor" ? "Cursor" : "Visual Studio Code", rawPath]]
      : [app === "cursor" ? "cursor" : "code", [rawPath]];
    return await new Promise((resolve) => {
      try {
        const child = spawn(command, args, { stdio: "ignore", detached: process.platform !== "win32", shell: false, windowsHide: true });
        child.once("error", () => resolve(false));
        child.once("exit", (code) => resolve(code === 0 || code === null));
        child.unref();
        // editors launched through their CLI keep running; treat a live child as opened
        setTimeout(() => resolve(true), 1500).unref?.();
      } catch {
        resolve(false);
      }
    });
  }

  return { open, openIn, closeAll: () => { for (const win of windows) if (!win.isDestroyed()) win.destroy(); } };
}
