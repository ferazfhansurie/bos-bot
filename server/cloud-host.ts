import { createHash } from "node:crypto";
import { HostInboundSchema, LEASE, type HostInbound, type HostOutbound, type Invocation } from "../shared/cloud-run-draft.ts";

/** The mac side of the cloud room host contract (spec: "Bot execution and
 * host contract", D06/D07). One outbound socket to the room service; the
 * host claims offered invocations, runs the native bot turn only after the
 * server confirms the claim with a fencing generation, streams provisional
 * text, and commits one logical final per invocation. A host that lost its
 * claim (fenced, lease expired, stopped) never publishes for that attempt. */

export interface HostSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type HostSocketCtor = new (url: string) => HostSocket;

export type TurnResult = { ok: true; text: string; model: string | null } | { ok: false; failure: string; model: string | null };

export interface CloudHostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CloudRoomHostDeps {
  /** ws(s) or http(s) base of the room service. */
  url: string;
  hostToken: string;
  Socket: HostSocketCtor;
  /** Run the native bot turn. Resolve only once the turn has actually settled. */
  runTurn(invocation: Invocation, io: { onDelta(text: string): void; signal: AbortSignal }): Promise<TurnResult>;
  /** Ask the native turn to stop; runTurn still resolves when it settles. */
  stopTurn(invocationId: string): void | Promise<void>;
  canHost(botId: string): boolean;
  now?: () => number;
  timers?: CloudHostTimers;
  random?: () => number;
  log?: (message: string) => void;
  /** Provisional text coalescing window. */
  deltaCoalesceMs?: number;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
}

type Final = Extract<HostOutbound, { type: "final.commit" }>;
type Failed = Extract<HostOutbound, { type: "invocation.failed" }>;

interface Held {
  invocation: Invocation;
  attempt: number;
  phase: "claiming" | "running" | "settled";
  fenceGen?: number;
  /** Local deadline after which this host no longer believes it holds the lease. */
  leaseDeadline?: number;
  leaseTimer?: unknown;
  abort?: AbortController;
  seq: number;
  buffer: string;
  flushTimer?: unknown;
  /** Stop requested by the server; the control revision to observe. */
  stopRevision?: number;
  stopObservedPending?: boolean;
  final?: { frame: Final; sent: boolean; resends: number };
  failed?: Failed;
}

const MAX_FINAL_RESENDS = 3;

/** One logical final per invocation, stable across attempts and reconnects. */
export function finalResultId(invocationId: string): string {
  const plain = `${invocationId}-final`;
  return plain.length <= 128 ? plain : `final-${createHash("sha256").update(invocationId).digest("hex").slice(0, 48)}`;
}

export function hostRealtimeUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  const ws = trimmed.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
  if (!/^wss?:\/\//i.test(ws)) throw new Error("cloud host url must be ws(s):// or http(s)://");
  return `${ws}/v2/hosts/realtime`;
}

/** Full-jitter backoff: uniform in [0, min(cap, base * 2^n)]. */
export function reconnectDelay(failures: number, random: () => number, baseMs = 500, capMs = 30_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(failures, 30));
  return Math.floor(random() * ceiling);
}

export class CloudRoomHost {
  private readonly deps: CloudRoomHostDeps;
  private readonly now: () => number;
  private readonly timers: CloudHostTimers;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private readonly url: string;
  private socket: HostSocket | null = null;
  private ready = false;
  private closed = false;
  private failures = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private readonly held = new Map<string, Held>();
  /** Highest fenced generation per invocation: a late claimed at or below it never runs. */
  private readonly fencedGen = new Map<string, number>();

  constructor(deps: CloudRoomHostDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
    this.url = hostRealtimeUrl(deps.url);
  }

