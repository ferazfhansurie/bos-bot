// The notch: a small live view of the team at the top of the screen. It
// answers three questions only: who is working, who needs me, what just
// finished. The main window's renderer already knows all of that, so it
// sends a snapshot here; this file owns the window that draws it, the native
// helper that finds the camera housing, and the actions the person takes.
//
// The window never resizes. It is a fixed transparent panel hung from the top
// edge, centred on the notch, and lets every click through except while the
// pointer is on the drawn shape. Growing and shrinking happen in the page,
// so a size change can never cost a frame of native resize jitter.
//
// On a Mac without a notch (or when the menu-bar screen is an external
// monitor) the same page draws a black pill instead, and only while it has
// something to show.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The page draws inside this box; it is the open shelf's ceiling. */
export const NOTCH_WINDOW = { width: 760, height: 520 };
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_TEXT = 20_000;
const SOUND = "/System/Library/Sounds/Tink.aiff";
const HELPER_RESTARTS = 3;

const text = (value, max = 400) => (typeof value === "string" ? value.slice(0, max) : "");
const id = (value) => (typeof value === "string" && /^[\w:.-]{1,200}$/.test(value) ? value : "");

/** One action from the notch page, or null. The main window re-checks
 * each against its own state before acting. Drops never come this way. */
export function parseNotchAction(raw) {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.type) {
    case "open": {
      const botId = id(raw.botId);
      const threadId = id(raw.threadId);
      return botId ? { type: "open", botId, threadId } : null;
    }
    case "answer": {
      const askId = text(raw.askId, 600);
      if (!askId) return null;
      const answer = raw.answer;
      if (answer?.behavior === "allow" || answer?.behavior === "deny") return { type: "answer", askId, answer: { behavior: answer.behavior } };
      if (typeof answer?.option === "string" && answer.option.trim()) return { type: "answer", askId, answer: { option: text(answer.option, 2000) } };
      if (typeof answer?.text === "string" && answer.text.trim()) return { type: "answer", askId, answer: { text: text(answer.text, MAX_TEXT) } };
      return null;
    }
    default:
      return null;
  }
}

/** Files dropped on a bot, from the preload's own reading of the dropped
 * File objects (notch:drop), or null. Each must still be a real file. */
export function parseNotchDrop(raw) {
  if (!raw || typeof raw !== "object") return null;
  const botId = id(raw.botId);
  const threadId = id(raw.threadId);
  const files = Array.isArray(raw.files)
    ? raw.files.slice(0, 20).flatMap((file) => {
      const filePath = text(file?.path, 4096);
      if (!filePath || !path.isAbsolute(filePath)) return [];
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? [{ name: text(file.name, 300) || path.basename(filePath), path: filePath, size: stat.size }] : [];
      } catch {
        return [];
      }
    })
    : [];
  return botId && threadId && files.length ? { type: "drop", botId, threadId, files } : null;
}

/** Which screen carries the notch, and how. The menu-bar screen wins: that
 * is where the person looks, lid open or shut. Its camera housing, when it
 * has one, gives the shape; otherwise a pill. */
export function pickNotchScreen(helperScreens, primary) {
  const match = helperScreens.find((candidate) => candidate.id === primary.id);
  const notch = match?.notch && match.notch.width > 0 && match.notch.height > 0 ? match.notch : null;
  const bounds = primary.bounds;
  if (notch) {
    return {
      mode: "notch",
      displayId: primary.id,
      bounds,
      centre: bounds.x + notch.x + notch.width / 2,
      notch: { width: notch.width, height: notch.height },
      menuBar: match.menuBar ?? 0,
    };
  }
  const menuBar = match ? match.menuBar ?? 0 : Math.max(0, primary.workArea.y - bounds.y);
  return {
    mode: "pill",
    displayId: primary.id,
    bounds,
    centre: bounds.x + bounds.width / 2,
    // the pill is as tall as the menu bar it sits in, never a sliver
    notch: { width: 0, height: menuBar > 0 ? menuBar : 24 },
    menuBar,
  };
}

function helperPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "notch-helper") : path.join(here, "resources", "notch-helper");
}

/** Dev only: the helper is a build product, so rebuild it when its source is newer. */
async function ensureDevHelper() {
  if (app.isPackaged) return;
  const binary = helperPath();
  const source = path.join(here, "resources", "notch-helper.swift");
  let stale = true;
  try {
    stale = fs.statSync(source).mtimeMs > fs.statSync(binary).mtimeMs;
  } catch {}
  if (!stale) return;
  try {
    const { buildNotchHelper } = await import("./build-notch-helper.mjs");
    buildNotchHelper();
  } catch (error) {
    console.error("[notch] helper build failed:", error?.message ?? error);
  }
}

