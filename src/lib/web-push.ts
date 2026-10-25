// Browser notifications for a plain browser tab: a service worker (public/sw.js)
// plus a web push subscription the server sends to (server/web-push.ts). The
// desktop app has native banners and never uses this; it is for app.bosbot.my
// and remote access in Chrome, Edge, Firefox and Safari.
import { api } from "@/state/store";

export interface WebPushTarget {
  kind?: string;
  botId?: string;
  threadId?: string;
  messageId?: string;
  requestId?: string;
  roomId?: string;
}

const DISMISSED_KEY = "bos-web-push-prompt-dismissed";

/** A browser that can take push: not the desktop shell, a secure page, and
 * the three APIs it needs. */
export function webPushSupported(): boolean {
  if (typeof window === "undefined" || window.ogb) return false;
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}

let registering: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the worker once per page. Safe to call often. */
export function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!webPushSupported()) return Promise.resolve(null);
  registering ??= navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => null);
  return registering;
}

function keyBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export type WebPushState = "unsupported" | "denied" | "off" | "on";

/** Whether this browser is set up to get pushes now. */
export async function webPushState(): Promise<WebPushState> {
  if (!webPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await serviceWorker();
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  return Notification.permission === "granted" && subscription ? "on" : "off";
}

/** Asks (must run inside a click), subscribes and hands the subscription to
 * the server. A re-subscribe after the server's key changed replaces the old
 * one. Returns the state it ended in. */
export async function enableWebPush(): Promise<WebPushState> {
  if (!webPushSupported()) return "unsupported";
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const registration = await serviceWorker();
  if (!registration) return "off";
  const { publicKey } = await api<{ publicKey: string }>("/api/web-push");
  const applicationServerKey = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && !sameKey(new Uint8Array(current), applicationServerKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey as BufferSource });
  await api("/api/web-push/subscribe", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
  return "on";
}

export async function disableWebPush(): Promise<WebPushState> {
  const registration = await serviceWorker();
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (subscription) {
    await api("/api/web-push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
    await subscription.unsubscribe().catch(() => {});
  }
  return webPushState();
}

/** A browser that already said yes keeps its subscription in step with this
 * session: a new sign-in or a rotated server key would otherwise go quiet. */
export async function refreshWebPush(): Promise<void> {
  if (!webPushSupported() || Notification.permission !== "granted") return;
  const registration = await serviceWorker();
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return;
  // a read first: re-registering is a write, and on the hosted free tier a
  // write on every app load would wake a sleeping bos for nothing
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subscription.endpoint));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const status = await api<{ publicKey: string; current?: boolean }>(`/api/web-push?endpoint=${hash}`).catch(() => null);
  if (!status) return;
  const key = subscription.options.applicationServerKey;
  if (status.current && key && sameKey(new Uint8Array(key), keyBytes(status.publicKey))) return;
  await enableWebPush().catch(() => {});
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Whether to offer notifications now: a browser that can, hasn't decided,
 * and the person hasn't waved the offer off. */
export function shouldOfferWebPush(): boolean {
  if (!webPushSupported() || Notification.permission !== "default") return false;
  try { return localStorage.getItem(DISMISSED_KEY) !== "1"; } catch { return false; }
}

export function dismissWebPushOffer() {
  try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* the offer just comes back next visit */ }
}

function parseTarget(raw: unknown): WebPushTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const out: WebPushTarget = {};
  for (const key of ["kind", "botId", "threadId", "messageId", "requestId", "roomId"] as const) {
    if (typeof value[key] === "string" && value[key]) out[key] = (value[key] as string).slice(0, 200);
  }
  return out.threadId || out.roomId || out.botId || out.kind === "digest" ? out : null;
}

/** The target a cold-opened tab was launched for (`?bos-open=…`), taken off
 * the address bar so a reload doesn't jump again. */
export function takeOpenTargetFromLocation(): WebPushTarget | null {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  const raw = params.get("bos-open");
  if (!raw) return null;
  params.delete("bos-open");
  const search = params.toString();
  history.replaceState(null, "", location.pathname + (search ? `?${search}` : "") + location.hash);
  try { return parseTarget(JSON.parse(raw)); } catch { return null; }
}

/** Clicks on a push banner while a tab is already open. */
export function onNotificationOpen(open: (target: WebPushTarget) => void): () => void {
  if (!webPushSupported()) return () => {};
  const listener = (event: MessageEvent) => {
    if (event.data?.type !== "bos:notification-open") return;
    const target = parseTarget(event.data.target);
    if (target) open(target);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  navigator.serviceWorker.startMessages();
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