  start(): void {
    if (this.closed || this.socket) return;
    this.heartbeatTimer ??= this.timers.setInterval(() => this.heartbeat(), LEASE.heartbeatMs);
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== null) this.timers.clearInterval(this.heartbeatTimer);
    this.reconnectTimer = this.heartbeatTimer = null;
    for (const [id, entry] of this.held) if (entry.phase === "running") this.abandon(id, entry, "host stopped");
    for (const [id, entry] of this.held) this.drop(id, entry);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket) { this.detach(socket); try { socket.close(1000, "host stopped"); } catch { /* already closed */ } }
  }

  status(): { connected: boolean; running: string[] } {
    return { connected: this.ready, running: [...this.held].filter(([, entry]) => entry.phase === "running").map(([id]) => id) };
  }

  // ── connection ────────────────────────────────────────────────────

  private connect(): void {
    this.reconnectTimer = null;
    if (this.closed) return;
    let socket: HostSocket;
    try { socket = new this.deps.Socket(this.url); }
    catch (error) { this.log(`cloud host: connect failed: ${error instanceof Error ? error.message : "unknown"}`); this.scheduleReconnect(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      // The credential rides in the first frame, never in the URL.
      socket.send(JSON.stringify({ type: "host.authenticate", host_token: this.deps.hostToken } satisfies HostOutbound));
    };
    socket.onmessage = event => { if (this.socket === socket) this.receive(event.data); };
    socket.onclose = () => { if (this.socket === socket) this.disconnected(); };
    socket.onerror = () => { /* close follows */ };
  }

  private detach(socket: HostSocket): void {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
  }

  private disconnected(): void {
    const socket = this.socket;
    if (socket) this.detach(socket);
    this.socket = null;
    this.ready = false;
    // An unanswered claim is void; the server re-offers queued work on reconnect.
    for (const [id, entry] of this.held) if (entry.phase === "claiming") this.drop(id, entry);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = reconnectDelay(this.failures++, this.random, this.deps.reconnectBaseMs, this.deps.reconnectCapMs);
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), delay);
  }

  private send(frame: HostOutbound): boolean {
    if (!this.ready || !this.socket) return false;
    try { this.socket.send(JSON.stringify(frame)); return true; }
    catch { return false; }
  }

  private onReady(): void {
    this.ready = true;
    this.failures = 0;
    for (const [id, entry] of this.held) {
      if (entry.phase === "running") {
        // Re-establish the lease right away; the server answers lease or fenced.
        this.send({ type: "invocation.heartbeat", invocation_id: id, attempt: entry.attempt, fence_gen: entry.fenceGen! });
        this.flush(id, entry);
        continue;
      }
      if (entry.phase !== "settled") continue;
      if (entry.stopObservedPending) this.observeStop(id, entry);
      if (entry.final) {
        if (!entry.final.sent) {
          if (this.leaseValid(entry)) { entry.final.sent = this.send(entry.final.frame); }
          else { this.drop(id, entry); continue; }
        } else if (entry.final.resends < MAX_FINAL_RESENDS) {
          // Same result_id and fence_gen: the server dedupes or fences it.
          entry.final.resends++;
          this.send(entry.final.frame);
        } else {
          this.log(`cloud host: final for ${id} never acknowledged; leaving recovery to the server`);
          this.drop(id, entry);
          continue;
        }
      }
      if (entry.failed) {
        if (this.leaseValid(entry)) this.send(entry.failed);
        entry.failed = undefined;
      }
      this.reapIfDone(id, entry);
    }
  }

  // ── inbound ───────────────────────────────────────────────────────

  private receive(data: unknown): void {
    let raw: unknown;
    try { raw = JSON.parse(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data)); }
    catch { this.log("cloud host: ignored a frame that is not JSON"); return; }
    const parsed = HostInboundSchema.safeParse(raw);
    if (!parsed.success) { this.log("cloud host: ignored an unknown frame"); return; }
    this.handle(parsed.data);
  }

  private handle(frame: HostInbound): void {
    switch (frame.type) {
      case "host.ready": this.onReady(); return;
      case "invocation.offered": this.onOffered(frame.invocation, frame.attempt); return;
      case "invocation.claimed": this.onClaimed(frame); return;
      case "invocation.lease": this.onLease(frame); return;
      case "invocation.fenced": this.onFenced(frame); return;
      case "final.committed": this.onCommitted(frame); return;
      case "stop.requested": this.onStop(frame.invocation_id, frame.control_revision); return;
      case "error": {
        this.log(`cloud host: server error${frame.invocation_id ? ` for ${frame.invocation_id}` : ""}: ${frame.error.slice(0, 200)}`);
        const entry = frame.invocation_id ? this.held.get(frame.invocation_id) : undefined;
        if (entry?.phase === "claiming") this.drop(frame.invocation_id!, entry);
        return;
      }
    }
  }

  private onOffered(invocation: Invocation, attempt: number): void {
    const id = invocation.invocation_id;
    if (this.held.has(id) || !this.ready) return;
    let eligible = false;
    try { eligible = this.deps.canHost(invocation.bot_id); } catch { eligible = false; }
    if (!eligible) return;
    this.held.set(id, { invocation, attempt, phase: "claiming", seq: 0, buffer: "" });
    if (!this.send({ type: "invocation.claim", invocation_id: id, attempt })) this.held.delete(id);
  }

  private onClaimed(frame: Extract<HostInbound, { type: "invocation.claimed" }>): void {
    const id = frame.invocation_id;
    const entry = this.held.get(id);
    if (!entry || entry.attempt !== frame.attempt) return;
    if ((this.fencedGen.get(id) ?? -1) >= frame.fence_gen) return;
    if (entry.phase !== "claiming") {
      if (entry.fenceGen === frame.fence_gen) this.renewLease(id, entry, frame.lease_expires_at);
      return;
    }
    entry.fenceGen = frame.fence_gen;
    entry.phase = "running";
    this.renewLease(id, entry, frame.lease_expires_at);
    if (entry.stopRevision !== undefined) {
      // Stopped before the turn started: nothing runs, nothing publishes.
      entry.phase = "settled";
      this.observeStop(id, entry);
      this.reapIfDone(id, entry);
      return;
    }
    this.run(id, entry);
  }

  private onLease(frame: Extract<HostInbound, { type: "invocation.lease" }>): void {
    const entry = this.held.get(frame.invocation_id);
    if (!entry || entry.attempt !== frame.attempt || entry.fenceGen !== frame.fence_gen) return;
    this.renewLease(frame.invocation_id, entry, frame.lease_expires_at);
  }

  private onFenced(frame: Extract<HostInbound, { type: "invocation.fenced" }>): void {
    const id = frame.invocation_id;
    this.fencedGen.set(id, Math.max(this.fencedGen.get(id) ?? -1, frame.fence_gen));
    const entry = this.held.get(id);
    if (!entry) return;
    // A fence for an older generation than the one we hold is stale news.
    if (entry.fenceGen !== undefined && frame.fence_gen < entry.fenceGen) return;
    this.log(`cloud host: ${id} attempt ${entry.attempt} fenced`);
    if (entry.phase === "running") this.abandon(id, entry, "fenced");
    this.drop(id, entry);
  }

  private onCommitted(frame: Extract<HostInbound, { type: "final.committed" }>): void {
    const entry = this.held.get(frame.invocation_id);
    if (!entry?.final || entry.final.frame.result_id !== frame.result_id) return;
    entry.final = undefined;
    this.reapIfDone(frame.invocation_id, entry);
  }

  private onStop(id: string, controlRevision: number): void {
    const entry = this.held.get(id);
    if (!entry) return;
    entry.stopRevision = Math.max(entry.stopRevision ?? -1, controlRevision);
    if (entry.phase === "claiming") return; // observed once the claim resolves
    if (entry.phase === "settled") {
      // The turn already settled; a final produced before the stop stays.
      this.observeStop(id, entry);
      this.reapIfDone(id, entry);
      return;
    }
    entry.abort?.abort();
    void Promise.resolve().then(() => this.deps.stopTurn(id)).catch(error =>
      this.log(`cloud host: stop for ${id} failed: ${error instanceof Error ? error.message : "unknown"}`));
    // stop.observed waits for runTurn to settle (see run()).
  }

  // ── running a turn ────────────────────────────────────────────────

  private run(id: string, entry: Held): void {
    const abort = new AbortController();
    entry.abort = abort;
    const onDelta = (text: string) => {
      if (abort.signal.aborted || this.held.get(id) !== entry || !text) return;
      entry.buffer += text;
      entry.flushTimer ??= this.timers.setTimeout(() => { entry.flushTimer = undefined; this.flush(id, entry); }, this.deps.deltaCoalesceMs ?? 50);
    };
    let result: Promise<TurnResult>;
    try { result = this.deps.runTurn(entry.invocation, { onDelta, signal: abort.signal }); }
    catch (error) { result = Promise.reject(error); }
    result.then(outcome => outcome, error => ({ ok: false as const, failure: error instanceof Error ? error.message : String(error), model: null }))
      .then(outcome => this.settle(id, entry, outcome));
  }

  private flush(id: string, entry: Held): void {
    if (entry.flushTimer !== undefined) { this.timers.clearTimeout(entry.flushTimer); entry.flushTimer = undefined; }
    if (!entry.buffer || entry.phase !== "running" || entry.abort?.signal.aborted || this.held.get(id) !== entry) return;
    if (!this.leaseValid(entry)) return;
    // Held across a disconnect and flushed on reconnect; provisional only.
    if (this.send({ type: "stream.delta", invocation_id: id, attempt: entry.attempt, fence_gen: entry.fenceGen!, seq: entry.seq, text: entry.buffer })) {
      entry.seq++;
      entry.buffer = "";
    }
  }

  private settle(id: string, entry: Held, outcome: TurnResult): void {
    // Dropped (fenced, lease lost, host stopped): the attempt publishes nothing.
    if (this.held.get(id) !== entry) return;
    if (entry.stopRevision !== undefined) {
      entry.phase = "settled";
      entry.buffer = "";
      this.observeStop(id, entry);
      this.reapIfDone(id, entry);
      return;
    }
    if (entry.abort?.signal.aborted || !this.leaseValid(entry)) { this.drop(id, entry); return; }
    this.flush(id, entry);
    entry.phase = "settled";
    entry.buffer = "";
    const base = { invocation_id: id, attempt: entry.attempt, fence_gen: entry.fenceGen! };
    if (outcome.ok) {
      const frame: Final = { type: "final.commit", ...base, result_id: finalResultId(id), text: outcome.text, model: outcome.model ?? null };
      entry.final = { frame, sent: this.send(frame), resends: 0 };
    } else {
      const frame: Failed = { type: "invocation.failed", ...base, failure: outcome.failure.slice(0, 1000), model: outcome.model ?? null };
      if (!this.send(frame)) entry.failed = frame;
    }
    this.reapIfDone(id, entry);
  }

  private observeStop(id: string, entry: Held): void {
    if (entry.stopRevision === undefined || entry.fenceGen === undefined) return;
    entry.stopObservedPending = !this.send({ type: "stop.observed", invocation_id: id, attempt: entry.attempt, fence_gen: entry.fenceGen, control_revision: entry.stopRevision });
  }

  /** Stop the native turn for an attempt this host no longer owns. */
  private abandon(id: string, entry: Held, reason: string): void {
    entry.abort?.abort();
    void Promise.resolve().then(() => this.deps.stopTurn(id)).catch(error =>
      this.log(`cloud host: stop after ${reason} for ${id} failed: ${error instanceof Error ? error.message : "unknown"}`));
  }

  // ── lease ─────────────────────────────────────────────────────────

  private heartbeat(): void {
    for (const [id, entry] of this.held) {
      if (entry.phase !== "running" || entry.fenceGen === undefined) continue;
      this.send({ type: "invocation.heartbeat", invocation_id: id, attempt: entry.attempt, fence_gen: entry.fenceGen });
    }
  }

  private renewLease(id: string, entry: Held, leaseExpiresAt: string): void {
    // Never believe a lease longer than one TTL from now, whatever the clocks say.
    const now = this.now();
    const absolute = Date.parse(leaseExpiresAt);
    const deadline = Math.min(Number.isFinite(absolute) ? absolute : Infinity, now + LEASE.ttlMs);
    entry.leaseDeadline = deadline;
    if (entry.leaseTimer !== undefined) this.timers.clearTimeout(entry.leaseTimer);
    entry.leaseTimer = this.timers.setTimeout(() => this.leaseCheck(id, entry), Math.max(0, deadline - now));
  }

  private leaseValid(entry: Held): boolean {
    return entry.leaseDeadline !== undefined && this.now() < entry.leaseDeadline;
  }

  private leaseCheck(id: string, entry: Held): void {
    entry.leaseTimer = undefined;
    if (this.held.get(id) !== entry || entry.leaseDeadline === undefined) return;
    if (this.now() < entry.leaseDeadline) {
      entry.leaseTimer = this.timers.setTimeout(() => this.leaseCheck(id, entry), entry.leaseDeadline - this.now());
      return;
    }
    if (entry.phase === "running") {
      this.log(`cloud host: lease for ${id} attempt ${entry.attempt} expired; stopping locally`);
      this.abandon(id, entry, "lease expiry");
      this.drop(id, entry);
      return;
    }
    // A final already sent may still be resent (server dedupes or fences);
    // anything not yet published is dropped.
    if (entry.final?.sent || entry.stopObservedPending) { entry.failed = undefined; return; }
    this.drop(id, entry);
  }

  // ── bookkeeping ───────────────────────────────────────────────────

  private reapIfDone(id: string, entry: Held): void {
    if (entry.phase !== "settled" || entry.final || entry.failed || entry.stopObservedPending) return;
    this.drop(id, entry);
  }

  private drop(id: string, entry: Held): void {
    if (entry.flushTimer !== undefined) this.timers.clearTimeout(entry.flushTimer);
    if (entry.leaseTimer !== undefined) this.timers.clearTimeout(entry.leaseTimer);
    entry.flushTimer = entry.leaseTimer = undefined;
    entry.buffer = "";
    if (this.held.get(id) === entry) this.held.delete(id);
    if (this.fencedGen.size > 1000) this.fencedGen.delete(this.fencedGen.keys().next().value!);
  }
}
