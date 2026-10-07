import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostAppendSchema, HostClaimSchema, InvocationSchema, RunBindingSchema, canonicalJson, type CloudInvocation } from "../shared/cloud-protocol/index.ts";
import {
  CloudRoomHost, DELTA_BUDGET, EMPTY_FINAL_TEXT, TRUNCATION_MARKER, backoffDelay, deltaId, finalText, nextControlRevision, utf8Chunks,
  type CloudRoomHostDeps, type CloudTurn, type HostFetch, type TurnResult,
} from "./cloud-host.ts";
import { cloudHostBaseUrl, startCloudHostFromEnv } from "./cloud-host-runtime.ts";

const BASE = "https://rooms.example.test";
const W = "ws_1";
const H = "host_1";
const CREDENTIAL = "h_super-secret-host-credential";
const BEARER = "super-secret-issuer-bearer";
const PREFIX = `${BASE}/v2/workspaces/${W}/hosts/${H}/`;

type Fault = "transport" | "lost" | { status: number; error?: string; retry_after?: number };
interface Call { method: string; url: string; path: string; headers: Record<string, string>; raw?: string; body?: Record<string, unknown> }
type Row = CloudInvocation & { forbidden: boolean; streamedBytes: number; deltaCount: number };

/** In-memory model of services/cloud/runtime.ts host routes (no lease clock). */
class FakeService {
  calls: Call[] = [];
  rows = new Map<string, Row>();
  faults = new Map<string, Fault[]>();
  deltas = new Map<string, string>();
  finals = new Map<string, string>();
  cap = { bytes: 1_048_576, count: 1000 };
  /** Keep offering these even when no longer queued (a stale/racing offer list). */
  sticky: string[] = [];
  duplicate = false;
  log: string[] = [];

  add(id: string, over: { fence_gen?: string; control_revision?: string; bot_id?: string; text?: string } = {}): void {
    const row: Row = {
      invocation_id: id, attempt: 0, fence_gen: over.fence_gen ?? "0", workspace_id: W, room_id: "room_1", thread_id: "thr_1",
      bot_id: over.bot_id ?? "bot_1", state: "queued", model: { provider: "anthropic", model: "claude-sonnet-4-6", config_revision: "1" },
      source: { message_id: `msg_${id}`, version: 1, digest: "a".repeat(64), actor_id: "acct_ana", text: over.text ?? "@bot hello", mentions: [], attachment_ids: [] },
      control_revision: over.control_revision ?? "0", host_id: null, lease_expires_at: null, queued_expires_at: "2026-10-08T12:00:00.000Z",
      result_message_id: null, stop_requested: false, stopped_observed: false, replay_safe: true,
      forbidden: false, streamedBytes: 0, deltaCount: 0,
    };
    this.rows.set(id, row);
  }

  view(row: Row): CloudInvocation {
    const { forbidden: _f, streamedBytes: _s, deltaCount: _d, ...run } = row;
    return InvocationSchema.parse(run);
  }

  fault(key: string, ...faults: Fault[]): void { this.faults.set(key, [...(this.faults.get(key) ?? []), ...faults]); }

  /** A human stop: held + stop_requested, control_revision + 1, fence unchanged. */
  stop(id: string): void {
    const row = this.rows.get(id)!;
    Object.assign(row, { state: "held", stop_requested: true, lease_expires_at: null, control_revision: nextControlRevision(row.control_revision) });
  }

  of(path: string, kind?: string): Call[] {
    return this.calls.filter(call => call.path === path && (!kind || call.body?.kind === kind));
  }

  fetch: HostFetch = async (url, init) => {
    const match = /^\/v2\/workspaces\/([^/]+)\/hosts\/([^/]+)\/(\w+)$/.exec(new URL(url).pathname);
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const path = match?.[3] ?? "?";
    this.calls.push({ method: init.method, url, path, headers: init.headers, ...(init.body ? { raw: init.body, body } : {}) });
    const fault = this.faults.get(path === "events" ? `events:${String(body?.kind)}` : path)?.shift();
    if (fault === "transport") throw new TypeError("fetch failed");
    if (fault && fault !== "lost") return reply(fault.status, { error: fault.error ?? "unavailable", ...(fault.retry_after ? { retry_after: fault.retry_after } : {}) });
    const [status, value] = init.headers.Authorization === `Bearer ${BEARER}` && init.headers["X-Cloud-Host-Credential"] === CREDENTIAL
      ? this.route(init.method, path, body) : [401, { error: "host_invalid" }] as const;
    if (status === 200) this.log.push(path === "events" ? String(body?.kind) : path);
    if (fault === "lost") throw new TypeError("socket hang up");
    return reply(status, value);
  };

