// Other BOS servers ("homes") this server holds an admin session on, so the
// desktop shows their bots next to its own with full control. Unlike
// remote-bot-bridge.ts (a chat-only relay through a peer session), a home is
// the other server's own API under its own admin token: the renderer talks to
// /api/homes/:id/proxy/<path> and gets exactly what that server would answer.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { writeFileAtomic } from "./atomic.ts";

export interface HomeRecord {
  id: string;
  name: string;
  origin: string;
  environmentId: string;
  token: string;
  addedAt: number;
}
/** What leaves this server: never the token. */
export type PublicHome = Omit<HomeRecord, "token">;

const PROXY_TIMEOUT_MS = 60_000;
const BODY_LIMIT = 64 * 1024 * 1024;
// Request headers worth passing on. Cookies, origin and the local auth stay home.
const FORWARD_REQUEST = ["content-type", "accept", "last-event-id", "range", "if-none-match"];
const FORWARD_RESPONSE = ["content-type", "cache-control", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified"];

/** A typed URL or a pasted pairing link: keep the origin, take a code from
 * `/pair#code=…` when one is there. Plain http only for loopback and the
 * tailnet, where tailscale already encrypts the hop. */
export function parseHomeAddress(raw: string, code?: string): { origin: string; code: string } {
  const text = raw.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  if (url.username || url.password) throw new Error("the address can't carry a username or password");
  const host = url.hostname;
  const privateHost = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".ts.net") || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) throw new Error("use https, or http only on this mac or the tailnet");
  const fromLink = new URLSearchParams(url.hash.slice(1)).get("code") ?? "";
  const picked = (code ?? "").trim() || fromLink;
  if (!/^[A-Z0-9-]{6,24}$/i.test(picked)) throw new Error("enter the pairing code from the other server");
  return { origin: url.origin, code: picked };
}

/** JSON and SSE from a home name paths on that home. Point every unescaped
 * "/api/… string at the proxy so images, avatars and downloads load. */
