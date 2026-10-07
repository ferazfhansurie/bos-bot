import { describe, expect, it } from "vitest";
import type { CloudCard, CloudRun, StreamDeltaFrame } from "../../shared/cloud-run-draft";
import { applyCard, applyDelta, applyFinal, applyHostStatus, applyRun, decidable, EMPTY_RUNS, runLabel, runsFromSnapshot, visibleRuns } from "./runs";

const run = (patch: Partial<CloudRun> = {}): CloudRun => ({
  invocation_id: "inv1",
  room_id: "r1",
  thread_id: "t1",
  bot_id: "bot1",
  source_message_id: "m1",
  state: "running",
  attempt: 1,
  revision: 1,
  host_online: true,
  ...patch,
});
const delta = (patch: Partial<StreamDeltaFrame> = {}): StreamDeltaFrame => ({
  type: "stream.delta",
  workspace_id: "w1",
  room_id: "r1",
  thread_id: "t1",
  invocation_id: "inv1",
  attempt: 1,
  fence_gen: 1,
  seq: 0,
  text: "a",
  ...patch,
});
const card = (patch: Partial<CloudCard> = {}): CloudCard => ({
  card_id: "c1",
  invocation_id: "inv1",
  room_id: "r1",
  thread_id: "t1",
  bot_id: "bot1",
  version: 1,
  state: "pending",
  title: "send the report",
  summary: "to the fictional list",
  digest: "d1",
  expires_at: "2099-01-01T00:00:00.000Z",
  can_decide: true,
  ...patch,
});

describe("provisional streams", () => {
  it("applies deltas in order and ignores duplicates", () => {
    let p = applyRun(EMPTY_RUNS, run(), "t1");
    p = applyDelta(p, delta({ seq: 0, text: "hel" }), "t1");
    p = applyDelta(p, delta({ seq: 1, text: "lo" }), "t1");
    p = applyDelta(p, delta({ seq: 1, text: "lo" }), "t1");
    expect(p.streams.inv1).toMatchObject({ text: "hello", seq: 1, gap: false });
  });

  it("stops growing at a gap instead of showing text with a hole", () => {
    let p = applyDelta(EMPTY_RUNS, delta({ seq: 0, text: "a" }), "t1");
    p = applyDelta(p, delta({ seq: 2, text: "c" }), "t1");
    p = applyDelta(p, delta({ seq: 3, text: "d" }), "t1");
    expect(p.streams.inv1).toMatchObject({ text: "a", gap: true });
  });

  it("never lets a stale fence generation or older attempt touch newer text, in either order", () => {
    for (let i = 0; i < 100; i++) {
      const stale = delta({ fence_gen: 1, seq: 1, text: "STALE" });
      const fresh = [delta({ fence_gen: 2, seq: 0, text: "new" }), delta({ fence_gen: 2, seq: 1, text: "er" })];
      const order = i % 2 === 0 ? [delta({ fence_gen: 1, seq: 0, text: "old" }), stale, ...fresh] : [...fresh, delta({ fence_gen: 1, seq: 0, text: "old" }), stale];
      let p = applyRun(EMPTY_RUNS, run(), "t1");
      for (const frame of order) p = applyDelta(p, frame, "t1");
      expect(p.streams.inv1.text).toBe("newer");
    }
    let p = applyRun(EMPTY_RUNS, run({ attempt: 2, revision: 2 }), "t1");
    p = applyDelta(p, delta({ attempt: 1, fence_gen: 9, text: "old attempt" }), "t1");
    expect(p.streams.inv1).toBeUndefined();
  });

  it("drops provisional text when the final commits and ignores late deltas", () => {
    let p = applyDelta(applyRun(EMPTY_RUNS, run(), "t1"), delta(), "t1");
    p = applyFinal(p, "inv1");
    p = applyDelta(p, delta({ seq: 1, text: "late" }), "t1");
    expect(p.streams.inv1).toBeUndefined();
    expect(visibleRuns(p, 0)).toEqual([]);
  });

  it("clears text from an attempt that ended or was replaced", () => {
    let p = applyDelta(applyRun(EMPTY_RUNS, run(), "t1"), delta(), "t1");
    p = applyRun(p, run({ attempt: 2, revision: 2, state: "leased" }), "t1");
    expect(p.streams.inv1).toBeUndefined();
    p = applyDelta(p, delta({ attempt: 2, fence_gen: 3 }), "t1");
    p = applyRun(p, run({ attempt: 2, revision: 3, state: "failed", failure: "provider_error" }), "t1");
    expect(p.streams.inv1).toBeUndefined();
  });

  it("ignores other threads", () => {
    expect(applyDelta(EMPTY_RUNS, delta({ thread_id: "t2" }), "t1")).toBe(EMPTY_RUNS);
    expect(applyRun(EMPTY_RUNS, run({ thread_id: "t2" }), "t1")).toBe(EMPTY_RUNS);
  });
});

