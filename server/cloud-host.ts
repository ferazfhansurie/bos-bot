import { createHash } from "node:crypto";
import { z } from "zod";
import { ContextSchema, InvocationSchema, LIMITS, type CloudInvocation } from "../shared/cloud-protocol/index.ts";

/** The mac side of the slice 3/4 room host contract (shared/cloud-protocol
 * README "slices 3/4 frozen additions", services/cloud/SLICE34.md). Plain
 * HTTPS polling, JSON, no socket. Every request carries the issuer bearer in
 * `Authorization` and the host credential in `X-Cloud-Host-Credential`;
 * neither ever appears in a URL, a body or a log line.
 *
 * Per invocation: claim -> context (validates the binding) -> checkpoint
 * {replay_safe:false} -> native turn -> coalesced stream.delta -> exactly one
 * final.commit. Heartbeat every 10s holds the 30s lease. The host learns
 * about a human stop, a fence, lease expiry or removed access only because
 * heartbeat/events start failing: lease_lost or forbidden aborts the turn and
 * nothing is ever published for that attempt again. After lease_lost (and once
 * the turn has settled) the host offers stop.observed at control_revision + 1,
 * which the server accepts only when the loss was a human stop.
 *
 * fence_gen and control_revision are decimal strings end to end (BigInt only
 * for the +1); they are never converted to Number. */

export type CloudContext = z.infer<typeof ContextSchema>;
export type RunBinding = { invocation_id: string; attempt: number; fence_gen: string };

export interface HostFetchInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
export interface HostFetchResponse { status: number; text(): Promise<string> }
export type HostFetch = (url: string, init: HostFetchInit) => Promise<HostFetchResponse>;

export type TurnResult = { ok: true; text: string; model: string | null } | { ok: false; failure: string; model: string | null };

/** What the native turn runs: the leased invocation and the exact source text.
 * `context.messages` is untrusted room history; this host does not feed it to
 * the provider (the prompt is `source.text` only). */
export interface CloudTurn { invocation: CloudInvocation; prompt: string; context: CloudContext }

export interface CloudRoomHostDeps {
  /** http(s) base of the room service, no trailing slash needed. */
  baseUrl: string;
  workspaceId: string;
  hostId: string;
  /** X-Cloud-Host-Credential from host registration. */
  credential: string;
  /** Current issuer bearer. */
  bearer: string;
  fetch: HostFetch;
  /** Run the native bot turn. Resolve only once the turn has actually settled. */
  runTurn(turn: CloudTurn, io: { onDelta(text: string): void; signal: AbortSignal }): Promise<TurnResult>;
  /** Ask the native turn to stop; runTurn still resolves when it settles. */
  stopTurn(invocationId: string): void | Promise<void>;
  canHost(botId: string): boolean;
  random?: () => number;
  log?: (message: string) => void;
  maxConcurrent?: number;
  pollMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  deltaFlushMs?: number;
  requestTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

export const HOST_DEFAULTS = Object.freeze({
  maxConcurrent: 2, pollMs: 5_000, heartbeatMs: 10_000, leaseMs: 30_000, deltaFlushMs: 250,
  requestTimeoutMs: LIMITS.requestMs, backoffBaseMs: 500, backoffCapMs: 30_000,
});
/** Server caps are 1 MiB / 1000 deltas per invocation; stop a little short. */
export const DELTA_BUDGET = Object.freeze({ bytes: 1_000_000, count: 990 });
export const EMPTY_FINAL_TEXT = "(no reply)";
export const TRUNCATION_MARKER = "\n\n[reply truncated]";

const RETRYABLE = new Set(["rate_limited", "unavailable", "deadline_exceeded", "identity_unavailable", "transport", "bad_response"]);
const OffersSchema = z.object({ invocations: z.array(z.unknown()) });

type Reply = { ok: true; body: unknown } | { ok: false; code: string; status: number; retryable: boolean; retryAfterMs?: number };

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

/** Split text into pieces of at most maxBytes UTF-8 bytes, never inside a code point. */
export function utf8Chunks(text: string, maxBytes: number): string[] {
  const bytes = Buffer.from(text, "utf8");
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + maxBytes);
    if (end < bytes.length) while (end > start && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return out;
}

/** The committed final: never empty, never over the 64 KiB text budget. A
 * successful turn with no assistant text commits a short placeholder rather
 * than nothing, so the run completes instead of sitting held forever. */
export function finalText(text: string): string {
  if (!text.trim()) return EMPTY_FINAL_TEXT;
  if (utf8(text) <= LIMITS.textBytes) return text;
  return utf8Chunks(text, LIMITS.textBytes - utf8(TRUNCATION_MARKER))[0]! + TRUNCATION_MARKER;
}

/** Unique per delta within an attempt and identical on every retry of that delta. */
export function deltaId(invocationId: string, attempt: number, n: number): string {
  const plain = `${invocationId}-${attempt}-${n}`;
  if (plain.length <= 128) return plain;
  return `d-${createHash("sha256").update(invocationId).digest("hex").slice(0, 48)}-${attempt}-${n}`;
}

export function nextControlRevision(revision: string): string {
  return (BigInt(revision) + 1n).toString();
}

/** Equal-jitter exponential backoff: [ceiling/2, ceiling], ceiling = min(cap, base * 2^n). */
export function backoffDelay(failures: number, random: () => number, baseMs: number = HOST_DEFAULTS.backoffBaseMs, capMs: number = HOST_DEFAULTS.backoffCapMs): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(failures, 30));
  return Math.floor(ceiling / 2 + random() * ceiling / 2);
}

