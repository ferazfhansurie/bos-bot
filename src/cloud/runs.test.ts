import { describe, expect, it } from "vitest";
import { ApprovalCardSchema, InvocationSchema, type ApprovalCard, type CloudInvocation, type CloudMessage } from "../../shared/cloud-protocol/index";
import {
  applyCard,
  applyDelta,
  applyFinal,
  applyHostPresence,
  applyRun,
  compareBinding,
  decidable,
  EMPTY_RUNS,
  finalInvocationId,
  patchRun,
  roomBots,
  runLabel,
  runsFromSnapshot,
  visibleRuns,
  type StreamDelta,
} from "./runs";

const hex = "a".repeat(64);
const run = (patch: Partial<CloudInvocation> = {}): CloudInvocation =>
  InvocationSchema.parse({
    invocation_id: "inv1",
    attempt: 1,
    fence_gen: "1",
    workspace_id: "w1",
    room_id: "r1",
    thread_id: "t1",
    bot_id: "bot1",
    state: "running",
    model: { provider: "local", model: "m", config_revision: "1" },
    source: { message_id: "m1", version: 1, digest: hex, actor_id: "alice", text: "@bot1 hi", mentions: [], attachment_ids: [] },
    control_revision: "0",
    host_id: "h1",
    lease_expires_at: null,
    queued_expires_at: "2099-01-01T00:00:00.000Z",
    result_message_id: null,
    stop_requested: false,
    stopped_observed: false,
    replay_safe: false,
    host_online: true,
    ...patch,
  });
const card = (patch: Partial<ApprovalCard> = {}): ApprovalCard =>
  ApprovalCardSchema.parse({
    invocation_id: "inv1",
    attempt: 1,
    fence_gen: "1",
    approval_id: "ap1",
    workspace_id: "w1",
    room_id: "r1",
    thread_id: "t1",
    actor_id: "alice",
    version: 1,
    effect_id: "e1",
    digest: hex,
    title: "send the report",
    expires_at: "2099-01-01T00:00:00.000Z",
    status: "pending",
    can_view: true,
    can_decide: true,
    ...patch,
  });
const delta = (delta_id: string, text: string, patch: Partial<StreamDelta> = {}): StreamDelta => ({ invocation_id: "inv1", attempt: 1, fence_gen: "1", delta_id, text, ...patch });
const message = (patch: Partial<CloudMessage> = {}): CloudMessage => ({
  workspace_id: "w1",
  room_id: "r1",
  thread_id: "t1",
  message_id: "m9",
  actor_id: "owner",
  client_operation_id: "invocation.inv1",
  sequence: "9",
  version: 1,
  text: "final",
  mentions: [],
  reply_to_message_id: "m1",
  deleted: false,
  bot_id: "bot1",
  created_at: "2026-10-07T00:00:00.000Z",
  ...patch,
});
const withRun = (value = run()) => applyRun(EMPTY_RUNS, value, "t1");