export function rewriteHomeUrls(text: string, homeId: string): string {
  return text.replace(/(?<!\\)"\/api\//g, `"/api/homes/${homeId}/proxy/api/`);
}

type FetchLike = typeof fetch;

export class HomeLinks {
  private homes: HomeRecord[] = [];
  private readonly file: string;
  constructor(
    dataDir: string,
    private readonly self: { environmentId: string; label: () => string },
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.file = join(dataDir, "homes.json");
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed?.homes)) this.homes = parsed.homes.filter((home: HomeRecord) => typeof home?.id === "string" && typeof home.token === "string" && typeof home.origin === "string");
    } catch { /* none yet */ }
  }

  list(): PublicHome[] {
    return this.homes.map(({ token: _token, ...home }) => home);
  }

  get(id: string): HomeRecord | undefined {
    return this.homes.find(home => home.id === id);
  }

  private save() {
    writeFileAtomic(this.file, JSON.stringify({ homes: this.homes }, null, 2), { mode: 0o600 });
  }

  /** Redeem the other server's pairing code for an admin session. */
  async add(address: string, code?: string): Promise<PublicHome> {
    const target = parseHomeAddress(address, code);
    const environment = await this.fetcher(new URL("/.well-known/openmausbot/environment", target.origin), { redirect: "error", signal: AbortSignal.timeout(15_000) })
      .then(response => response.ok ? response.json() as Promise<{ environmentId?: string; label?: string }> : null)
      .catch(() => null);
    if (!environment?.environmentId) throw new Error("couldn't reach a BOS server at that address");
    if (environment.environmentId === this.self.environmentId) throw new Error("that address is this computer");
    const paired = await this.fetcher(new URL("/api/auth/pair", target.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: target.code, label: `${this.self.label()} (linked)`, attemptId: randomUUID() }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await paired.json().catch(() => ({})) as { token?: string; session?: { scopes?: string[] }; error?: string };
    if (!paired.ok || typeof body.token !== "string") throw new Error(body.error ?? "that pairing code expired or was already used");
    // Admin for settings, client for the event stream and chat.
    if (!body.session?.scopes?.includes("admin") || !body.session.scopes.includes("client")) {
      await this.logout(target.origin, body.token);
      throw new Error("that code doesn't give owner access; make one with full access on the other server");
    }
    const existing = this.homes.find(home => home.environmentId === environment.environmentId);
    if (existing) await this.logout(existing.origin, existing.token);
    const record: HomeRecord = {
      id: existing?.id ?? environment.environmentId,
      name: (environment.label ?? "").trim() || new URL(target.origin).hostname,
      origin: target.origin,
      environmentId: environment.environmentId,
      token: body.token,
      addedAt: Date.now(),
    };
    this.homes = [...this.homes.filter(home => home.environmentId !== record.environmentId), record];
    this.save();
    const { token: _token, ...visible } = record;
    return visible;
  }

  async remove(id: string): Promise<boolean> {
    const home = this.get(id);
    if (!home) return false;
    this.homes = this.homes.filter(entry => entry.id !== id);
    this.save();
    await this.logout(home.origin, home.token);
    return true;
  }

  rename(id: string, name: string): PublicHome | null {
    const home = this.get(id);
    const trimmed = name.trim().slice(0, 60);
    if (!home || !trimmed) return null;
    home.name = trimmed;
    this.save();
    const { token: _token, ...visible } = home;
    return visible;
  }

  private async logout(origin: string, token: string) {
    await this.fetcher(new URL("/api/auth/logout", origin), {
      method: "POST", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  /** Forward one request to the home under its admin token. Streams the
   * answer back, SSE included, rewriting /api/ paths to the proxy. */
  async proxy(req: IncomingMessage, res: ServerResponse, id: string, rest: string, search: string): Promise<void> {
    const home = this.get(id);
    if (!home) return void send(res, 404, { error: "that server isn't linked any more" });
    if (!rest.startsWith("/api/") || rest.startsWith("/api/homes")) return void send(res, 400, { error: "only api paths go to a linked server" });
    const method = (req.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { authorization: `Bearer ${home.token}` };
    for (const name of FORWARD_REQUEST) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      try { body = await readRaw(req, BODY_LIMIT); } catch (error) { return void send(res, 413, { error: error instanceof Error ? error.message : "body too large" }); }
    }
    const abort = new AbortController();
    const stream = rest === "/api/events" || /\/events$/.test(rest);
    const timer = stream ? null : setTimeout(() => abort.abort(), PROXY_TIMEOUT_MS);
    res.on("close", () => abort.abort());
    let upstream: Response;
    try {
      upstream = await this.fetcher(new URL(rest + search, home.origin), { method, headers, body, redirect: "manual", signal: abort.signal });
    } catch {
      if (timer) clearTimeout(timer);
      return void send(res, 502, { error: `${home.name} is offline` });
    }
    const type = upstream.headers.get("content-type") ?? "";
    const outHeaders: Record<string, string> = {};
    for (const name of FORWARD_RESPONSE) {
      const value = upstream.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    if (upstream.status === 401) outHeaders["x-bos-home-signed-out"] = "1";
    try {
      if (/^application\/json\b/i.test(type)) {
        const text = rewriteHomeUrls(await upstream.text(), home.id);
        res.writeHead(upstream.status, outHeaders);
        res.end(text);
      } else if (/^text\/event-stream\b/i.test(type) && upstream.body) {
        res.writeHead(upstream.status, { ...outHeaders, "x-accel-buffering": "no" });
        res.flushHeaders?.();
        const decoder = new TextDecoder();
        let carry = "";
        const reader = upstream.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          carry += decoder.decode(value, { stream: true });
          const cut = carry.lastIndexOf("\n");
          if (cut < 0) continue;
          res.write(rewriteHomeUrls(carry.slice(0, cut + 1), home.id));
          carry = carry.slice(cut + 1);
        }
        if (carry) res.write(rewriteHomeUrls(carry, home.id));
        res.end();
      } else {
        const length = upstream.headers.get("content-length");
        if (length) outHeaders["content-length"] = length;
        res.writeHead(upstream.status, outHeaders);
        if (!upstream.body || method === "HEAD") return void res.end();
        Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
      }
    } catch {
      if (!res.headersSent) send(res, 502, { error: `${home.name} dropped the connection` });
      else res.destroy();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
