import { timingSafeEqual, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { isAllowedOrigin, isLoopbackHost, isProxied } from "./request-auth.ts";
import { spawnTerminalPty } from "./terminal-pty.ts";

const MAX_FRAME = 64 * 1024;
const MAX_BUFFER = 1024 * 1024;
type Target = {botId: string; threadId: string; cwd: string; origin: string; expires: number; owner: string};
type Options = {
  ownerToken: () => string | undefined;
  authenticate: (req: IncomingMessage) => boolean;
  resolveTarget: (botId: string, threadId: string) => string;
  claim?: () => () => void;
  now?: () => number;
};
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}
export function terminalTransportAllowed(req: IncomingMessage): boolean {
  const peer = req.socket.remoteAddress;
  return typeof peer === "string" && (peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127.")) &&
    !isProxied(req) && isLoopbackHost(req.headers.host) && isAllowedOrigin(typeof req.headers.origin === "string" ? req.headers.origin : null) &&
    !req.headers["x-openmausbot-companion-owner"] && !req.headers["x-openmausbot-companion"] && !req.headers["x-openmausbot-companion-auth"];
}
function origin(req: IncomingMessage): string {return typeof req.headers.origin === "string" ? req.headers.origin : "";}
function sameSecret(actual: unknown, expected: string | undefined): boolean {
  if (typeof actual !== "string" || !actual || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {"content-type":"application/json", "cache-control":"no-store"}); res.end(JSON.stringify(body));
}
type ProcessRow = {pid: number; parent: number; birth: string};
async function processes(): Promise<ProcessRow[]> {
  if (process.platform === "win32") return [];
  return new Promise(resolve => execFile("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {timeout:1000, maxBuffer:2*1024*1024}, (err, out) => {
    if (err) return resolve([]);
    resolve(out.split("\n").flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return m ? [{pid:Number(m[1]), parent:Number(m[2]), birth:m[3]}] : [];
    }));
  }));
}
function descendants(rows: ProcessRow[], root: number): ProcessRow[] {
  const ids = new Set([root]); const found: ProcessRow[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (!ids.has(row.pid) && ids.has(row.parent)) {ids.add(row.pid); found.push(row); changed = true;}
  }
  return found;
}
function signal(pid: number, value: NodeJS.Signals) {if (pid > 1 && pid !== process.pid) try {process.kill(pid, value);} catch {/* already gone */}}

