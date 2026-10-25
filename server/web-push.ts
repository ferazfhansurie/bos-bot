// Web push: notifications for a browser tab that is closed or asleep.
//
// The phone has APNs; a browser has the Push API. Both carry the same thing:
// a bot finished, needs approval, asked something, or a person messaged you.
// This is the browser half, built on node:crypto alone (RFC 8291 payload
// encryption, RFC 8292 VAPID), so no dependency and no relay: the push
// service (FCM for Chrome, Mozilla, Apple, Windows) takes the encrypted
// payload straight from this server.
//
// The VAPID key pair is made on first use and kept in the data directory at
// 0600 beside the subscriptions. The private key never leaves this file; the
// public key is what a browser subscribes with. A subscription is bound to
// the session that made it, exactly like an APNs device: revoke the session
// and its browser stops getting pushes.

import { createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { attentionId } from "../shared/notification.ts";
import type { PushTarget } from "./apns-push.ts";

/** What the service worker shows and routes on. `data` is the same identity
 * set a notify frame carries, so a click opens the exact thread and message. */
export interface WebPushMessage {
  title: string;
  body: string;
  /** Replaces an earlier banner with the same tag (the page uses the same
   * one), so a tab that is open but hidden never shows two. */
  tag?: string;
  /** approvals and questions stay until answered */
  sticky?: boolean;
  data: {
    kind?: string; botId?: string; threadId?: string; messageId?: string;
    requestId?: string; groupId?: string; roomId?: string;
  };
}

interface Subscription {
  actorId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The session it was made under; "loopback" for this machine's own browser. */
  sessionId: string;
  createdAt: number;
}

interface Vapid { publicKey: string; privateJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string } }

/** Browsers only ever hand out endpoints on their vendor's push service. An
 * endpoint anywhere else is not a browser subscription, and posting to it
 * would let a client aim this server at any URL. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
const ACTOR = /^[A-Za-z0-9_-]+:person:[A-Za-z0-9_-]+$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const B64URL = /^[A-Za-z0-9_-]+=*$/;
/** A push service accepts 4096 bytes of record; leave room for the header. */
const MAX_PAYLOAD = 3000;
/** One person rarely has more than a few browsers; this caps a runaway loop. */
const MAX_PER_ACTOR = 20;

const b64url = (data: Buffer | Uint8Array) => Buffer.from(data).toString("base64url");
const unb64url = (text: string) => Buffer.from(text.replace(/=+$/, ""), "base64url");

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && PUSH_HOSTS.some(host => host.test(url.hostname));
  } catch { return false; }
}

/** RFC 8291 aes128gcm: one record, encrypted to the browser's key. Exported
 * so the test can decrypt it the way a browser would. */