describe("runs", () => {
  it("only moves forward by revision", () => {
    let p = applyRun(EMPTY_RUNS, run({ revision: 3, state: "running" }), "t1");
    p = applyRun(p, run({ revision: 2, state: "queued" }), "t1");
    expect(p.runs.inv1.state).toBe("running");
  });

  it("shows host offline with the 24h queue bound and the expired failure", () => {
    const now = Date.parse("2026-10-07T00:00:00Z");
    expect(runLabel(run({ state: "queued", host_online: false, queued_expires_at: "2026-10-08T00:00:00Z" }), now)).toBe("host offline, waits 24h then gives up");
    expect(runLabel(run({ state: "failed", failure: "queued_expired" }), now)).toBe("didn't start: host was offline for 24h");
    let p = applyRun(EMPTY_RUNS, run({ state: "queued" }), "t1");
    p = applyHostStatus({ ...p, bots: [{ bot_id: "bot1", name: "ana", host_online: true }] }, "bot1", false);
    expect(p.runs.inv1.host_online).toBe(false);
    expect(p.bots[0].host_online).toBe(false);
  });

  it("keeps a failed run visible but hides completed ones", () => {
    let p = applyRun(EMPTY_RUNS, run({ state: "completed" }), "t1");
    expect(visibleRuns(p, 0)).toEqual([]);
    p = applyRun(p, run({ invocation_id: "inv2", state: "failed", failure: "provider_error" }), "t1");
    expect(visibleRuns(p, 0).map((view) => view.label)).toEqual(["failed: provider error"]);
  });

  it("keeps a stream across a snapshot only while its attempt is still active", () => {
    let p = applyDelta(applyRun(EMPTY_RUNS, run(), "t1"), delta({ text: "hi" }), "t1");
    const kept = runsFromSnapshot(p, { active_runs: [run()], cards: [], messages: [] }, "t1");
    expect(kept.streams.inv1.text).toBe("hi");
    const finished = runsFromSnapshot(p, { active_runs: [run()], cards: [], messages: [{ invocation_id: "inv1" }] }, "t1");
    expect(finished.streams.inv1).toBeUndefined();
    p = runsFromSnapshot(p, { active_runs: [{ junk: true }, run({ attempt: 2 })], cards: [{ bad: 1 }], messages: [] }, "t1");
    expect(p.streams.inv1).toBeUndefined();
    expect(Object.keys(p.runs)).toEqual(["inv1"]);
  });
});

describe("approval cards", () => {
  it("one decision wins: a decided card never returns to pending, in either order", () => {
    for (let i = 0; i < 100; i++) {
      const approved = card({ state: "approved", decided_by: "alice" });
      const denied = card({ state: "denied", decided_by: "bob" });
      const pending = card();
      const order = i % 2 === 0 ? [pending, approved, denied, pending] : [pending, denied, approved, pending];
      let p = EMPTY_RUNS;
      for (const next of order) p = applyCard(p, next, "t1");
      expect(p.cards.c1.state).toBe(i % 2 === 0 ? "approved" : "denied");
    }
  });

  it("a newer version replaces an older decision", () => {
    let p = applyCard(EMPTY_RUNS, card({ state: "approved" }), "t1");
    p = applyCard(p, card({ version: 2, state: "pending", digest: "d2" }), "t1");
    expect(p.cards.c1).toMatchObject({ version: 2, state: "pending" });
  });

  it("fails closed when expired, revoked or view-only", () => {
    const now = Date.parse("2026-10-07T00:00:00Z");
    expect(decidable(card(), now)).toBe(true);
    expect(decidable(card({ expires_at: "2026-10-06T00:00:00Z" }), now)).toBe(false);
    expect(decidable(card({ state: "revoked" }), now)).toBe(false);
    expect(decidable(card({ can_decide: false }), now)).toBe(false);
  });
});
