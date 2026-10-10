import { createPrivateKey, sign, randomUUID } from "node:crypto";
import { connect, type ClientHttp2Session, type SecureClientSessionOptions } from "node:http2";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

interface Device { actorId: string; token: string; environment: "development" | "production"; updatedAt: number; connectionId?: string; sessionId?: string;
  /** PushKit token: a ring goes here as a VoIP push so CallKit shows a real incoming call. */
  voipToken?: string;
  /** ActivityKit push-to-start token: the server starts a bot's Live Activity with it. */
  liveStartToken?: string;
  /** Each running bot activity's own push token, by bot id: updates and ends go here. */
  liveTokens?: Record<string, string> }
/** What the phone reports about its Live Activities on each registration. */
export interface LiveRegistration { startToken?: string; activities?: Record<string, string> }
/** One bot's island, exactly as BotActivityAttributes / BotActivityContent decode it. */
export interface LiveActivityPush {
  event: "start" | "update" | "end";
  attributes: { botId: string; threadId: string; name: string; color: string; mascotBody?: string; mascotEyes?: string };
  content: Record<string, unknown>;
  alert?: { title: string; body: string };
  staleDate?: number; dismissalDate?: number;
  /** 10 interrupts (start, needs you, end); 5 is a quiet progress update. */
  priority?: 5 | 10;
}
interface Credential { teamId: string; keyId: string; privateKey: string }
const TOKEN = /^[a-f0-9]{64}$/i;
const APNS_TOPIC = "com.aihlete.aios";
const CONNECTION = /^[A-Za-z0-9_-]{1,128}$/;
/** ActivityKit tokens are longer than alert tokens and not fixed-size. */
const LIVE_TOKEN = /^[a-f0-9]{64,400}$/i;
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Node's happy-eyeballs gives each address 250 ms. The sandbox APNs host is
 * ~270 ms from Malaysia and IPv6 is unreachable on most home links, so every
 * attempt timed out and no push left this Mac (2026-10-10). */
// passed through to net.connect; the http2 typings leave it out
const CONNECT_OPTIONS = { autoSelectFamilyAttemptTimeout: 2_000 } as SecureClientSessionOptions;
export interface PushTarget {
  roomId?: string; botId?: string; threadId?: string; senderId?: string;
  senderName?: string; kind?: string; requestId?: string; messageId?: string;
  /** Typed push data the phone acts on (voice_work_done); callId names the call. */
  type?: string; callId?: string;
  ringId?: string; reason?: string;
  /** Caller name CallKit shows; a VoIP-launched app has no roster yet. */
  botName?: string;
}

/** Routing scope comes from this device's authenticated registration, never
 * from the event producer. It is a navigation hint; API access still requires
 * the device's existing token for that connection. */
export function buildApnsPayload(title: string, body: string, target: PushTarget, connectionId?: string) {
  return { aps: { alert: { title: title.slice(0, 120), body: body.slice(0, target.type === "voice_ring" ? 300 : 1000) }, sound: "default", "thread-id": target.roomId ?? target.threadId ?? "bos", ...(target.senderId ? { "mutable-content": 1 } : {}),
      ...(target.type === "voice_ring" ? { category: "VOICE_RING", "interruption-level": "time-sensitive" } : {}) },
    ...target, ...(connectionId ? { connectionId } : {}) };
}

/** Connection errors often carry an empty message (AggregateError from
 * happy-eyeballs), so the code and inner errors are what say what broke. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return "unknown failure";
  const code = (error as { code?: string }).code;
  const inner = error instanceof AggregateError ? error.errors.map(item => describe(item)).join("; ") : "";
  const cause = error.cause instanceof Error ? describe(error.cause) : "";
  return [error.name, code, error.message, inner && `[${inner}]`, cause && `cause: ${cause}`].filter(Boolean).join(" ");
}

/** The canonical shared home owns delivery. Registration is bound to the
 * authenticated person by the HTTP handler, never to a caller-supplied id. */
export class ApnsPush {
  private readonly file: string;
  private readonly devices = new Map<string, Device>();
  private readonly authorized: (sessionId: string, actorId: string) => boolean;
  private bearer: { value: string; at: number } | null = null;