const finished = (run: { phase: string }) => run.phase === "done";

type Loss = "lease_lost" | "forbidden" | "expired";

interface Run {
  id: string;
  phase: "claiming" | "preparing" | "running" | "finalizing" | "done";
  binding?: RunBinding;
  /** Last control_revision seen from claim/heartbeat (decimal string). */
  controlRevision?: string;
  abort: AbortController;
  lost?: Loss;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  beating: boolean;
  /** Start time of the last request that renewed the lease. */
  renewedAt: number;
  buffer: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  deltasOpen: boolean;
  deltaCount: number;
  deltaBytes: number;
  deltaChain: Promise<void>;
}

export class CloudRoomHost {
  private readonly deps: CloudRoomHostDeps;
  private readonly opts: Record<keyof typeof HOST_DEFAULTS, number>;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private readonly base: string;
  private readonly runs = new Map<string, Run>();
  private started = false;
  private closed = false;
  private online = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollFailures = 0;
  private lastPollError = "";
  private readonly sleepers = new Set<() => void>();

  constructor(deps: CloudRoomHostDeps) {
    this.deps = deps;
    this.opts = {
      maxConcurrent: deps.maxConcurrent ?? HOST_DEFAULTS.maxConcurrent,
      pollMs: deps.pollMs ?? HOST_DEFAULTS.pollMs,
      heartbeatMs: deps.heartbeatMs ?? HOST_DEFAULTS.heartbeatMs,
      leaseMs: deps.leaseMs ?? HOST_DEFAULTS.leaseMs,
      deltaFlushMs: deps.deltaFlushMs ?? HOST_DEFAULTS.deltaFlushMs,
      requestTimeoutMs: deps.requestTimeoutMs ?? HOST_DEFAULTS.requestTimeoutMs,
      backoffBaseMs: deps.backoffBaseMs ?? HOST_DEFAULTS.backoffBaseMs,
      backoffCapMs: deps.backoffCapMs ?? HOST_DEFAULTS.backoffCapMs,
    };
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
    this.base = `${deps.baseUrl.trim().replace(/\/+$/, "")}/v2/workspaces/${encodeURIComponent(deps.workspaceId)}/hosts/${encodeURIComponent(deps.hostId)}`;
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.schedulePoll(0);
  }

