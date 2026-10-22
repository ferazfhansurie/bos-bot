// Desktop notifications, driven by the harness's {kind:"notify"} frames.
// The server decides *whether* something is worth an interruption (it owns
// the per-bot toggle); this only decides how to show it here.
import type { Notification } from "../../shared/notification";
import { botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar";
import { flatMascotBody } from "../../shared/flat-mascot-bodies";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { resolveMausColor } from "../../shared/glyph-faces";
import { botMascotEyes, type MascotEyes } from "../../shared/mascot-eyes";
import { glyphFaceMarkup, glyphFaceParts } from "./glyph-face";
import { type MausColor } from "./mascot";
import { attentionPreferences, type DoneNotifyMode, type NotifySound } from "./attention-preferences";
import { notchActive } from "@/notch/active";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** Ask while handling the settings click. Browsers may reject permission
 * requests that are triggered later by an incoming SSE frame. */
export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return null;
  return Notification.requestPermission();
}

/** The identity a notification groups under: one bot, wherever it was
 * working. Keyed by bot rather than thread so a single bot running across
 * tasks and rooms coalesces into one stack instead of stacking banners. */
export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

/** Presentation options for one bot's notifications: the stable per-bot
 * coalescing key platforms replace on (`tag`) and its avatar, when the
 * profile has one. Pure so the grouping rule stays testable on its own. */
export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

/** What a notification shows as the sending bot's face: the same choice
 * BotAvatar makes in the app, so a room's banners carry whoever spoke. */
export interface NotificationAvatarBot {
  id: string;
  color: MausColor;
  avatarUrl?: string | null;
  avatarCrop?: BotAvatarCrop;
  mascotBody?: MascotBodyId | null;
  mascotEyes?: MascotEyes | null;
}

/** The bot's photo when its profile shows one; otherwise null, and the
 * mascot is drawn instead. */
export function notificationPhoto(bot: Pick<NotificationAvatarBot, "avatarUrl" | "avatarCrop">): string | null {
  const profile = botAvatarProfile(bot);
  return profile.avatarUrl && profile.avatarCrop !== "mascot" ? profile.avatarUrl : null;
}

/** The resting mascot as standalone SVG markup: body in the bot's colour,
 * the resting glyph face (or the two-stroke face for a bot that picked
 * another eye style). Mirrors MausAvatar's static render. */
export function mascotSvg(color: MausColor, bodyId?: MascotBodyId | null, eyes?: MascotEyes | null): string {
  const body = flatMascotBody(bodyId ?? "circle");
  const fill = resolveMausColor(color);
  const face = botMascotEyes(eyes) === "glyph"
    ? glyphFaceMarkup(glyphFaceParts({ state: "idle", color: fill, centre: [50 + body.faceX, 50 + body.faceY], diameter: 80, pixels: 102 }))
    : `<g transform="translate(${body.faceX} ${body.faceY})" fill="none" stroke="#151515" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M 51 43 L 54 52"/><path d="M 73 39 L 76 48"/></g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100">` +
    `<path d="${body.path}" fill="${fill}"/>` + face + `</svg>`
  );
}

const mascotIcons = new Map<string, Promise<string | undefined>>();

/** OS notification centres do not draw SVG, so the mascot is rasterised to a
 * PNG once per look and reused. */