  constructor(file = join(DATA_DIR, "apns-devices.json"), authorized: (sessionId: string, actorId: string) => boolean = () => false) {
    this.file = file; this.authorized = authorized;
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: number; devices?: Device[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) throw new Error("invalid APNs device registry");
    for (const device of parsed.devices) {
      if (!/^[A-Za-z0-9_-]+:person:[A-Za-z0-9_-]+$/.test(device.actorId)) throw new Error("invalid APNs actor");
      if (!TOKEN.test(device.token) || !["development", "production"].includes(device.environment)) throw new Error("invalid APNs device");
      if (device.connectionId !== undefined && !CONNECTION.test(device.connectionId)) throw new Error("invalid push connection");
      if (device.sessionId !== undefined && !CONNECTION.test(device.sessionId)) throw new Error("invalid push session");
      if (device.voipToken !== undefined && !TOKEN.test(device.voipToken)) throw new Error("invalid VoIP token");
      if (device.liveStartToken !== undefined && !LIVE_TOKEN.test(device.liveStartToken)) delete device.liveStartToken;
      if (device.liveTokens) device.liveTokens = cleanLiveTokens(device.liveTokens);
      this.devices.set(device.token.toLowerCase(), device);
    }
  }

  /** `voipToken` undefined keeps the one already registered: the alert token
   * and the PushKit token arrive separately and either may register first. */
  register(actorId: string, token: string, environment: "development" | "production", connectionId?: string, sessionId?: string, voipToken?: string, live?: LiveRegistration): void {
    if (!/^[A-Za-z0-9_-]+:person:[A-Za-z0-9_-]+$/.test(actorId) || !TOKEN.test(token)) throw new Error("invalid push registration");
    if (voipToken !== undefined && !TOKEN.test(voipToken)) throw new Error("invalid VoIP token");
    if (environment !== "development" && environment !== "production") throw new Error("invalid push environment");
    if (connectionId !== undefined && !CONNECTION.test(connectionId)) throw new Error("invalid push connection");
    if (!connectionId || !sessionId || !CONNECTION.test(sessionId) || !this.authorized(sessionId, actorId)) throw new Error("push registration requires a live owned session and connection");
    const existing = this.devices.get(token.toLowerCase());
    if (existing && existing.actorId !== actorId && existing.sessionId && this.authorized(existing.sessionId, existing.actorId)) throw new Error("push token is already owned by another actor");
    if (live?.startToken !== undefined && !LIVE_TOKEN.test(live.startToken)) throw new Error("invalid Live Activity token");
    const voip = voipToken?.toLowerCase() ?? (existing?.actorId === actorId ? existing.voipToken : undefined);
    const mine = existing?.actorId === actorId ? existing : undefined;
    // like the VoIP token, an absent field keeps what is registered
    const liveStart = live?.startToken?.toLowerCase() ?? mine?.liveStartToken;
    const liveTokens = live?.activities !== undefined ? cleanLiveTokens(live.activities) : mine?.liveTokens;
    this.devices.set(token.toLowerCase(), { actorId, token: token.toLowerCase(), environment, updatedAt: Date.now(), connectionId, sessionId, ...(voip ? { voipToken: voip } : {}),
      ...(liveStart ? { liveStartToken: liveStart } : {}), ...(liveTokens && Object.keys(liveTokens).length ? { liveTokens } : {}) });
    this.persist();
  }

  configured(): boolean { return this.credential() !== null; }
  countFor(actorId: string): number { return [...this.devices.values()].filter(device => device.actorId === actorId && this.active(device)).length; }
  private active(device: Device): boolean { return Boolean(device.sessionId && device.connectionId && this.authorized(device.sessionId, device.actorId)); }
  revokeSession(sessionId: string): void {
    const removed = [...this.devices.values()].filter(device => device.sessionId === sessionId);
    for (const device of removed) this.devices.delete(device.token);
    if (removed.length) this.persist();
  }
  private pruneRevoked(): void {
    const removed = [...this.devices.values()].filter(device => !this.active(device));
    for (const device of removed) this.devices.delete(device.token);
    if (removed.length) this.persist();
  }