describe("cloud bot runs", () => {
  it("compares fence generations as decimal strings past 2^53", () => {
    expect(compareBinding({ attempt: 1, fence_gen: "9007199254740993" }, { attempt: 1, fence_gen: "9007199254740992" })).toBe(1);
    expect(compareBinding({ attempt: 2, fence_gen: "1" }, { attempt: 1, fence_gen: "99" })).toBe(1);
  });

  it("streams provisional text once per delta id and in event order", () => {
    let p = withRun();
    p = applyDelta(p, delta("d1", "hel"));
    p = applyDelta(p, delta("d2", "lo"));
    p = applyDelta(p, delta("d1", "hel"));
    expect(p.streams.inv1.text).toBe("hello");
  });

  it("never lets an older attempt or a stale fence generation touch newer text", () => {
    let p = withRun(run({ attempt: 2, fence_gen: "5" }));
    p = applyDelta(p, delta("old", "stale", { attempt: 1, fence_gen: "9" }));
    p = applyDelta(p, delta("older-gen", "stale", { attempt: 2, fence_gen: "4" }));
    expect(p.streams.inv1).toBeUndefined();
    p = applyDelta(p, delta("new", "fresh", { attempt: 2, fence_gen: "5" }));
    expect(p.streams.inv1.text).toBe("fresh");
    p = applyDelta(p, delta("late", "stale", { attempt: 2, fence_gen: "4" }));
    expect(p.streams.inv1.text).toBe("fresh");
  });

  it("drops provisional text on a new attempt, a terminal state and the committed final", () => {
    let p = applyDelta(withRun(), delta("d1", "draft"));
    expect(applyRun(p, run({ attempt: 2, fence_gen: "2" }), "t1").streams.inv1).toBeUndefined();
    expect(applyRun(p, run({ state: "failed" }), "t1").streams.inv1).toBeUndefined();
    p = applyFinal(p, "inv1", "m9");
    expect(p.streams.inv1).toBeUndefined();
    expect(p.runs.inv1.state).toBe("completed");
    expect(applyDelta(p, delta("d2", "late")).streams.inv1).toBeUndefined();
    expect(visibleRuns(p, 0)).toEqual([]);
  });

  it("recognizes a final only from the bot's invocation operation", () => {
    expect(finalInvocationId(message())).toBe("inv1");
    expect(finalInvocationId(message({ bot_id: null }))).toBeNull();
    expect(finalInvocationId(message({ client_operation_id: "w.op" }))).toBeNull();
  });

  it("patches claims and stops only at the same or a newer binding", () => {
    let p = withRun(run({ attempt: 2, fence_gen: "3", state: "queued" }));
    p = patchRun(p, { invocation_id: "inv1", attempt: 1, fence_gen: "9" }, { state: "leased" });
    expect(p.runs.inv1.state).toBe("queued");
    p = patchRun(p, { invocation_id: "inv1", attempt: 3, fence_gen: "4" }, { state: "leased", host_id: "h2" });
    expect(p.runs.inv1).toMatchObject({ state: "leased", attempt: 3, fence_gen: "4", host_id: "h2" });
    expect(patchRun(EMPTY_RUNS, { invocation_id: "nope", attempt: 1, fence_gen: "1" }, { state: "held" })).toBe(EMPTY_RUNS);
  });

  it("keeps the newest card version: one decision wins and never reverts", () => {
    let p = applyCard(withRun(), card(), "t1");
    p = applyCard(p, card({ version: 2, status: "approved", can_decide: false }), "t1");
    p = applyCard(p, card({ version: 1, status: "pending" }), "t1");
    p = applyCard(p, card({ version: 2, status: "denied" }), "t1");
    expect(p.cards.ap1).toMatchObject({ version: 2, status: "approved" });
    expect(applyCard(p, card({ approval_id: "ap2", thread_id: "t2" }), "t1").cards.ap2).toBeUndefined();
  });

  it("lets only the bound actor decide a pending, unexpired card", () => {
    expect(decidable(card(), "alice", 0)).toBe(true);
    expect(decidable(card(), "bob", 0)).toBe(false);
    expect(decidable(card({ status: "revoked" }), "alice", 0)).toBe(false);
    expect(decidable(card({ can_decide: false }), "alice", 0)).toBe(false);
    expect(decidable(card({ expires_at: "2000-01-01T00:00:00Z" }), "alice", Date.now())).toBe(false);
  });

  it("labels offline hosts, the 24h expiry, stops and lost runs", () => {
    const now = Date.parse("2026-10-07T00:00:00Z");
    expect(runLabel(run({ state: "queued", host_id: null, host_online: false, queued_expires_at: "2026-10-07T05:30:00Z" }), now)).toBe("host offline, waits 6h then gives up");
    expect(runLabel(run({ state: "failed", host_id: null }), now)).toBe("didn't start: host was offline for 24h");
    expect(runLabel(run({ state: "held", stop_requested: true }), now)).toBe("stopping");
    expect(runLabel(run({ state: "cancelled", stop_requested: true, stopped_observed: true }), now)).toBe("stopped");
    expect(runLabel(run({ state: "held" }), now)).toBe("on hold: the host lost this run");
    expect(runLabel(run({ state: "waiting_for_human" }), now)).toBe("needs a decision");
    expect(runLabel(run({ host_online: false }), now)).toBe("host went offline, waiting to recover");
  });

  it("marks runs on a host offline from presence", () => {
    const p = applyHostPresence(withRun(), "h1", false);
    expect(p.runs.inv1.host_online).toBe(false);
    expect(applyHostPresence(p, "other", true)).toBe(p);
  });

  it("replaces from a snapshot, keeping streams only for the same live binding", () => {
    const streaming = applyDelta(withRun(), delta("d1", "partial"));
    const same = runsFromSnapshot(streaming, { active_runs: [run()], cards: [card()], messages: [] }, "t1");
    expect(same.streams.inv1.text).toBe("partial");
    expect(same.cards.ap1).toBeDefined();
    const moved = runsFromSnapshot(streaming, { active_runs: [run({ attempt: 2, fence_gen: "2" })], cards: [], messages: [] }, "t1");
    expect(moved.streams.inv1).toBeUndefined();
    const finished = runsFromSnapshot(streaming, { active_runs: [], cards: [], messages: [message()] }, "t1");
    expect(finished.finals.inv1).toBe(true);
    expect(finished.streams.inv1).toBeUndefined();
  });

  it("lists bots seen in the thread with their host status", () => {
    const bots = roomBots(withRun(run({ bot_id: "bot2", host_online: false })), [message()]);
    expect(bots).toEqual([
      { bot_id: "bot1", name: "bot1", host_online: null },
      { bot_id: "bot2", name: "bot2", host_online: false },
    ]);
  });

  it("shows the newest card with its run", () => {
    let p = applyCard(withRun(run({ state: "waiting_for_human" })), card(), "t1");
    p = applyCard(p, card({ version: 3, status: "expired" }), "t1");
    expect(visibleRuns(p, 0)[0].card).toMatchObject({ version: 3, status: "expired" });
  });
});