  /** Stops polling and aborts every local turn. Nothing is published afterwards;
   * the server holds whatever was running once its lease lapses. */
  stop(): void {
    this.closed = true;
    this.online = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const wake of this.sleepers) wake();
    for (const run of this.runs.values()) {
      const wasRunning = run.phase === "running";
      this.quiet(run);
      run.abort.abort();
      if (wasRunning) this.interrupt(run, "host stopped");
    }
  }

  status(): { online: boolean; running: string[] } {
    return { online: this.online, running: [...this.runs.keys()] };
  }

  // ── transport ─────────────────────────────────────────────────────

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.deps.bearer}`,
        "X-Cloud-Host-Credential": this.deps.credential,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await this.deps.fetch(`${this.base}/${path}`, {
        method, headers, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const raw = await response.text();
      let parsed: unknown = undefined;
      try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
      const error = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error : undefined;
      if (response.status >= 200 && response.status < 300 && !error) {
        if (parsed === undefined) return { ok: false, code: "bad_response", status: response.status, retryable: true };
        return { ok: true, body: parsed };
      }
      const code = error ?? (response.status === 429 ? "rate_limited" : response.status >= 500 ? "unavailable" : `http_${response.status}`);
      const retryAfter = (parsed as { retry_after?: unknown } | undefined)?.retry_after;
      return {
        ok: false, code, status: response.status, retryable: RETRYABLE.has(code) || (!error && response.status >= 500),
        ...(typeof retryAfter === "number" && retryAfter > 0 ? { retryAfterMs: Math.min(retryAfter * 1000, 60_000) } : {}),
      };
    } catch {
      return { ok: false, code: "transport", status: 0, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retries transient failures with backoff while `alive()` holds; returns the last reply. */
  private async callRetrying(method: "GET" | "POST", path: string, body: unknown, opts: { attempts: number; alive: () => boolean; noRetry?: string[] }): Promise<Reply> {
    for (let n = 0; ; n++) {
      const reply = await this.call(method, path, body);
      if (reply.ok || !reply.retryable || opts.noRetry?.includes(reply.code)) return reply;
      if (n + 1 >= opts.attempts || !opts.alive()) return reply;
      await this.sleep(Math.max(reply.retryAfterMs ?? 0, backoffDelay(n, this.random, this.opts.backoffBaseMs, this.opts.backoffCapMs)));
      if (!opts.alive()) return reply;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.sleepers.delete(wake); resolve(); };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  // ── idle polling (also renews host liveness) ──────────────────────

  private schedulePoll(ms: number): void {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.poll(); }, ms);
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    const reply = await this.call("GET", "invocations");
    if (this.closed) return;
    if (!reply.ok) {
      this.online = false;
      if (reply.code !== this.lastPollError) this.log(`cloud host: polling failed (${reply.code}); backing off`);
      this.lastPollError = reply.code;
      const delay = backoffDelay(this.pollFailures++, this.random, this.opts.backoffBaseMs, this.opts.backoffCapMs);
      this.schedulePoll(Math.max(reply.retryAfterMs ?? 0, delay));
      return;
    }
    if (!this.online) this.log("cloud host: online");
    this.online = true;
    this.pollFailures = 0;
    this.lastPollError = "";
    const offers = OffersSchema.safeParse(reply.body);
    if (offers.success) for (const raw of offers.data.invocations) this.consider(raw);
    else this.log("cloud host: ignored a malformed offer list");
    // ±20% jitter so a fleet of hosts does not poll in lockstep.
    this.schedulePoll(Math.round(this.opts.pollMs * (0.8 + 0.4 * this.random())));
  }

  private consider(raw: unknown): void {
    const parsed = InvocationSchema.safeParse(raw);
    if (!parsed.success) { this.log("cloud host: ignored a malformed offer"); return; }
    const offer = parsed.data;
    // Never claim the same invocation twice locally, and respect the slot limit.
    if (this.runs.has(offer.invocation_id) || this.runs.size >= this.opts.maxConcurrent || offer.stop_requested) return;
    let eligible = false;
    try { eligible = this.deps.canHost(offer.bot_id); } catch { eligible = false; }
    if (!eligible) return;
    const run: Run = {
      id: offer.invocation_id, phase: "claiming", abort: new AbortController(), beating: false, renewedAt: Date.now(),
      buffer: "", deltasOpen: true, deltaCount: 0, deltaBytes: 0, deltaChain: Promise.resolve(),
    };
    this.runs.set(run.id, run);
    void this.execute(run).catch(error =>
      this.log(`cloud host: ${run.id} failed locally: ${error instanceof Error ? error.message : "unknown"}`)
    ).finally(() => this.finish(run));
  }

  // ── one invocation ────────────────────────────────────────────────

  private live(run: Run): boolean {
    return !this.closed && !run.lost;
  }

  private async execute(run: Run): Promise<void> {
    const alive = () => this.live(run);
    const claimStartedAt = Date.now();
    const claimed = await this.callRetrying("POST", "claim", { invocation_id: run.id }, { attempts: 3, alive });
    if (!claimed.ok) {
      // lease_lost: another host has it, or it was stopped; not ours to observe.
      if (claimed.code !== "lease_lost") this.log(`cloud host: claim for ${run.id} failed (${claimed.code})`);
      return;
    }
    const leased = InvocationSchema.safeParse(claimed.body);
    if (!leased.success || leased.data.invocation_id !== run.id || leased.data.host_id !== this.deps.hostId || !["leased", "running"].includes(leased.data.state)) {
      this.log(`cloud host: claim for ${run.id} returned an unexpected run; skipping`);
      return;
    }
    const invocation = leased.data;
    const binding: RunBinding = { invocation_id: invocation.invocation_id, attempt: invocation.attempt, fence_gen: invocation.fence_gen };
    run.binding = binding;
    run.controlRevision = invocation.control_revision;
    run.renewedAt = claimStartedAt;
    run.phase = "preparing";
    run.heartbeatTimer = setInterval(() => void this.beat(run), this.opts.heartbeatMs);

    const context = await this.callRetrying("POST", "context", binding, { attempts: 3, alive });
    if (!context.ok) return this.rejected(run, "context", context);
    const parsedContext = ContextSchema.safeParse(context.body);
    if (!parsedContext.success || parsedContext.data.invocation_id !== run.id || parsedContext.data.source.digest !== invocation.source.digest) {
      // Released unstarted: the lease lapses and the server may safely re-offer it.
      this.log(`cloud host: context for ${run.id} did not match the claimed source; releasing`);
      return;
    }
    if (!this.live(run)) return this.afterLoss(run);

    // The checkpoint must be recorded before the provider is entered; without
    // it the turn never starts.
    const checkpoint = await this.callRetrying("POST", "events", { kind: "checkpoint", ...binding, replay_safe: false }, { attempts: 3, alive });
    if (!checkpoint.ok) return this.rejected(run, "checkpoint", checkpoint);
    if (!this.live(run)) return this.afterLoss(run);

    run.phase = "running";
    const onDelta = (text: string) => this.buffer(run, text);
    let pending: Promise<TurnResult>;
    // Prompt is the exact source text. Room history from /context is untrusted
    // and is deliberately not passed to the provider as instructions.
    try { pending = this.deps.runTurn({ invocation, prompt: parsedContext.data.source.text, context: parsedContext.data }, { onDelta, signal: run.abort.signal }); }
    catch (error) { pending = Promise.reject(error); }
    const outcome = await pending.catch((error: unknown): TurnResult => ({ ok: false, failure: error instanceof Error ? error.message : String(error), model: null }));

    // The turn has settled. A lost lease means nothing is published, ever.
    if (run.lost) return this.afterLoss(run);
    if (this.closed) return;
    if (outcome.model && outcome.model !== invocation.model.model) {
      this.log(`cloud host: ${run.id} ran on ${outcome.model}, pinned ${invocation.model.provider}/${invocation.model.model}`);
    }
    if (!outcome.ok) {
      // There is no host "failed" event in the contract. Publishing a failure
      // text as the bot's final would be a lie in the room, so the host posts
      // nothing, stops heartbeating and lets the server hold the run when the
      // lease lapses (checkpointed work is never auto-replayed).
      this.log(`cloud host: ${run.id} turn failed (${outcome.failure.slice(0, 200)}); leaving it to the server to hold`);
      return;
    }

    run.phase = "finalizing";
    await this.closeDeltas(run);
    // Identical body on every retry: the server dedupes by digest even after completion.
    const final = { kind: "final.commit" as const, ...binding, text: finalText(outcome.text) };
    const committed = await this.callRetrying("POST", "events", final, { attempts: Number.POSITIVE_INFINITY, alive: () => !this.closed });
    if (committed.ok) return;
    if (committed.code === "lease_lost") {
      // A stop (or fence) landed before the final; the final is not ours to publish.
      this.lose(run, "lease_lost");
      return this.afterLoss(run);
    }
    this.log(`cloud host: final for ${run.id} was not accepted (${committed.code})`);
  }

  private rejected(run: Run, step: string, reply: Extract<Reply, { ok: false }>): Promise<void> | void {
    if (reply.code === "lease_lost" || reply.code === "forbidden") {
      this.lose(run, reply.code);
      return this.afterLoss(run);
    }
    if (run.lost) return this.afterLoss(run);
    this.log(`cloud host: ${step} for ${run.id} failed (${reply.code}); releasing`);
  }

  /** Called only after the turn (if any) has settled. */
  private async afterLoss(run: Run): Promise<void> {
    if (this.closed || !run.lost || run.lost === "forbidden" || !run.binding || run.controlRevision === undefined) return;
    // A human stop increments control_revision by exactly one and leaves the
    // fence alone; a fence/expiry hold bumps both, so this is refused then.
    const observed = { kind: "stop.observed" as const, ...run.binding, control_revision: nextControlRevision(run.controlRevision) };
    const reply = await this.callRetrying("POST", "events", observed, { attempts: 5, alive: () => !this.closed });
    if (reply.ok) this.log(`cloud host: stop observed for ${run.id}`);
  }

  // ── lease ─────────────────────────────────────────────────────────

  private async beat(run: Run): Promise<void> {
    if (run.beating || run.lost || run.phase === "done" || !run.binding || this.closed) return;
    // A final in flight is retried on its own; it decides the outcome then.
    if (run.phase !== "finalizing" && Date.now() - run.renewedAt >= this.opts.leaseMs) {
      this.log(`cloud host: lease for ${run.id} lapsed without a heartbeat; stopping locally`);
      this.lose(run, "expired");
      return;
    }
    run.beating = true;
    const startedAt = Date.now();
    const reply = await this.call("POST", "heartbeat", run.binding);
    run.beating = false;
    // Re-read after the await: the run may have finished or been lost meanwhile.
    if (run.lost || finished(run)) return;
    if (reply.ok) {
      const lease = InvocationSchema.safeParse(reply.body);
      if (lease.success && lease.data.invocation_id === run.id && lease.data.fence_gen === run.binding.fence_gen) {
        run.renewedAt = startedAt;
        run.controlRevision = lease.data.control_revision;
      }
      return;
    }
    if (run.phase === "finalizing") return;
    if (reply.code === "lease_lost" || reply.code === "forbidden") this.lose(run, reply.code);
    // Anything else: try again next tick; the local lease check bounds it.
  }

  private lose(run: Run, why: Loss): void {
    if (run.lost) return;
    run.lost = why;
    const wasRunning = run.phase === "running";
    this.quiet(run);
    run.abort.abort();
    if (why !== "expired") this.log(`cloud host: ${run.id} ${why === "forbidden" ? "access removed" : "lease lost"}; aborting`);
    if (wasRunning) this.interrupt(run, why);
  }

  private interrupt(run: Run, reason: string): void {
    void Promise.resolve().then(() => this.deps.stopTurn(run.id)).catch(error =>
      this.log(`cloud host: stop after ${reason} for ${run.id} failed: ${error instanceof Error ? error.message : "unknown"}`));
  }

  // ── provisional text ──────────────────────────────────────────────

  private buffer(run: Run, text: string): void {
    if (!text || run.phase !== "running" || !run.deltasOpen || !this.live(run)) return;
    run.buffer += text;
    run.flushTimer ??= setTimeout(() => { run.flushTimer = undefined; this.flush(run); }, this.opts.deltaFlushMs);
  }

  private flush(run: Run): void {
    if (!run.buffer) return;
    const text = run.buffer;
    run.buffer = "";
    run.deltaChain = run.deltaChain.then(() => this.sendDeltas(run, text));
  }

  private async sendDeltas(run: Run, text: string): Promise<void> {
    const alive = () => run.deltasOpen && this.live(run);
    for (const chunk of utf8Chunks(text, LIMITS.textBytes)) {
      if (!alive() || !run.binding) return;
      const bytes = utf8(chunk);
      if (run.deltaCount >= DELTA_BUDGET.count || run.deltaBytes + bytes > DELTA_BUDGET.bytes) {
        this.log(`cloud host: ${run.id} reached the streaming budget; the final still commits`);
        run.deltasOpen = false;
        return;
      }
      const body = { kind: "stream.delta" as const, ...run.binding, delta_id: deltaId(run.id, run.binding.attempt, run.deltaCount), text: chunk };
      // rate_limited here is the per-invocation stream cap: stop streaming, do not retry.
      const reply = await this.callRetrying("POST", "events", body, { attempts: 3, alive, noRetry: ["rate_limited"] });
      if (reply.ok) { run.deltaCount++; run.deltaBytes += bytes; continue; }
      if ((reply.code === "lease_lost" || reply.code === "forbidden") && run.phase === "running") { this.lose(run, reply.code); return; }
      // Provisional text is optional; anything else just ends streaming.
      run.deltasOpen = false;
      return;
    }
  }

  private async closeDeltas(run: Run): Promise<void> {
    if (run.flushTimer !== undefined) clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
    run.buffer = "";
    run.deltasOpen = false;
    await run.deltaChain;
  }

  // ── bookkeeping ───────────────────────────────────────────────────

  private quiet(run: Run): void {
    if (run.heartbeatTimer !== undefined) clearInterval(run.heartbeatTimer);
    if (run.flushTimer !== undefined) clearTimeout(run.flushTimer);
    run.heartbeatTimer = run.flushTimer = undefined;
    run.buffer = "";
    run.deltasOpen = false;
  }

  private finish(run: Run): void {
    this.quiet(run);
    run.phase = "done";
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
  }
}
