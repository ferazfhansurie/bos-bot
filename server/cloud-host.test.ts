import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudRoomHost, finalResultId, hostRealtimeUrl, reconnectDelay, type HostSocket, type TurnResult } from "./cloud-host.ts";
import { LEASE, type HostOutbound, type Invocation } from "../shared/cloud-run-draft.ts";

class FakeSocket implements HostSocket {
  static all: FakeSocket[] = [];
  sent: HostOutbound[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string) { if (this.closed) throw new Error("closed"); this.sent.push(JSON.parse(data) as HostOutbound); }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  ready() { this.deliver({ type: "host.ready", host_id: "host_1" }); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop() { this.closed = true; this.onclose?.({}); }
  of<T extends HostOutbound["type"]>(type: T) { return this.sent.filter((frame): frame is Extract<HostOutbound, { type: T }> => frame.type === type); }
}

function invocation(id = "inv_1", bot = "bot_1"): Invocation {
  return {
    invocation_id: id, workspace_id: "ws_1", room_id: "room_1", thread_id: "thr_1", bot_id: bot,
    source: { message_id: "msg_1", version: 1, actor_id: "hum_1", actor_name: "Ana", text: "@bot hello", mentions: [{ kind: "bot", id: bot, start: 0, end: 4 }], sequence: "7" },
  };
}

interface Turn { invocation: Invocation; onDelta(text: string): void; signal: AbortSignal; resolve(result: TurnResult): void; reject(error: unknown): void }

let turns: Turn[];
let stops: string[];
let host: CloudRoomHost;
const lease = (ms = LEASE.ttlMs) => new Date(Date.now() + ms).toISOString();
const sockets = () => FakeSocket.all;
const current = () => FakeSocket.all[FakeSocket.all.length - 1]!;
const settle = () => vi.advanceTimersByTimeAsync(0);

function makeHost(overrides: Partial<ConstructorParameters<typeof CloudRoomHost>[0]> = {}) {
  host = new CloudRoomHost({
    url: "https://rooms.example.test/",
    hostToken: "secret-host-token",
    Socket: FakeSocket,
    runTurn: (inv, io) => new Promise<TurnResult>((resolve, reject) => { turns.push({ invocation: inv, ...io, resolve, reject }); }),
    stopTurn: id => { stops.push(id); },
    canHost: bot => bot === "bot_1",
    random: () => 0.5,
    ...overrides,
  });
  host.start();
  return host;
}

async function connected() {
  const socket = current();
  socket.open();
  socket.ready();
  await settle();
  return socket;
}

async function claimedTurn(id = "inv_1", attempt = 1, fenceGen = 4) {
  const socket = current();
  socket.deliver({ type: "invocation.offered", invocation: invocation(id), attempt });
  socket.deliver({ type: "invocation.claimed", invocation_id: id, attempt, fence_gen: fenceGen, lease_expires_at: lease() });
  await settle();
  return turns[turns.length - 1]!;
}

async function reconnect() {
  current().drop();
  await vi.advanceTimersByTimeAsync(LEASE.ttlMs / 10);
  return connected();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  FakeSocket.all = [];
  turns = [];
  stops = [];
});
afterEach(() => { host?.stop(); vi.useRealTimers(); });