  /** `skipVoip`: a session with the app on screen rings in-app from the
   * stream, so its ring skips CallKit (iOS would ring it there instead). */
  async send(actorId: string, title: string, body: string, target: PushTarget, id: string = randomUUID(),
    skipVoip: (sessionId: string) => boolean = () => false): Promise<void> {
    this.pruneRevoked();
    const credential = this.credential();
    if (!credential) return;
    const devices = [...this.devices.values()].filter(device => device.actorId === actorId);
    await Promise.all(devices.map(async device => {
      if (!this.active(device)) return;
      // A connection can fail before Apple sees the push (2026-10-10: a ring
      // died on "pending stream has been canceled"), so a fresh session retries.
      for (let attempt = 1; ; attempt++) {
        try { return await this.deliver(device, credential, title, body, target, id, skipVoip); }
        catch (error) {
          if (attempt >= 3) throw error;
          console.warn(`APNs attempt ${attempt} failed (${describe(error)}); retrying`);
          await new Promise(resolve => setTimeout(resolve, attempt * 750));
        }
      }
    }));
  }

  private async deliver(device: Device, credential: Credential, title: string, body: string, target: PushTarget, id: string,
    skipVoip: (sessionId: string) => boolean = () => false): Promise<void> {
    const host = device.environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    const client = connect(host, CONNECT_OPTIONS);
    client.on("error", error => console.warn(`APNs connection failed: ${describe(error)}`));
    try {
      const payload = JSON.stringify(buildApnsPayload(title, body, target, device.connectionId));
      // A ring rings through CallKit when the phone has a PushKit token;
      // without one, or if Apple refuses it, the alert push still goes.
      // On screen, the app rings itself; the alert still goes in case it
      // has just left the screen (the app keeps a foreground one quiet).
      if (target.type === "voice_ring" && device.voipToken && !(device.sessionId && skipVoip(device.sessionId))) {
        const voip = await this.post(client, credential, device.voipToken, `${APNS_TOPIC}.voip`, "voip", payload, id,
          { "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 30) });
        if (voip.status === 200) { console.info("APNs accepted a VoIP ring"); return; }
        console.warn(`APNs rejected a VoIP ring (${voip.status}, ${voip.reason || "unknown"}); sending the alert instead`);
        if (voip.status === 410 || voip.reason === "Unregistered" || voip.reason === "BadDeviceToken") {
          delete device.voipToken;
          this.persist();
        }
      }
      const result = await this.post(client, credential, device.token, APNS_TOPIC, "alert", payload, id);
      if (result.status === 410 || result.reason === "Unregistered" || result.reason === "BadDeviceToken") {
        this.devices.delete(device.token);
        this.persist();
      } else if (result.status === 200) {
        console.info(`APNs accepted a notification (${target.kind ?? target.type ?? "message"})`);
      } else {
        console.warn(`APNs rejected a notification (${result.status}, ${result.reason || "unknown"})`);
      }
    } finally { client.close(); }
  }

  /** Whether any of this actor's devices can show a bot's island from here:
   * a running activity's token, or a push-to-start token for a new one. */
  liveReach(actorId: string, botId: string, skip: (sessionId: string) => boolean = () => false): { activity: boolean; start: boolean } {
    const devices = [...this.devices.values()].filter(device => device.actorId === actorId && this.active(device) && !skip(device.sessionId!));
    return { activity: devices.some(device => device.liveTokens?.[botId]), start: devices.some(device => device.liveStartToken) };
  }

  /** Start, update or end one bot's Live Activity on every device of the
   * actor. A device already running that bot's activity gets an update in
   * place of a second start; a device without one is started only on start. */
  async sendLive(actorId: string, push: LiveActivityPush, skip: (sessionId: string) => boolean = () => false): Promise<void> {
    this.pruneRevoked();
    const credential = this.credential();
    if (!credential) return;
    const botId = push.attributes.botId;
    const devices = [...this.devices.values()].filter(device => device.actorId === actorId && this.active(device));
    await Promise.all(devices.map(async device => {
      const activityToken = device.liveTokens?.[botId];
      const event = push.event === "start" && activityToken ? "update" : push.event;
      const token = event === "start" ? device.liveStartToken : activityToken;
      // an app on screen runs its own islands, with the richer step lines
      if (!token || skip(device.sessionId!)) return;
      const now = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ aps: {
        timestamp: now, event, "content-state": push.content,
        ...(event === "start" ? { "attributes-type": "BotActivityAttributes", attributes: push.attributes } : {}),
        ...(push.alert ? { alert: { title: push.alert.title, body: push.alert.body, sound: "default" } } : {}),
        ...(push.staleDate ? { "stale-date": push.staleDate } : {}),
        ...(event === "end" ? { "dismissal-date": push.dismissalDate ?? now } : {}),
      } });
      const host = device.environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
      for (let attempt = 1; ; attempt++) {
        const client = connect(host, CONNECT_OPTIONS);
        client.on("error", error => console.warn(`APNs connection failed: ${describe(error)}`));
        try {
          const result = await this.post(client, credential, token, `${APNS_TOPIC}.push-type.liveactivity`, "liveactivity", payload, randomUUID(),
            { "apns-priority": String(push.priority ?? 10) });
          if (result.status === 200) {
            console.info(`APNs accepted a live activity ${event} (${botId.slice(0, 8)})`);
            if (event === "end" && device.liveTokens?.[botId]) { delete device.liveTokens[botId]; this.persist(); }
          } else {
            console.warn(`APNs rejected a live activity ${event} (${result.status}, ${result.reason || "unknown"})`);
            if (result.status === 410 || result.reason === "Unregistered" || result.reason === "BadDeviceToken") {
              if (event === "start") delete device.liveStartToken; else if (device.liveTokens) delete device.liveTokens[botId];
              this.persist();
            }
          }
          return;
        } catch (error) {
          if (attempt >= 3) { console.warn(`live activity push failed: ${describe(error)}`); return; }
          await new Promise(resolve => setTimeout(resolve, attempt * 750));
        } finally { client.close(); }
      }
    }));
  }