export function registerNotch({ mainWindow, pageUrl, focusMain, preload = path.join(here, "notch-preload.cjs") }) {
  if (process.platform !== "darwin") {
    ipcMain.on("notch:enable", () => {});
    ipcMain.on("notch:snapshot", () => {});
    return { dispose() {} };
  }

  let enabled = false;
  let win = null;
  let helper = null;
  let helperRestarts = 0;
  let helperScreens = [];
  let placement = null;
  let snapshot = null;
  let interactive = false;
  let sensorKey = "";
  let sensor = null;
  const heardAsks = new Set();

  const fromMain = (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const main = mainWindow();
    return Boolean(sender && main && sender === main && !sender.isDestroyed());
  };
  const fromNotch = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents);

  const toNotch = (channel, value) => {
    // sent even mid-load: the page's preload keeps the latest, and a send
    // made before it ran is covered by the page's hello
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, value);
    } catch {}
  };

  const writeHelper = (command) => {
    if (!helper?.stdin?.writable) return;
    try {
      helper.stdin.write(`${JSON.stringify(command)}\n`);
    } catch {}
  };

  /** The sensor follows the drawn shape: the notch alone at rest, notch plus
   * wings while bots are working. The page reports the width. */
  const placeSensor = () => {
    const next = placement && sensor && win?.isVisible()
      ? { type: "sensor", screen: placement.displayId, x: Math.round(placement.centre - placement.bounds.x - sensor.width / 2), width: Math.round(sensor.width), height: Math.round(sensor.height) }
      : { type: "sensor", screen: null };
    const key = JSON.stringify(next);
    if (key === sensorKey) return;
    sensorKey = key;
    writeHelper(next);
  };

  const setInteractive = (on) => {
    if (!win || win.isDestroyed() || interactive === on) return;
    interactive = on;
    win.setIgnoreMouseEvents(!on);
  };

  const geometry = () => placement && {
    mode: placement.mode,
    notch: placement.notch,
    menuBar: placement.menuBar,
    window: NOTCH_WINDOW,
  };

  const place = () => {
    if (!win || win.isDestroyed()) return;
    const next = pickNotchScreen(helperScreens, screen.getPrimaryDisplay());
    placement = next;
    win.setBounds({
      x: Math.round(next.centre - NOTCH_WINDOW.width / 2),
      y: next.bounds.y,
      width: NOTCH_WINDOW.width,
      height: NOTCH_WINDOW.height,
    });
    toNotch("notch:geometry", geometry());
    placeSensor();
  };

  const startHelper = () => {
    if (helper) return;
    const binary = helperPath();
    if (!fs.existsSync(binary)) {
      // no helper: the electron screen alone, which can't see the notch
      helperScreens = [];
      place();
      return;
    }
    let child;
    try {
      child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return;
    }
    helper = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.type === "screens" && Array.isArray(message.screens)) {
          helperScreens = message.screens;
          place();
        } else if (message?.type === "hover" && (message.phase === "enter" || message.phase === "exit")) {
          // the page owns leaving once it has the pointer; an exit that
          // arrives because the panel took over is not the person leaving
          if (message.phase === "enter") setInteractive(true);
          toNotch("notch:pointer", { kind: "hover", phase: message.phase });
        } else if (message?.type === "drag" && (message.phase === "enter" || message.phase === "exit")) {
          if (message.phase === "enter") setInteractive(true);
          toNotch("notch:pointer", { kind: "drag", phase: message.phase });
        }
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    child.on("exit", () => {
      if (helper !== child) return;
      helper = null;
      sensorKey = "";
      if (enabled && helperRestarts < HELPER_RESTARTS) {
        helperRestarts += 1;
        setTimeout(() => enabled && startHelper(), 1000 * helperRestarts).unref?.();
      }
    });
  };

  const stopHelper = () => {
    const child = helper;
    helper = null;
    sensorKey = "";
    try {
      child?.stdin?.end();
    } catch {}
    setTimeout(() => {
      try {
        if (child && child.exitCode === null) child.kill();
      } catch {}
    }, 1500).unref?.();
  };

  const chime = (next) => {
    const asks = Array.isArray(next?.asks) ? next.asks : [];
    let fresh = false;
    for (const ask of asks) {
      if (typeof ask?.id !== "string" || heardAsks.has(ask.id)) continue;
      heardAsks.add(ask.id);
      if (ask.chime === true) fresh = true;
    }
    const live = new Set(asks.map((ask) => ask?.id));
    for (const seen of heardAsks) if (!live.has(seen)) heardAsks.delete(seen);
    if (!fresh || !fs.existsSync(SOUND)) return;
    try {
      const child = spawn("/usr/bin/afplay", ["-v", "0.35", SOUND], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } catch {}
  };

  const create = () => {
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({
      ...NOTCH_WINDOW,
      x: 0,
      y: 0,
      type: "panel",
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // the panel sits over the menu bar; without this macOS pushes it below
      enableLargerThanScreen: true,
      focusable: true,
      acceptFirstMouse: true,
      roundedCorners: false,
      title: "BOS notch",
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    interactive = true;
    setInteractive(false);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("did-finish-load", () => {
      toNotch("notch:geometry", geometry());
      if (snapshot) toNotch("notch:snapshot", snapshot);
    });
    win.webContents.on("render-process-gone", () => {
      const dead = win;
      win = null;
      try {
        dead?.destroy();
      } catch {}
      if (enabled) setTimeout(() => enabled && create(), 2000).unref?.();
    });
    win.on("closed", () => {
      win = null;
    });
    win.once("ready-to-show", () => {
      if (!win || win.isDestroyed()) return;
      place();
      win.showInactive();
      placeSensor();
    });
    void win.loadURL(pageUrl()).catch(() => {});
    void ensureDevHelper().then(() => enabled && startHelper());
  };

  const destroy = () => {
    stopHelper();
    const old = win;
    win = null;
    placement = null;
    try {
      old?.destroy();
    } catch {}
  };

  // screen can't be touched before app ready; the renderer's first enable
  // always comes after it
  const onDisplays = () => place();
  let watchingDisplays = false;
  const watchDisplays = (on) => {
    if (on === watchingDisplays) return;
    watchingDisplays = on;
    for (const name of ["display-added", "display-removed", "display-metrics-changed"]) {
      if (on) screen.on(name, onDisplays);
      else screen.off(name, onDisplays);
    }
  };

  ipcMain.on("notch:enable", (event, on) => {
    if (!fromMain(event)) return;
    const next = on === true;
    if (next === enabled) return;
    enabled = next;
    helperRestarts = 0;
    watchDisplays(enabled);
    if (enabled) create();
    else destroy();
  });

  ipcMain.on("notch:snapshot", (event, raw) => {
    if (!fromMain(event) || typeof raw !== "string" || raw.length > MAX_SNAPSHOT_BYTES) return;
    let next;
    try {
      next = JSON.parse(raw);
    } catch {
      return;
    }
    snapshot = next;
    chime(next);
    toNotch("notch:snapshot", next);
  });

  // the page asks once its bridge is up: a send made while it was still
  // loading (geometry from ready-to-show, a snapshot) may have gone nowhere
  ipcMain.on("notch:hello", (event) => {
    if (!fromNotch(event)) return;
    if (!placement) place();
    try {
      event.sender.send("notch:geometry", geometry());
      if (snapshot) event.sender.send("notch:snapshot", snapshot);
    } catch {}
  });

  ipcMain.on("notch:interactive", (event, on) => {
    if (!fromNotch(event)) return;
    // typing an answer needs the panel to take keys; a panel never activates the app
    if (on === "keys") {
      setInteractive(true);
      if (win && !win.isDestroyed()) win.focus();
      return;
    }
    setInteractive(on === true);
  });

  ipcMain.on("notch:shape", (event, raw) => {
    if (!fromNotch(event)) return;
    const width = Number(raw?.width);
    const height = Number(raw?.height);
    sensor = Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1
      ? { width: Math.min(width, NOTCH_WINDOW.width), height: Math.min(height, NOTCH_WINDOW.height) }
      : null;
    placeSensor();
  });

  ipcMain.on("notch:action", (event, raw) => {
    if (!fromNotch(event)) return;
    const action = parseNotchAction(raw);
    if (!action) return;
    const main = mainWindow();
    if (!main || main.isDestroyed()) return;
    if (action.type === "open") focusMain();
    try {
      main.webContents.send("notch:action", action);
    } catch {}
  });

  ipcMain.on("notch:drop", (event, raw) => {
    if (!fromNotch(event)) return;
    const drop = parseNotchDrop(raw);
    const main = mainWindow();
    if (!drop || !main || main.isDestroyed()) return;
    focusMain();
    try {
      main.webContents.send("notch:action", drop);
    } catch {}
  });

  return {
    dispose() {
      enabled = false;
      destroy();
      watchDisplays(false);
    },
  };
}