it("authenticates in the first frame, never in the URL", async () => {
  makeHost();
  const socket = await connected();
  expect(socket.url).toBe("wss://rooms.example.test/v2/hosts/realtime");
  expect(socket.url).not.toContain("secret");
  expect(socket.sent[0]).toEqual({ type: "host.authenticate", host_token: "secret-host-token" });
  expect(hostRealtimeUrl("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/v2/hosts/realtime");
  expect(host.status()).toEqual({ connected: true, running: [] });
});

it("claims before running and never runs without a claimed frame", async () => {
  makeHost();
  const socket = await connected();
  socket.deliver({ type: "invocation.offered", invocation: invocation(), attempt: 1 });
  socket.deliver({ type: "invocation.offered", invocation: invocation(), attempt: 1 });
  socket.deliver({ type: "invocation.offered", invocation: invocation("inv_other", "bot_elsewhere"), attempt: 1 });
  await settle();
  expect(socket.of("invocation.claim")).toEqual([{ type: "invocation.claim", invocation_id: "inv_1", attempt: 1 }]);
  expect(turns).toHaveLength(0);
  // A claimed frame for something never claimed, or for another attempt, starts nothing.
  socket.deliver({ type: "invocation.claimed", invocation_id: "inv_other", attempt: 1, fence_gen: 1, lease_expires_at: lease() });
  socket.deliver({ type: "invocation.claimed", invocation_id: "inv_1", attempt: 2, fence_gen: 1, lease_expires_at: lease() });
  await settle();
  expect(turns).toHaveLength(0);
  socket.deliver({ type: "invocation.claimed", invocation_id: "inv_1", attempt: 1, fence_gen: 3, lease_expires_at: lease() });
  await settle();
  expect(turns).toHaveLength(1);
  expect(turns[0]!.invocation.source.text).toBe("@bot hello");
  expect(host.status().running).toEqual(["inv_1"]);
});

it("drops an unanswered claim on disconnect instead of running it later", async () => {
  makeHost();
  const socket = await connected();
  socket.deliver({ type: "invocation.offered", invocation: invocation(), attempt: 1 });
  socket.drop();
  socket.deliver({ type: "invocation.claimed", invocation_id: "inv_1", attempt: 1, fence_gen: 1, lease_expires_at: lease() });
  await vi.advanceTimersByTimeAsync(5_000);
  await connected();
  current().deliver({ type: "invocation.claimed", invocation_id: "inv_1", attempt: 1, fence_gen: 1, lease_expires_at: lease() });
  await settle();
  expect(turns).toHaveLength(0);
});

it("streams coalesced deltas with monotonic seq, attempt and fence_gen, then commits one final", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 2, 9);
  turn.onDelta("he");
  turn.onDelta("llo");
  await vi.advanceTimersByTimeAsync(60);
  turn.onDelta(" world");
  await vi.advanceTimersByTimeAsync(60);
  expect(socket.of("stream.delta")).toEqual([
    { type: "stream.delta", invocation_id: "inv_1", attempt: 2, fence_gen: 9, seq: 0, text: "hello" },
    { type: "stream.delta", invocation_id: "inv_1", attempt: 2, fence_gen: 9, seq: 1, text: " world" },
  ]);
  turn.resolve({ ok: true, text: "hello world", model: "claude-sonnet-4-6" });
  await settle();
  expect(socket.of("final.commit")).toEqual([{ type: "final.commit", invocation_id: "inv_1", attempt: 2, fence_gen: 9, result_id: "inv_1-final", text: "hello world", model: "claude-sonnet-4-6" }]);
  expect(host.status().running).toEqual([]);
});

it("heartbeats every LEASE.heartbeatMs while running and keeps the lease alive", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 1, 2);
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(LEASE.heartbeatMs);
    socket.deliver({ type: "invocation.lease", invocation_id: "inv_1", attempt: 1, fence_gen: 2, lease_expires_at: lease() });
  }
  expect(socket.of("invocation.heartbeat").length).toBe(6);
  expect(socket.of("invocation.heartbeat")[0]).toEqual({ type: "invocation.heartbeat", invocation_id: "inv_1", attempt: 1, fence_gen: 2 });
  expect(turn.signal.aborted).toBe(false);
  turn.resolve({ ok: true, text: "done", model: "m" });
  await settle();
  expect(socket.of("final.commit")).toHaveLength(1);
});

it("fenced mid-stream aborts the turn and never commits a final", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 1, 5);
  turn.onDelta("partial");
  await vi.advanceTimersByTimeAsync(60);
  socket.deliver({ type: "invocation.fenced", invocation_id: "inv_1", attempt: 1, fence_gen: 5 });
  await settle();
  expect(turn.signal.aborted).toBe(true);
  expect(stops).toEqual(["inv_1"]);
  turn.onDelta("more");
  turn.resolve({ ok: true, text: "partial more", model: "m" });
  await vi.advanceTimersByTimeAsync(LEASE.heartbeatMs * 2);
  expect(socket.of("stream.delta")).toHaveLength(1);
  expect(socket.of("final.commit")).toHaveLength(0);
  expect(socket.of("invocation.heartbeat")).toHaveLength(0);
  // A late claimed for the fenced generation never restarts it.
  socket.deliver({ type: "invocation.offered", invocation: invocation(), attempt: 1 });
  socket.deliver({ type: "invocation.claimed", invocation_id: "inv_1", attempt: 1, fence_gen: 5, lease_expires_at: lease() });
  await settle();
  expect(turns).toHaveLength(1);
});