  private route(method: string, path: string, body: Record<string, unknown> | undefined): readonly [number, unknown] {
    const lost = [409, { error: "lease_lost" }] as const;
    if (method === "GET" && path === "invocations") {
      const offered = [...this.rows.values()].filter(row => row.state === "queued" || this.sticky.includes(row.invocation_id)).map(row => this.view(row));
      return [200, { invocations: this.duplicate ? [...offered, ...offered] : offered }];
    }
    if (method !== "POST") return [404, { error: "not_found" }];
    if (path === "claim") {
      const { invocation_id } = HostClaimSchema.parse(body);
      const row = this.rows.get(invocation_id)!;
      if (row.forbidden) return [403, { error: "forbidden" }];
      if (row.host_id === H && ["leased", "running"].includes(row.state)) return [200, this.view(row)];
      if (row.stop_requested || row.state !== "queued") return lost;
      Object.assign(row, { state: "leased", host_id: H, attempt: row.attempt + 1, fence_gen: nextControlRevision(row.fence_gen), lease_expires_at: "2026-10-07T12:00:30.000Z" });
      return [200, this.view(row)];
    }
    const binding = (b: { invocation_id: string; attempt: number; fence_gen: string }, allowStopped = false) => {
      const row = this.rows.get(b.invocation_id)!;
      const ok = row.attempt === b.attempt && row.fence_gen === b.fence_gen && row.host_id === H &&
        (allowStopped || (["leased", "running"].includes(row.state) && !row.stop_requested));
      return { row, ok };
    };
    if (path === "heartbeat" || path === "context") {
      const parsed = RunBindingSchema.safeParse(body);
      if (!parsed.success) return [400, { error: "invalid_request" }];
      const { row, ok } = binding(parsed.data);
      if (!ok) return lost;
      if (row.forbidden) return [403, { error: "forbidden" }];
      if (path === "heartbeat") return [200, this.view(row)];
      return [200, { invocation_id: row.invocation_id, source: row.source, text_bytes: Buffer.byteLength(row.source.text), messages: [] }];
    }
    if (path !== "events") return [404, { error: "not_found" }];
    const parsed = HostAppendSchema.safeParse(body);
    if (!parsed.success) return [400, { error: "invalid_request" }];
    const event = parsed.data;
    const row = this.rows.get(event.invocation_id)!;
    if (row.forbidden) return [403, { error: "forbidden" }];
    const digest = canonicalJson(event);
    if (event.kind === "final.commit" && row.state === "completed" && row.attempt === event.attempt && row.fence_gen === event.fence_gen) {
      return this.finals.get(row.invocation_id) === digest ? [200, this.view(row)] : [409, { error: "operation_conflict" }];
    }
    if (event.kind === "stop.observed" && row.state === "cancelled" && row.control_revision === event.control_revision) return [200, this.view(row)];
    if (!binding(event, event.kind === "stop.observed").ok) return lost;
    switch (event.kind) {
      case "stop.observed":
        if (!row.stop_requested || row.state !== "held" || row.control_revision !== event.control_revision) return [409, { error: "control_conflict" }];
        Object.assign(row, { state: "cancelled", stopped_observed: true });
        return [200, this.view(row)];
      case "checkpoint":
        Object.assign(row, { state: "running", replay_safe: false });
        return [200, this.view(row)];
      case "stream.delta": {
        const key = `${row.invocation_id}/${event.delta_id}`;
        const old = this.deltas.get(key);
        if (old !== undefined) return old === event.text ? [200, this.view(row)] : [409, { error: "operation_conflict" }];
        const bytes = Buffer.byteLength(event.text);
        if (row.streamedBytes + bytes > this.cap.bytes || row.deltaCount >= this.cap.count) return [429, { error: "rate_limited", retry_after: 1 }];
        this.deltas.set(key, event.text);
        row.streamedBytes += bytes;
        row.deltaCount++;
        return [200, this.view(row)];
      }
      case "final.commit":
        this.finals.set(row.invocation_id, digest);
        Object.assign(row, { state: "completed", result_message_id: `res_${row.invocation_id}`, lease_expires_at: null });
        return [200, this.view(row)];
      default:
        return [400, { error: "invalid_request" }];
    }
  }
}