  private post(client: ClientHttp2Session, credential: Credential, token: string, topic: string, type: "alert" | "voip" | "liveactivity",
               payload: string, id: string, extra: Record<string, string> = {}): Promise<{ status: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const request = client.request({ ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${this.jwt(credential)}`, "apns-topic": topic, "apns-push-type": type, "apns-id": id, "content-type": "application/json", ...extra });
      let status = 0;
      let response = "";
      request.on("response", headers => { status = Number(headers[":status"] ?? 0); });
      request.on("data", chunk => { if (response.length < 2048) response += String(chunk); });
      request.on("end", () => { if (!status) return reject(new Error("APNs stream ended without a response")); let reason = ""; try { reason = JSON.parse(response).reason ?? ""; } catch { /* success has no body */ } resolve({ status, reason }); });
      request.on("error", reject);
      request.end(payload);
    });
  }

  private credential(): Credential | null {
    try {
      const value = JSON.parse(readFileSync(join(DATA_DIR, "apns-auth.json"), "utf8")) as Credential;
      if (!/^[A-Z0-9]{10}$/.test(value.teamId) || !/^[A-Z0-9]{10}$/.test(value.keyId) || !value.privateKey?.includes("BEGIN PRIVATE KEY")) return null;
      return value;
    } catch { return null; }
  }

  private jwt(credential: Credential): string {
    if (this.bearer && Date.now() - this.bearer.at < 45 * 60_000) return this.bearer.value;
    const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const at = Date.now();
    const head = `${encoded({ alg: "ES256", kid: credential.keyId })}.${encoded({ iss: credential.teamId, iat: Math.floor(at / 1000) })}`;
    const signature = sign("sha256", Buffer.from(head), { key: createPrivateKey(credential.privateKey), dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.bearer = { value: `${head}.${signature}`, at };
    return this.bearer.value;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, devices: [...this.devices.values()] }), { mode: 0o600 });
  }
}

function cleanLiveTokens(tokens: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [botId, token] of Object.entries(tokens).slice(0, 32)) {
    if (BOT_ID.test(botId) && typeof token === "string" && LIVE_TOKEN.test(token)) out[botId] = token.toLowerCase();
  }
  return out;
}
