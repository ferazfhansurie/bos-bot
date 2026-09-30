import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeltaCoalescer, LiveDeltaReplay, replayAfter, type ReplayEntry } from "./delta-coalesce.ts";

const delta = (threadId: string, text: string, extra: Record<string, unknown> = {}) => ({
  kind: "runtime",
  event: { eventId: `${threadId}-${text}`, threadId, turnId: "t1", type: "content.delta", streamKind: "assistant_text", delta: text, ...extra },
});
const entry = (seq: number): ReplayEntry => ({ seq, kind: "runtime", frame: `f${seq}`, clientFrame: `f${seq}` });

describe("DeltaCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges one stream's deltas into a single frame per window", () => {
    const out: Record<string, unknown>[] = [];
    const coalescer = new DeltaCoalescer(frame => out.push(frame), 50);
    expect(coalescer.offer(delta("a", "Hel", { raw: { source: "x", payload: 1 } }))).toBe(true);
    coalescer.offer(delta("a", "lo"));
    expect(out).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(out).toHaveLength(1);
    const event = out[0].event as Record<string, unknown>;
    expect(event.delta).toBe("Hello");
    expect(event.eventId).toBe("a-Hel");
    // a provider chunk's raw payload does not describe the merge
    expect(event.raw).toBeUndefined();
  });

  it("keeps threads and stream kinds apart, in first-arrival order", () => {
    const out: Record<string, unknown>[] = [];
    const coalescer = new DeltaCoalescer(frame => out.push(frame), 50);
    coalescer.offer(delta("b", "1"));
    coalescer.offer(delta("a", "x"));
    coalescer.offer(delta("b", "hm", { streamKind: "reasoning_text" }));
    coalescer.offer(delta("b", "2"));
    coalescer.flush();
    expect(out.map(frame => (frame.event as Record<string, unknown>).delta)).toEqual(["12", "x", "hm"]);
  });

  it("ignores everything that is not a delta", () => {
    const coalescer = new DeltaCoalescer(() => {}, 50);
    expect(coalescer.offer({ kind: "runtime", event: { type: "turn.completed", threadId: "a" } })).toBe(false);
    expect(coalescer.offer({ kind: "message", threadId: "a", message: {} })).toBe(false);
  });
});

describe("LiveDeltaReplay", () => {
  it("replays a live reply's deltas interleaved with durable frames by seq", () => {
    const live = new LiveDeltaReplay();
    live.add("a", entry(2));
    live.add("a", entry(4));
    expect(replayAfter([entry(1), entry(3), entry(5)], live, 1).map(e => e.seq)).toEqual([2, 3, 4, 5]);
  });

  it("drops a thread's deltas once its reply settles", () => {
    const live = new LiveDeltaReplay();
    live.add("a", entry(1));
    live.add("b", entry(2));
    live.settle({ kind: "runtime", event: { type: "turn.completed", threadId: "a" } });
    expect(live.after(0).map(e => e.seq)).toEqual([2]);
    live.settle({ kind: "message", threadId: "b", message: { role: "bot", kind: "text" } });
    expect(live.after(0)).toEqual([]);
  });

  it("keeps deltas when a frame does not settle the reply", () => {
    const live = new LiveDeltaReplay();
    live.add("a", entry(1));
    live.settle({ kind: "message", threadId: "a", message: { role: "user", kind: "text" } });
    live.settle({ kind: "runtime", event: { type: "item.started", threadId: "a" } });
    expect(live.after(0)).toHaveLength(1);
  });

  it("stops covering a cursor older than chunks it had to drop", () => {
    const live = new LiveDeltaReplay(2);
    live.add("a", entry(1));
    live.add("a", entry(2));
    live.add("a", entry(3));
    expect(live.covers(0)).toBe(false);
    expect(live.covers(1)).toBe(true);
  });
});
