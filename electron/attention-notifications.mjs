// Native notifications for the moments a bot needs the person: an approval,
// a question, a finished turn, a bot's own message. The renderer decides what
// is worth showing (its preferences, the server's per-bot switch); this owns
// how it is shown on this computer: one banner per id, approve/deny buttons,
// reply-from-banner, a chosen sound, and a dock bounce plus one re-notify for
// the kinds that must not be missed.
//
// macOS decides whether a banner stays on screen (the user's alert style for
// the app), so approvals and questions cannot be forced sticky there. They get
// a critical dock bounce while no BOS window is focused and come back once
// if still unanswered after RENOTIFY_MS. On Windows and Linux they never time
// out on their own.
import { app, BrowserWindow, ipcMain, nativeImage, Notification } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";

const KINDS = new Set(["approval", "question", "done", "message"]);
const STICKY = new Set(["approval", "question"]);
const SYSTEM_SOUNDS = new Set(["Glass", "Ping", "Tink", "Pop"]);
const RENOTIFY_MS = 5 * 60_000;
const SEEN_TTL_MS = 30 * 60_000;
const MAX_TEXT = 2000;

function text(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function anyWindowFocused() {
  return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused());
}

function iconFrom(value) {
  if (typeof value !== "string" || !value.startsWith("data:image/")) return undefined;
  try {
    const image = nativeImage.createFromDataURL(value);
    return image.isEmpty() ? undefined : image;
  } catch {
    return undefined;
  }
}

function playSound(name) {
  if (process.platform !== "darwin" || !SYSTEM_SOUNDS.has(name)) return;
  const file = `/System/Library/Sounds/${name}.aiff`;
  if (!fs.existsSync(file)) return;
  try {
    const child = spawn("/usr/bin/afplay", [file], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** Validates one renderer request; anything malformed is dropped. */
function parsePayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id, 300);
  const kind = text(raw.kind, 20);
  if (!id || !KINDS.has(kind)) return null;
  const sound = text(raw.sound, 20);
  const done = raw.done === "always" ? "always" : raw.done === "off" ? "off" : "unfocused";
  return {
    id,
    kind,
    title: text(raw.title, 200) || "BOS Bot",
    subtitle: text(raw.subtitle, 200),
    body: text(raw.body),
    icon: iconFrom(raw.icon),
    groupId: text(raw.groupId, 200) || undefined,
    sound: sound === "none" || sound === "default" || SYSTEM_SOUNDS.has(sound) ? sound : "default",
    done,
    canReply: raw.canReply === true,
    replyPlaceholder: text(raw.replyPlaceholder, 80) || undefined,
    approveText: text(raw.approveText, 30) || "approve",
    denyText: text(raw.denyText, 30) || "deny",
  };
}

export function registerAttentionNotifications({ mainWindow }) {
  /** id -> { notification, payload, timer } for banners not yet handled. */
  const live = new Map();
  /** id -> shown-at, so a re-sent frame for the same thing never re-banners. */
  const seen = new Map();
  let bounceId = null;

  const send = (event) => {
    const win = mainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send("attention:event", event);
    } catch {}
  };

  const stopBounce = () => {
    if (bounceId === null) return;
    try {
      app.dock?.cancelBounce(bounceId);
    } catch {}
    bounceId = null;
  };

  const forget = (id, { close } = { close: true }) => {
    const entry = live.get(id);
    if (!entry) return;
    live.delete(id);
    clearTimeout(entry.timer);
    if (close) {
      try {
        entry.notification.close();
      } catch {}
    }
    if (![...live.values()].some((item) => STICKY.has(item.payload.kind))) stopBounce();
  };

  const prune = () => {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [id, at] of seen) if (at < cutoff && !live.has(id)) seen.delete(id);
  };

  const show = (payload, { again = false } = {}) => {
    const sticky = STICKY.has(payload.kind);
    const silent = payload.sound !== "default";
    const options = {
      title: payload.title,
      body: payload.body,
      silent,
      ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
      ...(payload.icon ? { icon: payload.icon } : {}),
      ...(process.platform === "darwin" ? { id: payload.id } : {}),
      ...(payload.groupId && process.platform === "darwin" ? { groupId: payload.groupId } : {}),
      ...(payload.canReply ? { hasReply: true, replyPlaceholder: payload.replyPlaceholder } : {}),
      ...(payload.kind === "approval"
        ? {
          actions: [
            { type: "button", text: payload.approveText },
            { type: "button", text: payload.denyText },
          ],
          closeButtonText: "later",
        }
        : {}),
      ...(sticky && process.platform !== "darwin" ? { timeoutType: "never", urgency: "critical" } : {}),
    };
    let notification;
    try {
      notification = new Notification(options);
    } catch {
      return false;
    }
    notification.on("click", () => {
      send({ type: "open", id: payload.id });
      // A plain done/message banner is handled by opening it; an approval
      // or question stays tracked until its card is answered.
      if (!sticky) forget(payload.id, { close: false });
    });
    notification.on("reply", (details, legacyReply) => {
      const reply = typeof details?.reply === "string" ? details.reply : legacyReply;
      if (typeof reply !== "string" || !reply.trim()) return;
      send({ type: "reply", id: payload.id, text: reply.slice(0, 20_000) });
      forget(payload.id, { close: false });
    });
    notification.on("action", (details, legacyIndex) => {
      const index = typeof details?.actionIndex === "number" ? details.actionIndex : legacyIndex;
      if (index !== 0 && index !== 1) return;
      send({ type: "action", id: payload.id, action: index === 0 ? "approve" : "deny" });
      forget(payload.id, { close: false });
    });
    notification.on("close", () => {
      // Closing a done/message banner is the end of it; an unanswered
      // approval or question still gets its one reminder.
      if (!sticky) forget(payload.id, { close: false });
    });
    notification.on("failed", () => forget(payload.id, { close: false }));

    const previous = live.get(payload.id);
    if (previous) clearTimeout(previous.timer);
    const timer = sticky && !again
      ? setTimeout(() => {
        const entry = live.get(payload.id);
        if (!entry || anyWindowFocused()) return;
        try {
          entry.notification.close();
        } catch {}
        show(entry.payload, { again: true });
      }, RENOTIFY_MS)
      : undefined;
    timer?.unref?.();
    live.set(payload.id, { notification, payload, timer });
    notification.show();
    if (silent && payload.sound !== "none") playSound(payload.sound);
    if (sticky && process.platform === "darwin" && !anyWindowFocused() && bounceId === null) {
      try {
        bounceId = app.dock?.bounce("critical") ?? null;
      } catch {}
    }
    return true;
  };

  const fromMainWindow = (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const win = mainWindow();
    return Boolean(sender && win && sender === win && !sender.isDestroyed());
  };

  ipcMain.handle("attention:notify", (event, raw) => {
    if (!fromMainWindow(event) || !Notification.isSupported()) return false;
    const payload = parsePayload(raw);
    if (!payload) return false;
    // Handled here rather than as "not shown": the renderer must not fall
    // back to a web banner for something deliberately skipped.
    if (seen.has(payload.id)) return true;
    if (payload.kind === "done" && (payload.done === "off" || (payload.done === "unfocused" && anyWindowFocused()))) return true;
    prune();
    seen.set(payload.id, Date.now());
    return show(payload);
  });

  ipcMain.on("attention:dismiss", (event, id) => {
    if (!fromMainWindow(event) || typeof id !== "string") return;
    forget(id);
    try {
      if (process.platform === "darwin") Notification.remove(id);
    } catch {}
  });

  app.on("browser-window-focus", stopBounce);
}