export function encryptPayload(plaintext: Buffer, p256dh: string, authSecret: string, salt = randomBytes(16)): Buffer {
  const uaPublic = unb64url(p256dh);
  const auth = unb64url(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || auth.length !== 16) throw new Error("invalid subscription keys");
  const sender = createECDH("prime256v1");
  const asPublic = sender.generateKeys();
  const shared = sender.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (and only) record; no padding
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/** RFC 8292: a short-lived ES256 token for one push service origin. */
export function vapidAuthorization(endpoint: string, vapid: Vapid, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const head = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: "mailto:hello@bosbot.my" })));
  const key = createPrivateKey({ key: vapid.privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

export type PushPost = (endpoint: string, init: { method: "POST"; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

export class WebPush {
  private readonly file: string;
  private readonly authorized: (sessionId: string, actorId: string) => boolean;
  private readonly post: PushPost;
  private vapid: Vapid | null = null;
  private subscriptions: Subscription[] = [];

  constructor(file = join(DATA_DIR, "web-push.json"), authorized: (sessionId: string, actorId: string) => boolean = () => false,
    post: PushPost = (endpoint, init) => fetch(endpoint, { ...init, signal: AbortSignal.timeout(15_000) })) {
    this.file = file; this.authorized = authorized; this.post = post;
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: number; vapid?: Vapid; subscriptions?: Subscription[] };
      if (parsed.version !== 1) return;
      const jwk = parsed.vapid?.privateJwk;
      if (parsed.vapid && typeof parsed.vapid.publicKey === "string" && jwk && jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.d === "string") this.vapid = parsed.vapid;
      this.subscriptions = (parsed.subscriptions ?? []).filter(item => item && ACTOR.test(item.actorId) && isPushEndpoint(item.endpoint) &&
        typeof item.p256dh === "string" && B64URL.test(item.p256dh) && typeof item.auth === "string" && B64URL.test(item.auth) && SESSION.test(item.sessionId));
    } catch { /* an unreadable registry starts empty; browsers resubscribe on their next open */ }
  }

  /** The public key a browser subscribes with. Made on first ask. */
  publicKey(): string { return this.keys().publicKey; }

  private keys(): Vapid {
    if (this.vapid) return this.vapid;
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
    this.vapid = { publicKey: b64url(Buffer.concat([Buffer.from([4]), unb64url(jwk.x), unb64url(jwk.y)])),
      privateJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d } };
    this.persist();
    return this.vapid;
  }

  subscribe(actorId: string, sessionId: string, subscription: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }): void {
    if (!ACTOR.test(actorId) || !SESSION.test(sessionId)) throw new Error("invalid push owner");
    if (!isPushEndpoint(subscription.endpoint)) throw new Error("not a browser push endpoint");
    const p256dh = subscription.keys?.p256dh, auth = subscription.keys?.auth;
    if (typeof p256dh !== "string" || !B64URL.test(p256dh) || unb64url(p256dh).length !== 65 || typeof auth !== "string" || !B64URL.test(auth) || unb64url(auth).length !== 16) {
      throw new Error("invalid subscription keys");
    }
    this.keys();
    const kept = this.subscriptions.filter(item => item.endpoint !== subscription.endpoint);
    kept.push({ actorId, endpoint: subscription.endpoint, p256dh, auth, sessionId, createdAt: Date.now() });
    const mine = kept.filter(item => item.actorId === actorId);
    this.subscriptions = mine.length > MAX_PER_ACTOR ? kept.filter(item => item.actorId !== actorId || mine.slice(-MAX_PER_ACTOR).includes(item)) : kept;
    this.persist();
  }

  /** Only the session that holds a subscription, or the owner's own machine,
   * may take it off. */
  unsubscribe(endpoint: string, sessionId: string): boolean {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(item => !(item.endpoint === endpoint && (item.sessionId === sessionId || sessionId === "loopback")));
    if (this.subscriptions.length === before) return false;
    this.persist();
    return true;
  }

  subscribed(endpoint: string): boolean { return this.subscriptions.some(item => item.endpoint === endpoint); }
  /** Whether this person's browser, named by the sha-256 of its endpoint,
   * is already registered for this session — so an app load can check with a
   * read instead of re-registering (a write wakes a sleeping hosted bos). */
  holds(endpointHash: string, actorId: string, sessionId: string): boolean {
    return this.subscriptions.some(item => item.actorId === actorId && item.sessionId === sessionId && this.active(item) &&
      createHash("sha256").update(item.endpoint).digest("hex") === endpointHash);
  }
  countFor(actorId: string): number { return this.subscriptions.filter(item => item.actorId === actorId && this.active(item)).length; }
  revokeSession(sessionId: string): void {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(item => item.sessionId !== sessionId);
    if (this.subscriptions.length !== before) this.persist();
  }

  private active(item: Subscription): boolean { return item.sessionId === "loopback" || this.authorized(item.sessionId, item.actorId); }

  /** Push to every browser this person subscribed. A push service answering
   * 404/410 means the browser dropped the subscription: forget it. */
  async send(actorId: string, message: WebPushMessage): Promise<void> {
    const targets = this.subscriptions.filter(item => item.actorId === actorId);
    if (!targets.length) return;
    const stale = targets.filter(item => !this.active(item));
    const vapid = this.keys();
    const payload = Buffer.from(JSON.stringify(fit(message)));
    const gone: string[] = stale.map(item => item.endpoint);
    await Promise.all(targets.filter(item => this.active(item)).map(async item => {
      try {
        const result = await this.post(item.endpoint, { method: "POST", body: encryptPayload(payload, item.p256dh, item.auth), headers: {
          "content-type": "application/octet-stream", "content-encoding": "aes128gcm",
          ttl: String(message.sticky ? 24 * 3600 : 4 * 3600), urgency: message.sticky ? "high" : "normal",
          authorization: vapidAuthorization(item.endpoint, vapid),
        } });
        if (result.status === 404 || result.status === 410) gone.push(item.endpoint);
        else if (result.status >= 400) console.warn(`web push rejected (${result.status}, ${new URL(item.endpoint).hostname})`);
      } catch (error) {
        console.warn(`web push failed (${new URL(item.endpoint).hostname}): ${error instanceof Error ? error.message : "unknown failure"}`);
      }
    }));
    if (gone.length) {
      this.subscriptions = this.subscriptions.filter(item => !gone.includes(item.endpoint));
      this.persist();
    }
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, vapid: this.vapid, subscriptions: this.subscriptions }), { mode: 0o600 });
  }
}

/** Keep the encrypted record under the push service's limit by trimming the
 * body, never the routing data. */
function fit(message: WebPushMessage): WebPushMessage {
  const out = { ...message, title: message.title.slice(0, 120), body: message.body.slice(0, 1000) };
  while (Buffer.byteLength(JSON.stringify(out)) > MAX_PAYLOAD && out.body.length > 0) out.body = out.body.slice(0, Math.floor(out.body.length * 0.7));
  return out;
}

/** The browser form of a push the phone gets: same words, same routing ids,
 * tagged like the open page tags its own banner for the same event. */
export function webPushMessage(title: string, body: string, target: PushTarget): WebPushMessage {
  const kind = target.kind ?? target.type ?? "message";
  const sticky = kind === "approval" || kind === "question" || kind === "takeover";
  return {
    title, body,
    // the open page's own tags (src/lib/notify.ts): an ask has its own banner,
    // anything else from one bot replaces that bot's last one
    tag: !sticky && target.botId ? `openmausbot:${target.botId}`
      : attentionId({ kind, threadId: target.threadId ?? target.roomId, requestId: target.requestId, messageId: target.messageId, body }),
    sticky,
    data: {
      kind,
      ...(target.botId ? { botId: target.botId } : {}),
      ...(target.threadId ? { threadId: target.threadId } : {}),
      ...(target.messageId ? { messageId: target.messageId } : {}),
      ...(target.requestId ? { requestId: target.requestId } : {}),
      ...(target.roomId ? { roomId: target.roomId } : {}),
    },
  };
}
