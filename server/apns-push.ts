import { createPrivateKey, sign, randomUUID } from "node:crypto";
import { connect } from "node:http2";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

interface Device { actorId: string; token: string; environment: "development" | "production"; updatedAt: number }
interface Credential { teamId: string; keyId: string; privateKey: string }
const TOKEN = /^[a-f0-9]{64}$/i;
const APNS_TOPIC = "com.aihlete.aios";

/** The canonical shared home owns delivery. Registration is bound to the
 * authenticated person by the HTTP handler, never to a caller-supplied id. */
export class ApnsPush {
  private readonly file: string;
  private readonly devices = new Map<string, Device>();
  private bearer: { value: string; at: number } | null = null;

  constructor(file = join(DATA_DIR, "apns-devices.json")) {
    this.file = file;
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: number; devices?: Device[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) throw new Error("invalid APNs device registry");
    for (const device of parsed.devices) {
      if (!/^[A-Za-z0-9_-]+:person:[A-Za-z0-9_-]+$/.test(device.actorId)) throw new Error("invalid APNs actor");
      if (!TOKEN.test(device.token) || !["development", "production"].includes(device.environment)) throw new Error("invalid APNs device");
      this.devices.set(device.token, device);
    }
  }

  register(actorId: string, token: string, environment: "development" | "production"): void {
    if (!/^[A-Za-z0-9_-]+:person:[A-Za-z0-9_-]+$/.test(actorId) || !TOKEN.test(token)) throw new Error("invalid push registration");
    if (environment !== "development" && environment !== "production") throw new Error("invalid push environment");
    this.devices.set(token.toLowerCase(), { actorId, token: token.toLowerCase(), environment, updatedAt: Date.now() });
    this.persist();
  }

  configured(): boolean { return this.credential() !== null; }
  countFor(actorId: string): number { return [...this.devices.values()].filter(device => device.actorId === actorId).length; }

  async send(actorId: string, title: string, body: string, target: { roomId?: string; botId?: string; threadId?: string; senderId?: string; senderName?: string }, id = randomUUID()): Promise<void> {
    const credential = this.credential();
    if (!credential) return;
    const devices = [...this.devices.values()].filter(device => device.actorId === actorId);
    await Promise.all(devices.map(async device => {
      const host = device.environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
      const client = connect(host);
      client.on("error", error => console.warn(`APNs connection failed: ${error.message}`));
      try {
        const payload = JSON.stringify({ aps: { alert: { title: title.slice(0, 120), body: body.slice(0, 1000) }, sound: "default", "thread-id": target.roomId ?? target.threadId ?? "bos", ...(target.senderId ? { "mutable-content": 1 } : {}) }, ...target });
        const result = await new Promise<{ status: number; reason: string }>((resolve, reject) => {
          const request = client.request({ ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${this.jwt(credential)}`, "apns-topic": APNS_TOPIC, "apns-push-type": "alert", "apns-id": id, "content-type": "application/json" });
          let status = 0;
          let response = "";
          request.on("response", headers => { status = Number(headers[":status"] ?? 0); });
          request.on("data", chunk => { if (response.length < 2048) response += String(chunk); });
          request.on("end", () => { let reason = ""; try { reason = JSON.parse(response).reason ?? ""; } catch { /* success has no body */ } resolve({ status, reason }); });
          request.on("error", reject);
          request.end(payload);
        });
        if (result.status === 410 || result.reason === "Unregistered" || result.reason === "BadDeviceToken") {
          this.devices.delete(device.token);
          this.persist();
        } else if (result.status !== 200) {
          console.warn(`APNs rejected a notification (${result.status}, ${result.reason || "unknown"})`);
        }
      } finally { client.close(); }
    }));
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