function mascotIcon(color: MausColor, bodyId?: MascotBodyId | null, eyes?: MascotEyes | null): Promise<string | undefined> {
  const key = `${color}|${bodyId ?? "circle"}|${botMascotEyes(eyes)}`;
  const cached = mascotIcons.get(key);
  if (cached) return cached;
  const started = new Promise<string | undefined>((resolve) => {
    if (typeof Image === "undefined" || typeof document === "undefined") return resolve(undefined);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const context = canvas.getContext("2d");
        if (!context) return resolve(undefined);
        context.drawImage(image, 0, 0, 128, 128);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvg(color, bodyId, eyes))}`;
  });
  mascotIcons.set(key, started);
  return started;
}

/** The icon for a notification from this bot. A bot this client does not
 * know (a linked Mac's) falls back to the avatar the frame carried. */
export async function notificationIcon(
  bot: NotificationAvatarBot | undefined,
  frameAvatarUrl?: string | null,
): Promise<string | undefined> {
  if (!bot) return frameAvatarUrl ?? undefined;
  return notificationPhoto(bot) ?? (await mascotIcon(bot.color, bot.mascotBody, bot.mascotEyes));
}

/** The four kinds the person sets preferences for. Everything a bot can
 * notify about lands in one of them. */
export type AttentionKind = "approval" | "question" | "done" | "message";

export function attentionKind(kind: NotifyFrame["kind"]): AttentionKind {
  switch (kind) {
    case "approval":
      return "approval";
    case "question":
    case "takeover":
      return "question";
    case "done":
    case "voice_work_done":
      return "done";
    default:
      return "message";
  }
}

/** One identity per thing to look at, so a re-sent frame never re-banners
 * and an answered card can take its banner down. */
export function attentionId(frame: Pick<NotifyFrame, "kind" | "threadId" | "requestId" | "messageId" | "body">): string {
  if (frame.requestId) return `req:${frame.requestId}`;
  if (frame.messageId) return `msg:${frame.messageId}`;
  return `${frame.kind}:${frame.threadId}:${frame.body.slice(0, 120)}`;
}

/** Sent to the desktop shell (electron/attention-notifications.mjs). */
export interface AttentionPayload {
  id: string;
  kind: AttentionKind;
  title: string;
  subtitle?: string;
  body: string;
  icon?: string;
  groupId?: string;
  sound: NotifySound;
  done: DoneNotifyMode;
  canReply: boolean;
  replyPlaceholder?: string;
  approveText?: string;
  denyText?: string;
}

/** What the person did with a native banner. */
export type AttentionEvent =
  | { type: "open"; id: string }
  | { type: "reply"; id: string; text: string }
  | { type: "action"; id: string; action: "approve" | "deny" };

export interface AttentionHandlers {
  open: (target: NotificationTarget) => void;
  /** Words typed into the banner: an answer for a question, otherwise a
   * message into the thread. */
  reply?: (frame: NotifyFrame, text: string) => void;
  /** Approve/deny pressed on an approval banner. */
  decide?: (frame: NotifyFrame, behavior: "allow" | "deny") => void;
}

interface Shown {
  frame: NotifyFrame;
  handlers: AttentionHandlers;
  web?: globalThis.Notification;
  at: number;
}

const SHOWN_TTL_MS = 30 * 60_000;
const shown = new Map<string, Shown>();
let unsubscribe: (() => void) | null = null;

function pruneShown() {
  const cutoff = Date.now() - SHOWN_TTL_MS;
  for (const [id, entry] of shown) if (entry.at < cutoff) shown.delete(id);
}

function focusApp() {
  window.ogb?.focusWindow?.();
  window.focus();
}

function listenForBannerEvents() {
  if (unsubscribe || !window.ogb?.attention) return;
  unsubscribe = window.ogb.attention.onEvent((event) => {
    const entry = shown.get(event?.id);
    if (!entry) return;
    const target = { botId: entry.frame.botId, threadId: entry.frame.threadId };
    if (event.type === "open") {
      focusApp();
      entry.handlers.open(target);
    } else if (event.type === "reply" && typeof event.text === "string" && entry.handlers.reply) {
      entry.handlers.reply(entry.frame, event.text);
    } else if (event.type === "action" && entry.handlers.decide) {
      entry.handlers.decide(entry.frame, event.action === "approve" ? "allow" : "deny");
    }
  });
}

/** Takes an approval or question banner down once its card is answered,
 * wherever it was answered from. */
export function dismissAttention(requestId: string) {
  const id = `req:${requestId}`;
  const entry = shown.get(id);
  if (!entry) return;
  entry.web?.close();
  window.ogb?.attention?.dismiss(id);
}

/** Show one unless the person turned this kind off, or the exact destination
 * conversation is already visible. A focused app may still be showing
 * another task (routine runs are detached), so window focus alone is not
 * proof that the actionable card can be seen. */
export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
  actions?: Omit<AttentionHandlers, "open">,
) {
  const on: AttentionHandlers = { ...actions, open: onOpen };
  const prefs = attentionPreferences();
  const kind = attentionKind(frame.kind);
  if (kind === "done" ? prefs.done === "off" : !prefs[kind]) return;
  const focused = typeof document !== "undefined" && document.hasFocus();
  if (focused && visibleThreadId === frame.threadId) return;

  pruneShown();
  const id = attentionId(frame);
  if (shown.has(id)) return;
  const entry: Shown = { frame, handlers: on, at: Date.now() };
  shown.set(id, entry);

  const sticky = kind === "approval" || kind === "question";
  const canReply = Boolean(on.reply) && kind !== "approval" && Boolean(frame.threadId);
  const web = () => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // Without the desktop shell "no window focused" is this window's focus.
    if (kind === "done" && prefs.done === "unfocused" && focused) return;
    const options: NotificationOptions = {
      body: frame.body,
      ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
      ...(sticky ? { tag: id, requireInteraction: true } : {}),
      // no system sounds to pick from here: anything but none is the default
      silent: prefs.sound === "none",
    };
    const notification = new Notification(frame.title, options);
    notification.onclick = () => {
      focusApp();
      on.open({ botId: frame.botId, threadId: frame.threadId });
    };
    entry.web = notification;
  };

  const bridge = typeof window !== "undefined" ? window.ogb?.attention : undefined;
  if (!bridge) return web();
  listenForBannerEvents();
  const payload: AttentionPayload = {
    id,
    kind,
    title: frame.title,
    body: frame.body,
    ...(avatarUrl?.startsWith("data:image/") ? { icon: avatarUrl } : {}),
    groupId: frame.groupId ?? frame.botId,
    // the notch already chimes for an ask; one sound, not two
    sound: sticky && notchActive() ? "none" : prefs.sound,
    done: prefs.done,
    canReply,
    ...(canReply ? { replyPlaceholder: kind === "question" ? "answer" : "reply" } : {}),
    ...(kind === "approval" && on.decide ? { approveText: "approve", denyText: "deny" } : {}),
  };
  bridge.notify(payload).then((handled) => {
    if (!handled) web();
  }, web);
}
// branding compatibility (electron/branding-compat.json): pairing: old QR codes remain readable; server emission stays old until both native apps have shipped support