/** Separate admission from GET auth: an upgrade launches an owner shell. */
export class TerminalService {
  private tickets = new Map<string, Target>();
  private wss = new WebSocketServer({noServer:true, maxPayload:MAX_FRAME, perMessageDeflate:false});
  private active = new Set<() => Promise<void>>();
  private closed = false;
  private options: Options;
  constructor(options: Options) {this.options = options;}
  get count() {return this.active.size;}
  private now() {return this.options.now?.() ?? Date.now();}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/api/terminal/ticket") return false;
    try {
      if (this.closed || !terminalTransportAllowed(req) || !this.options.authenticate(req) ||
          !sameSecret(req.headers["x-openmausbot-desktop-owner"], this.options.ownerToken())) fail(403, "Local desktop terminal authority required");
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) fail(415, "Send JSON");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req.iterator({destroyOnReturn:false})) {
        bytes += chunk.length; if (bytes > 4096) fail(413, "Terminal request too large"); chunks.push(chunk);
      }
      let body: any;
      try {body = JSON.parse(Buffer.concat(chunks).toString());} catch {fail(400, "Invalid terminal request");}
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["botId","threadId"].includes(k)) ||
          ![body.botId, body.threadId].every(id => typeof id === "string" && /^[\w-]{1,128}$/.test(id))) fail(400, "Send botId and threadId only");
      // Recheck after body read: private desktop authority may change meanwhile.
      if (!this.options.authenticate(req) || !sameSecret(req.headers["x-openmausbot-desktop-owner"], this.options.ownerToken())) fail(403, "Desktop authority changed");
      const cwd = this.options.resolveTarget(body.botId, body.threadId);
      for (const [key, t] of this.tickets) if (t.expires <= this.now()) this.tickets.delete(key);
      if (this.active.size >= 8 || this.tickets.size >= 64) fail(429, "Terminal limit reached");
      const ticket = randomBytes(32).toString("base64url");
      this.tickets.set(ticket, {...body, cwd, origin:origin(req), expires:this.now()+30_000, owner:this.options.ownerToken()!});
      json(res, 201, {ticket});
    } catch (e) {json(res, (e as {status?:number}).status ?? 500, {error: e instanceof Error ? e.message : "Terminal unavailable"});}
    return true;
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let release: (() => void) | undefined;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/api/terminal") fail(404, "Unknown websocket");
      if (this.closed || !terminalTransportAllowed(req) || !this.options.authenticate(req)) fail(403, "Local desktop terminal only");
      const key = url.searchParams.get("ticket") ?? "";
      const t = this.tickets.get(key);
      this.tickets.delete(key); // failed attempts consume the capability too
      if (!t || t.expires <= this.now() || t.origin !== origin(req) || t.owner !== this.options.ownerToken()) fail(403, "Invalid terminal ticket");
      if (this.options.resolveTarget(t.botId, t.threadId) !== t.cwd) fail(409, "Terminal folder changed");
      if (this.active.size >= 8) fail(429, "Terminal limit reached");
      release = this.options.claim?.();
      this.wss.handleUpgrade(req, socket, head, ws => {const lease = release; release = undefined; this.start(ws, t, lease);});
      // ws can reject malformed upgrade headers without invoking the callback.
      release?.(); release = undefined;
    } catch (e) {
      release?.();
      const status = (e as {status?:number}).status ?? 500;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  }
  private start(ws: WebSocket, target: Target, release?: () => void) {
    let pty: ReturnType<typeof spawnTerminalPty>;
    try {pty = spawnTerminalPty(target.cwd);} catch {
      ws.send(JSON.stringify({type:"error", error:"Terminal shell could not start"})); ws.close(1011); release?.(); return;
    }
    let alive = true, stopping: Promise<void> | undefined, shellExited = false;
    let exited!: () => void;
    const ptyDone = new Promise<void>(resolve => {exited = resolve;});
    let known: ProcessRow[] = [], sampling = false;
    const sample = async () => {
      if (sampling || stopping) return;
      sampling = true;
      try {known = descendants(await processes(), pty.pid);} finally {sampling = false;}
    };
    const sampler = setInterval(() => {void sample();}, 250); sampler.unref();
    const cleanup = () => {
      if (stopping) return stopping;
      clearInterval(sampler); clearInterval(heartbeat);
      stopping = (async () => {
        if (process.platform === "win32") {
          if (!shellExited) await new Promise<void>(resolve => execFile("taskkill", ["/PID",String(pty.pid),"/T","/F"], {timeout:2000,windowsHide:true}, () => resolve()));
        } else {
          // Pause the owned shell before discovering job-control descendants.
          if (!shellExited) signal(pty.pid, "SIGSTOP");
          const rows = await processes();
          const children = [...descendants(rows, pty.pid), ...known.filter(k => rows.some(r => r.pid === k.pid && r.birth === k.birth))];
          const unique = [...new Map(children.map(r => [r.pid,r])).values()];
          unique.reverse().forEach(r => signal(r.pid, "SIGTERM"));
          await new Promise(resolve => setTimeout(resolve, 150));
          const remaining = await processes();
          for (const r of unique) if (remaining.some(p => p.pid === r.pid && p.birth === r.birth)) signal(r.pid, "SIGKILL");
          if (!shellExited) {signal(pty.pid,"SIGCONT"); try {pty.kill("SIGKILL");} catch {/* exited */}}
        }
        if (!shellExited) await Promise.race([ptyDone, new Promise(resolve => setTimeout(resolve, 1000))]);
      })().finally(() => {this.active.delete(cleanup); release?.(); if (ws.readyState !== WebSocket.CLOSED) ws.terminate();});
      return stopping;
    };
    const send = (frame: unknown) => {if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));};
    const error = (message: string) => {send({type:"error",error:message}); ws.close(1008); void cleanup();};
    const heartbeat = setInterval(() => {if (!alive) {void cleanup(); return;} alive = false; ws.ping();}, 15_000); heartbeat.unref();
    this.active.add(cleanup);
    ws.on("pong", () => {alive = true;});
    ws.on("close", () => {void cleanup();}); ws.on("error", () => {void cleanup();});
    ws.on("message", (raw, binary) => {
      if (stopping) return;
      try {
        if (binary || raw.toString().length > MAX_FRAME) throw new Error();
        const f = JSON.parse(raw.toString());
        if (f.type === "input" && typeof f.data === "string" && Object.keys(f).every(k => ["type","data"].includes(k))) pty.write(f.data);
        else if (f.type === "resize" && Number.isInteger(f.cols) && Number.isInteger(f.rows) && f.cols >= 1 && f.cols <= 500 && f.rows >= 1 && f.rows <= 200 && Object.keys(f).every(k => ["type","cols","rows"].includes(k))) pty.resize(f.cols,f.rows);
        else throw new Error();
      } catch {error("Invalid terminal frame");}
    });
    pty.onData(data => {
      if (stopping) return;
      if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER) {error("Terminal output buffer exceeded"); return;}
      for (let at = 0; at < data.length; at += 16384) send({type:"output",data:data.slice(at,at+16384)});
    });
    pty.onExit(({exitCode}) => {shellExited = true; exited(); if (!stopping) {send({type:"exit",code:exitCode}); ws.close(1000);} void cleanup();});
    void sample();
    send({type:"ready",cwd:target.cwd});
  }
  async close() {this.closed = true; this.tickets.clear(); await Promise.all([...this.active].map(stop => stop())); this.wss.close();}
}