function reply(status: number, value: unknown) {
  return { status, text: async () => JSON.stringify(value) };
}

interface Turn extends CloudTurn { onDelta(text: string): void; signal: AbortSignal; resolve(result: TurnResult): void; reject(error: unknown): void }

let svc: FakeService;
let turns: Turn[];
let stops: string[];
let logs: string[];
let host: CloudRoomHost | null;

const flush = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); };
const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
const lastTurn = () => turns[turns.length - 1]!;

function makeHost(over: Partial<CloudRoomHostDeps> = {}): CloudRoomHost {
  host = new CloudRoomHost({
    baseUrl: `${BASE}/`, workspaceId: W, hostId: H, credential: CREDENTIAL, bearer: BEARER, fetch: svc.fetch,
    runTurn: (turn, io) => new Promise<TurnResult>((resolve, reject) => { svc.log.push("turn"); turns.push({ ...turn, ...io, resolve, reject }); }),
    stopTurn: id => { stops.push(id); },
    canHost: bot => bot === "bot_1",
    random: () => 0.5,
    log: message => { logs.push(message); },
    ...over,
  });
  host.start();
  return host;
}

async function running(id = "inv_1", over: Parameters<FakeService["add"]>[1] = {}) {
  svc.add(id, over);
  if (host) await tick(5_000);
  else { makeHost(); await flush(); }
  return lastTurn();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  svc = new FakeService();
  turns = [];
  stops = [];
  logs = [];
  host = null;
});