it("lease expiry while disconnected aborts locally and publishes nothing after reconnect", async () => {
  makeHost({ random: () => 0.999 });
  await connected();
  const turn = await claimedTurn("inv_1", 1, 7);
  current().drop();
  // The reconnect keeps failing: nothing renews the lease.
  for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(LEASE.ttlMs / 4); if (!current().closed) current().drop(); }
  await vi.advanceTimersByTimeAsync(LEASE.ttlMs);
  expect(turn.signal.aborted).toBe(true);
  expect(stops).toEqual(["inv_1"]);
  expect(host.status().running).toEqual([]);
  turn.onDelta("late");
  turn.resolve({ ok: true, text: "late final", model: "m" });
  await settle();
  await vi.advanceTimersByTimeAsync(31_000);
  const socket = await connected();
  await vi.advanceTimersByTimeAsync(LEASE.heartbeatMs * 2);
  expect(socket.of("final.commit")).toHaveLength(0);
  expect(socket.of("stream.delta")).toHaveLength(0);
  expect(socket.of("invocation.heartbeat")).toHaveLength(0);
});

it("never publishes a final for a stale generation, whichever side of completion the fence lands (x100)", async () => {
  for (let round = 0; round < 100; round++) {
    FakeSocket.all = [];
    turns = [];
    stops = [];
    makeHost();
    await connected();
    const fenceFirst = round % 2 === 0;
    const turn = await claimedTurn(`inv_${round}`, 1, round + 1);
    if (fenceFirst) {
      current().deliver({ type: "invocation.fenced", invocation_id: `inv_${round}`, attempt: 1, fence_gen: round + 1 });
      turn.resolve({ ok: true, text: "stale", model: "m" });
      await settle();
    } else {
      // Completes while the socket is down; the fence arrives on reconnect before ready.
      current().drop();
      turn.resolve({ ok: true, text: "stale", model: "m" });
      await vi.advanceTimersByTimeAsync(3_000);
      const socket = current();
      socket.open();
      socket.deliver({ type: "invocation.fenced", invocation_id: `inv_${round}`, attempt: 1, fence_gen: round + 1 });
      socket.ready();
      await settle();
    }
    await reconnect();
    for (const socket of sockets()) expect(socket.of("final.commit")).toHaveLength(0);
    host.stop();
  }
});

it("a fence for an older generation does not stop the current attempt", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 2, 8);
  socket.deliver({ type: "invocation.fenced", invocation_id: "inv_1", attempt: 1, fence_gen: 7 });
  await settle();
  expect(turn.signal.aborted).toBe(false);
  turn.resolve({ ok: true, text: "ok", model: "m" });
  await settle();
  expect(socket.of("final.commit")).toHaveLength(1);
});

it("a final sent before the fence is dropped, not resent on reconnect", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 1, 3);
  turn.resolve({ ok: true, text: "ok", model: "m" });
  await settle();
  socket.deliver({ type: "invocation.fenced", invocation_id: "inv_1", attempt: 1, fence_gen: 3 });
  const next = await reconnect();
  expect(socket.of("final.commit")).toHaveLength(1);
  expect(next.of("final.commit")).toHaveLength(0);
});

it("resends the pending final once per reconnect with the same result_id until committed", async () => {
  makeHost();
  const first = await connected();
  const turn = await claimedTurn("inv_1", 1, 4);
  turn.resolve({ ok: true, text: "answer", model: "gpt-5" });
  await settle();
  const sent = first.of("final.commit");
  expect(sent).toHaveLength(1);
  const second = await reconnect();
  await vi.advanceTimersByTimeAsync(LEASE.heartbeatMs * 3);
  expect(second.of("final.commit")).toEqual(sent);
  expect(second.of("final.commit")[0]!.result_id).toBe(finalResultId("inv_1"));
  second.deliver({ type: "final.committed", invocation_id: "inv_1", attempt: 1, fence_gen: 4, result_id: "inv_1-final", message_id: "msg_9" });
  const third = await reconnect();
  expect(third.of("final.commit")).toHaveLength(0);
});