afterEach(() => {
  host?.stop();
  vi.useRealTimers();
  // Every request authenticates in headers only; secrets never ride in a URL,
  // a body or a log line, and the server never saw a malformed event.
  for (const call of svc.calls) {
    expect(call.url.startsWith(PREFIX)).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${BEARER}`);
    expect(call.headers["X-Cloud-Host-Credential"]).toBe(CREDENTIAL);
    for (const secret of [CREDENTIAL, BEARER]) {
      expect(call.url).not.toContain(secret);
      expect(call.raw ?? "").not.toContain(secret);
    }
  }
  for (const line of logs) for (const secret of [CREDENTIAL, BEARER]) expect(line).not.toContain(secret);
  expect(svc.calls.some(call => call.path === "events" && !HostAppendSchema.safeParse(call.body).success)).toBe(false);
});

it("polls for offers while idle every ~5s, which is how it shows online", async () => {
  makeHost();
  await flush();
  expect(svc.calls.map(call => [call.method, call.url])).toEqual([["GET", `${PREFIX}invocations`]]);
  expect(host!.status()).toEqual({ online: true, running: [] });
  await tick(4_999);
  expect(svc.calls).toHaveLength(1);
  await tick(1);
  await tick(5_000);
  expect(svc.of("invocations")).toHaveLength(3);
  expect(svc.of("claim")).toHaveLength(0);
});

it("claims, reads context and records the checkpoint before the turn starts, streams, then commits exactly one final", async () => {
  const turn = await running("inv_1", { text: "@bot what is 2+2?" });
  expect(svc.log).toEqual(["invocations", "claim", "context", "checkpoint", "turn"]);
  expect(turn.prompt).toBe("@bot what is 2+2?");
  expect(turn.invocation).toMatchObject({ invocation_id: "inv_1", attempt: 1, fence_gen: "1", state: "leased" });
  expect(svc.of("context")[0]!.body).toEqual({ invocation_id: "inv_1", attempt: 1, fence_gen: "1" });
  expect(svc.of("events", "checkpoint")[0]!.body).toEqual({ kind: "checkpoint", invocation_id: "inv_1", attempt: 1, fence_gen: "1", replay_safe: false });
  turn.onDelta("he");
  turn.onDelta("llo");
  await tick(250);
  turn.onDelta(" world");
  await tick(250);
  expect(svc.of("events", "stream.delta").map(call => call.body)).toEqual([
    { kind: "stream.delta", invocation_id: "inv_1", attempt: 1, fence_gen: "1", delta_id: "inv_1-1-0", text: "hello" },
    { kind: "stream.delta", invocation_id: "inv_1", attempt: 1, fence_gen: "1", delta_id: "inv_1-1-1", text: " world" },
  ]);
  turn.onDelta("!");
  turn.resolve({ ok: true, text: "hello world!", model: "claude-sonnet-4-6" });
  await flush();
  expect(svc.of("events", "final.commit").map(call => call.body)).toEqual([
    { kind: "final.commit", invocation_id: "inv_1", attempt: 1, fence_gen: "1", text: "hello world!" },
  ]);
  expect(svc.rows.get("inv_1")!.state).toBe("completed");
  expect(host!.status().running).toEqual([]);
  const beats = svc.of("heartbeat").length;
  await tick(60_000);
  expect(svc.of("events", "final.commit")).toHaveLength(1);
  expect(svc.of("events", "stream.delta")).toHaveLength(2);
  expect(svc.of("heartbeat")).toHaveLength(beats);
  expect(svc.of("claim")).toHaveLength(1);
});

it("a failed checkpoint means the turn never starts", async () => {
  svc.fault("events:checkpoint", { status: 409, error: "lease_lost" });
  svc.add("inv_1");
  svc.add("inv_2");
  makeHost();
  await flush();
  // inv_1 lost its lease at checkpoint and never ran; inv_2 checkpointed and runs.
  expect(turns.map(turn => turn.invocation.invocation_id)).toEqual(["inv_2"]);
  svc.fault("events:checkpoint", { status: 403, error: "forbidden" });
  svc.add("inv_3");
  lastTurn().resolve({ ok: true, text: "ok", model: null });
  await tick(5_000);
  expect(svc.of("events", "checkpoint").map(call => call.body!.invocation_id)).toEqual(["inv_1", "inv_2", "inv_3"]);
  expect(turns.map(turn => turn.invocation.invocation_id)).toEqual(["inv_2"]);
  expect(svc.of("events", "final.commit").map(call => call.body!.invocation_id)).toEqual(["inv_2"]);
  expect(svc.of("events", "stream.delta")).toHaveLength(0);
  // A transient checkpoint failure is retried; the turn starts only once it lands.
  svc.fault("events:checkpoint", { status: 503, error: "unavailable" }, "transport");
  svc.add("inv_4");
  await tick(5_000);
  await tick(2_000);
  expect(svc.of("events", "checkpoint").filter(call => call.body!.invocation_id === "inv_4")).toHaveLength(3);
  expect(turns.map(turn => turn.invocation.invocation_id)).toEqual(["inv_2", "inv_4"]);
  expect(svc.log.filter(entry => entry === "checkpoint")).toHaveLength(2);
});

it("heartbeats every 10s and keeps a 60s turn alive", async () => {
  const turn = await running();
  for (let i = 0; i < 6; i++) await tick(10_000);
  expect(svc.of("heartbeat").map(call => call.body)).toEqual(Array(6).fill({ invocation_id: "inv_1", attempt: 1, fence_gen: "1" }));
  expect(turn.signal.aborted).toBe(false);
  turn.resolve({ ok: true, text: "done", model: "claude-sonnet-4-6" });
  await flush();
  expect(svc.of("events", "final.commit")).toHaveLength(1);
  await tick(30_000);
  expect(svc.of("heartbeat")).toHaveLength(6);
});

it("a lapsed lease (no successful heartbeat for 30s) aborts locally and publishes nothing", async () => {
  const turn = await running();
  svc.fault("heartbeat", "transport", "transport", "transport");
  await tick(30_000);
  expect(turn.signal.aborted).toBe(true);
  expect(stops).toEqual(["inv_1"]);
  turn.resolve({ ok: true, text: "late", model: null });
  await flush();
  expect(svc.of("events", "final.commit")).toHaveLength(0);
});

it("lease_lost on heartbeat (human stop) aborts, sends no final, and observes the stop at control_revision+1 only after the turn settles", async () => {
  const turn = await running("inv_1", { control_revision: "7" });
  turn.onDelta("partial");
  await tick(250);
  svc.stop("inv_1");
  await tick(10_000);
  expect(turn.signal.aborted).toBe(true);
  expect(stops).toEqual(["inv_1"]);
  expect(svc.of("events", "stop.observed")).toHaveLength(0);
  turn.onDelta(" more");
  await tick(1_000);
  expect(svc.of("events", "stop.observed")).toHaveLength(0);
  turn.resolve({ ok: true, text: "partial more", model: null });
  await flush();
  expect(svc.of("events", "stop.observed").map(call => call.body)).toEqual([
    { kind: "stop.observed", invocation_id: "inv_1", attempt: 1, fence_gen: "1", control_revision: "8" },
  ]);
  expect(svc.rows.get("inv_1")).toMatchObject({ state: "cancelled", stopped_observed: true });
  expect(svc.of("events", "final.commit")).toHaveLength(0);
  expect(svc.of("events", "stream.delta")).toHaveLength(1);
  await tick(30_000);
  expect(svc.of("heartbeat")).toHaveLength(1);
  expect(host!.status().running).toEqual([]);
});

it("lease_lost from a fence (not a stop) gives up silently after one refused stop.observed", async () => {
  const turn = await running("inv_1", { control_revision: "3" });
  const row = svc.rows.get("inv_1")!;
  Object.assign(row, { state: "held", fence_gen: nextControlRevision(row.fence_gen), control_revision: "4" });
  await tick(10_000);
  turn.resolve({ ok: true, text: "x", model: null });
  await tick(10_000);
  expect(svc.of("events", "stop.observed")).toHaveLength(1);
  expect(svc.of("events", "final.commit")).toHaveLength(0);
  expect(host!.status().running).toEqual([]);
});

it("forbidden on heartbeat aborts with no final and no stop.observed", async () => {
  const turn = await running();
  svc.rows.get("inv_1")!.forbidden = true;
  await tick(10_000);
  expect(turn.signal.aborted).toBe(true);
  expect(stops).toEqual(["inv_1"]);
  turn.resolve({ ok: true, text: "x", model: null });
  await tick(30_000);
  expect(svc.of("events", "final.commit")).toHaveLength(0);
  expect(svc.of("events", "stop.observed")).toHaveLength(0);
});

it("retries a lost final with the identical body, and a lost delta with the same delta_id", async () => {
  const turn = await running();
  svc.fault("events:stream.delta", "lost");
  turn.onDelta("hi");
  await tick(250);
  await tick(1_000);
  const deltas = svc.of("events", "stream.delta");
  expect(deltas).toHaveLength(2);
  expect(deltas[0]!.raw).toBe(deltas[1]!.raw);
  expect(deltas[1]!.body!.delta_id).toBe("inv_1-1-0");
  expect(svc.deltas.size).toBe(1);
  turn.onDelta(" there");
  await tick(250);
  expect(svc.of("events", "stream.delta").at(-1)!.body!.delta_id).toBe("inv_1-1-1");

  svc.fault("events:final.commit", "lost", { status: 503, error: "unavailable" }, "transport");
  turn.resolve({ ok: true, text: "hi there", model: null });
  await flush();
  for (let i = 0; i < 6; i++) await tick(5_000);
  const finals = svc.of("events", "final.commit");
  expect(finals).toHaveLength(4);
  expect(new Set(finals.map(call => call.raw)).size).toBe(1);
  expect(svc.log.filter(entry => entry === "final.commit")).toHaveLength(2);
  expect(svc.rows.get("inv_1")!.state).toBe("completed");
  expect(host!.status().running).toEqual([]);
});

it("backs off with jitter on 429 and transport errors, honouring retry_after", async () => {
  svc.fault("invocations", { status: 429, error: "rate_limited", retry_after: 2 }, "transport", { status: 503 });
  makeHost();
  await flush();
  expect(host!.status().online).toBe(false);
  await tick(1_999);
  expect(svc.of("invocations")).toHaveLength(1);
  await tick(1);
  expect(svc.of("invocations")).toHaveLength(2);
  await tick(backoffDelay(1, () => 0.5));
  expect(svc.of("invocations")).toHaveLength(3);
  await tick(backoffDelay(2, () => 0.5));
  expect(svc.of("invocations")).toHaveLength(4);
  expect(host!.status().online).toBe(true);
  expect(logs.filter(line => line.includes("polling failed"))).toHaveLength(3);
  // equal jitter stays within [ceiling/2, ceiling] and caps at 30s
  expect(backoffDelay(0, () => 0)).toBe(250);
  expect(backoffDelay(0, () => 0.999)).toBeLessThan(500);
  for (let n = 0; n < 100; n++) expect(backoffDelay(n, () => 0.999999)).toBeLessThanOrEqual(30_000);
  expect(backoffDelay(100, () => 0)).toBe(15_000);
});

it("coalesces deltas and stops streaming at the budget, but still commits the final", async () => {
  const turn = await running();
  for (let i = 0; i < 50; i++) turn.onDelta("x");
  await tick(250);
  expect(svc.of("events", "stream.delta").map(call => call.body!.text)).toEqual(["x".repeat(50)]);
  const chunk = "y".repeat(60_000);
  for (let i = 0; i < 20; i++) { turn.onDelta(chunk); await tick(250); }
  const sent = svc.of("events", "stream.delta");
  const bytes = sent.reduce((sum, call) => sum + Buffer.byteLength(String(call.body!.text)), 0);
  expect(bytes).toBeLessThanOrEqual(DELTA_BUDGET.bytes);
  expect(sent).toHaveLength(1 + Math.floor((DELTA_BUDGET.bytes - 50) / 60_000));
  turn.resolve({ ok: true, text: "final", model: null });
  await flush();
  expect(svc.of("events", "final.commit").map(call => call.body!.text)).toEqual(["final"]);
});

it("a server-side stream cap (429) ends streaming immediately without retrying", async () => {
  svc.cap.count = 2;
  const turn = await running();
  for (let i = 0; i < 5; i++) { turn.onDelta(`d${i}`); await tick(250); }
  expect(svc.of("events", "stream.delta")).toHaveLength(3);
  turn.resolve({ ok: true, text: "done", model: null });
  await flush();
  expect(svc.of("events", "final.commit")).toHaveLength(1);
});

it("truncates a final over 64KiB at a UTF-8 boundary with a marker; an empty reply commits a placeholder", async () => {
  for (const unit of ["é", "😀", "a"]) {
    const text = unit.repeat(70_000);
    const out = finalText(text);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(65_536);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out).not.toContain("�");
    expect(text.startsWith(out.slice(0, -TRUNCATION_MARKER.length))).toBe(true);
    expect(utf8Chunks(text, 65_536).join("")).toBe(text);
  }
  expect(finalText("short")).toBe("short");
  expect(finalText("  \n")).toBe(EMPTY_FINAL_TEXT);
  const turn = await running();
  turn.resolve({ ok: true, text: "€".repeat(30_000), model: null });
  await flush();
  const sent = String(svc.of("events", "final.commit")[0]!.body!.text);
  expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(65_536);
  expect(svc.rows.get("inv_1")!.state).toBe("completed");
  const empty = await running("inv_2");
  expect(empty.invocation.invocation_id).toBe("inv_2");
  empty.resolve({ ok: true, text: "", model: null });
  await flush();
  expect(svc.of("events", "final.commit").at(-1)!.body).toMatchObject({ invocation_id: "inv_2", text: EMPTY_FINAL_TEXT });
});

it("preserves decimal fence_gen and control_revision beyond 2^53 exactly", async () => {
  const turn = await running("inv_big", { fence_gen: "9007199254740992", control_revision: "9007199254740993" });
  expect(turn.invocation.fence_gen).toBe("9007199254740993");
  turn.onDelta("a");
  await tick(250);
  svc.stop("inv_big");
  await tick(10_000);
  turn.resolve({ ok: false, failure: "stopped", model: null });
  await flush();
  const bound = svc.calls.filter(call => call.body && "fence_gen" in call.body);
  expect(bound.length).toBeGreaterThanOrEqual(5);
  for (const call of bound) expect(call.raw).toContain('"fence_gen":"9007199254740993"');
  expect(svc.of("events", "stop.observed")[0]!.body!.control_revision).toBe("9007199254740994");
  expect(svc.rows.get("inv_big")!.state).toBe("cancelled");
  expect(nextControlRevision("18446744073709551615")).toBe("18446744073709551616");
});

it("claims an invocation offered twice (or re-offered while running) only once", async () => {
  svc.duplicate = true;
  svc.sticky = ["inv_1"];
  const turn = await running();
  await tick(5_000);
  await tick(5_000);
  expect(svc.of("invocations").length).toBeGreaterThanOrEqual(3);
  expect(svc.of("claim")).toHaveLength(1);
  expect(turns).toHaveLength(1);
  turn.resolve({ ok: true, text: "ok", model: null });
  await flush();
  expect(svc.of("events", "final.commit")).toHaveLength(1);
});

it("runs at most two invocations at once and ignores bots it cannot host", async () => {
  svc.add("inv_a");
  svc.add("inv_b");
  svc.add("inv_c");
  svc.add("inv_other", { bot_id: "bot_elsewhere" });
  makeHost();
  await flush();
  expect(turns.map(turn => turn.invocation.invocation_id)).toEqual(["inv_a", "inv_b"]);
  turns[0]!.resolve({ ok: true, text: "a", model: null });
  await tick(5_000);
  expect(turns.map(turn => turn.invocation.invocation_id)).toEqual(["inv_a", "inv_b", "inv_c"]);
  expect(svc.of("claim").map(call => call.body!.invocation_id)).toEqual(["inv_a", "inv_b", "inv_c"]);
});

it("a failed native turn publishes nothing and stops heartbeating", async () => {
  const turn = await running();
  await tick(10_000);
  turn.reject(new Error("provider quota exhausted"));
  await flush();
  await tick(60_000);
  expect(svc.of("heartbeat")).toHaveLength(1);
  expect(svc.of("events", "final.commit")).toHaveLength(0);
  expect(svc.of("events", "stop.observed")).toHaveLength(0);
  expect(logs.some(line => line.includes("provider quota exhausted"))).toBe(true);
});

it("stop() aborts running turns and makes no further requests", async () => {
  const turn = await running();
  host!.stop();
  expect(turn.signal.aborted).toBe(true);
  await flush();
  expect(stops).toEqual(["inv_1"]);
  const count = svc.calls.length;
  turn.resolve({ ok: true, text: "late", model: null });
  await tick(60_000);
  expect(svc.calls).toHaveLength(count);
  expect(host!.status()).toEqual({ online: false, running: [] });
});

it("delta ids are IdSchema-safe even for long invocation ids", () => {
  expect(deltaId("inv_1", 2, 3)).toBe("inv_1-2-3");
  const long = deltaId("x".repeat(128), 1, 999);
  expect(long.length).toBeLessThanOrEqual(128);
  expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(deltaId("x".repeat(128), 1, 999)).toBe(long);
});

it("starts from env only in a dev build with every setting present and a safe url", () => {
  const env = {
    OMB_CLOUD_HOST_URL: "http://127.0.0.1:8787", OMB_CLOUD_HOST_WORKSPACE: W, OMB_CLOUD_HOST_ID: H,
    OMB_CLOUD_HOST_CREDENTIAL: CREDENTIAL, OMB_CLOUD_HOST_BEARER: BEARER,
  };
  const deps = { log: (message: string) => { logs.push(message); } } as unknown as Parameters<typeof startCloudHostFromEnv>[1];
  for (const missing of Object.keys(env)) expect(startCloudHostFromEnv({ ...env, [missing]: "" }, deps, svc.fetch)).toBeNull();
  expect(startCloudHostFromEnv({ ...env, OMB_RESOURCES_PATH: "/Applications/x" }, deps, svc.fetch)).toBeNull();
  expect(startCloudHostFromEnv({ ...env, OMB_CLOUD_HOST_URL: "http://rooms.example.test" }, deps, svc.fetch)).toBeNull();
  expect(startCloudHostFromEnv({ ...env, OMB_CLOUD_HOST_BOTS: "[1]" }, deps, svc.fetch)).toBeNull();
  expect(svc.calls).toHaveLength(0);
  expect(cloudHostBaseUrl("https://rooms.example.test/api/")).toBe("https://rooms.example.test/api");
  expect(cloudHostBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
  expect(cloudHostBaseUrl("https://user:pw@rooms.example.test")).toBeNull();
  expect(cloudHostBaseUrl("https://rooms.example.test/?token=x")).toBeNull();
  expect(cloudHostBaseUrl("ws://127.0.0.1:8787")).toBeNull();
});