it("a final produced while disconnected is sent on reconnect while the lease holds", async () => {
  makeHost();
  await connected();
  const turn = await claimedTurn("inv_1", 1, 4);
  current().drop();
  turn.resolve({ ok: true, text: "answer", model: "m" });
  await vi.advanceTimersByTimeAsync(3_000);
  const socket = await connected();
  expect(socket.of("final.commit")).toHaveLength(1);
});

it("stop before final: stop.observed only after the turn settles, and no final", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 1, 6);
  socket.deliver({ type: "stop.requested", invocation_id: "inv_1", control_revision: 12 });
  await settle();
  expect(stops).toEqual(["inv_1"]);
  expect(turn.signal.aborted).toBe(true);
  expect(socket.of("stop.observed")).toHaveLength(0);
  turn.resolve({ ok: true, text: "finished anyway", model: "m" });
  await settle();
  expect(socket.of("stop.observed")).toEqual([{ type: "stop.observed", invocation_id: "inv_1", attempt: 1, fence_gen: 6, control_revision: 12 }]);
  expect(socket.of("final.commit")).toHaveLength(0);
  expect(host.status().running).toEqual([]);
});

it("stop after final: the final stays and the stop is observed", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 1, 6);
  turn.resolve({ ok: true, text: "done", model: "m" });
  await settle();
  socket.deliver({ type: "stop.requested", invocation_id: "inv_1", control_revision: 3 });
  await settle();
  expect(stops).toEqual([]);
  expect(socket.of("final.commit")).toHaveLength(1);
  expect(socket.of("stop.observed")).toEqual([{ type: "stop.observed", invocation_id: "inv_1", attempt: 1, fence_gen: 6, control_revision: 3 }]);
  const next = await reconnect();
  expect(next.of("final.commit")).toHaveLength(1);
});

it("provider failure sends invocation.failed with the model the attempt used", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn("inv_1", 3, 11);
  turn.resolve({ ok: false, failure: "provider quota exhausted", model: "claude-opus-4-1" });
  await settle();
  expect(socket.of("invocation.failed")).toEqual([{ type: "invocation.failed", invocation_id: "inv_1", attempt: 3, fence_gen: 11, failure: "provider quota exhausted", model: "claude-opus-4-1" }]);
  expect(socket.of("final.commit")).toHaveLength(0);
  const second = await claimedTurn("inv_2", 1, 1);
  second.reject(new Error("could not start"));
  await settle();
  expect(socket.of("invocation.failed")[1]).toMatchObject({ invocation_id: "inv_2", failure: "could not start", model: null });
});

it("reconnect backoff uses full jitter capped at 30s", async () => {
  expect(reconnectDelay(0, () => 0.999)).toBeLessThan(500);
  for (let n = 0; n < 200; n++) expect(reconnectDelay(n, () => 0.999999)).toBeLessThanOrEqual(30_000);
  expect(reconnectDelay(100, () => 0.999999)).toBeGreaterThan(29_000);
  expect(reconnectDelay(100, () => 0)).toBe(0);
  makeHost({ random: () => 0.999999 });
  for (let i = 0; i < 20; i++) {
    const before = sockets().length;
    current().drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets().length).toBe(before + 1);
  }
  // at the cap the delay is just under 30s, not immediate
  const before = sockets().length;
  current().drop();
  await vi.advanceTimersByTimeAsync(29_000);
  expect(sockets().length).toBe(before);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets().length).toBe(before + 1);
  await connected();
  // ready resets the backoff
  current().drop();
  await vi.advanceTimersByTimeAsync(500);
  expect(sockets().length).toBe(before + 2);
});

it("stop() closes the socket, aborts running turns and does not reconnect", async () => {
  makeHost();
  const socket = await connected();
  const turn = await claimedTurn();
  host.stop();
  expect(socket.closed).toBe(true);
  expect(turn.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sockets()).toHaveLength(1);
  expect(host.status()).toEqual({ connected: false, running: [] });
});
