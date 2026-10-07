import { describe, expect, it } from "vitest";
import type { CloudEvent, CloudFrame } from "../../shared/cloud-protocol/index";
import { freezeSend, type OutboxEntry } from "./outbox";
import { cloudRoomReducer, initialCloudRoomState, timeline, type CloudRoomAction, type CloudRoomState } from "./room-reducer";

function created(sequence: string, id: string, actor = "bob", op = `window1.op${sequence.padStart(14, "0")}`, thread = "t1"): CloudEvent {
  return {
    schema_version: 1,
    workspace_id: "w1",
    room_id: "r1",
    event_id: `ev${sequence}`,
    sequence,
    kind: "message.created",
    required: true,
    payload: {
      message: { workspace_id: "w1", room_id: "r1", thread_id: thread, message_id: id, actor_id: actor, client_operation_id: op, sequence, version: 1, text: id, mentions: [], reply_to_message_id: null, deleted: false, created_at: "2026-10-07T00:00:00.000Z" },
    },
  };
}

function batch(events: CloudEvent[], scanned: string, live = true): CloudRoomAction {
  const frame: CloudFrame = { type: "event_batch", workspace_id: "w1", room_id: "r1", events, cursor: `c${scanned}`, scanned_sequence: scanned, frontier: scanned, live };
  return { type: "frame", frame };
}

const start = (): CloudRoomState => initialCloudRoomState({ namespace: "alice", account_id: "alice", workspace_id: "w1", room_id: "r1", thread_id: "t1" });
const run = (state: CloudRoomState, actions: CloudRoomAction[]) => actions.reduce(cloudRoomReducer, state);

describe("cloud room reducer", () => {
  it("ignores batches for another room and frames after a reset until a snapshot", () => {
    let state = run(start(), [{ type: "frame", frame: { type: "event_batch", workspace_id: "w1", room_id: "r9", events: [], cursor: "x", scanned_sequence: "1", frontier: "1", live: true } }]);
    expect(state.cursor).toBeNull();
    state = run(state, [{ type: "frame", frame: { type: "reset_required", workspace_id: "w1", room_id: "r1", reason: "overflow" } }, batch([created("2", "m2")], "2")]);
    expect(state).toMatchObject({ reset_required: true, live: false, messages: [] });
  });

  it("tracks the policy revision on membership changes", () => {
    const change: CloudEvent = { schema_version: 1, workspace_id: "w1", room_id: "r1", event_id: "ev2", sequence: "2", kind: "room.membership_changed", required: true, payload: { policy_revision: "7" } };
    const state = run(start(), [batch([created("1", "m1"), change], "2")]);
    expect(state).toMatchObject({ policy_revision: "7", removed: false, messages: [{ message_id: "m1" }] });
  });

  it("drops the projection when the server reports this account lost access", () => {
    const state = run(start(), [batch([created("1", "m1")], "1"), { type: "frame", frame: { type: "error", error: "forbidden" } }, batch([created("2", "m2")], "2")]);
    expect(state).toMatchObject({ removed: true, messages: [], live: false });
  });

  it("reconciles own sends from the stream and shows unresolved sends after committed messages", async () => {
    const namespace = { service: "cloud-local", issuer: "stub", subject: "alice", account_id: "alice", workspace_id: "w1", epoch: "e1" };
    const make = async (text: string, nonce: string) =>
      (await freezeSend({ namespace, window_id: "window1", window_token: "t", room_id: "r1", thread_id: "t1", text, mentions: [], expected_policy_revision: "1", now: 0, nonce })) as OutboxEntry;
    const sent = await make("hi", "aaaaaaaaaaaaaaaa");
    const later = await make("later", "bbbbbbbbbbbbbbbb");
    let state = initialCloudRoomState({ namespace: "alice", account_id: "alice", workspace_id: "w1", room_id: "r1", thread_id: "t1", outbox: [sent, later] });
    state = run(state, [batch([created("1", "m1", "alice", sent.envelope.client_operation_id), created("2", "m2")], "2")]);
    expect(state.outbox[0]).toMatchObject({ state: "accepted", message_id: "m1" });
    expect(timeline(state).map((item) => (item.kind === "message" ? item.message.message_id : item.entry.envelope.text))).toEqual(["m1", "m2", "later"]);
  });

  it("keeps an HTTP-accepted send visible until its event arrives", async () => {
    const namespace = { service: "cloud-local", issuer: "stub", subject: "alice", account_id: "alice", workspace_id: "w1", epoch: "e1" };
    const entry = (await freezeSend({ namespace, window_id: "window1", window_token: "t", room_id: "r1", thread_id: "t1", text: "hi", mentions: [], expected_policy_revision: "1", now: 0, nonce: "aaaaaaaaaaaaaaaa" })) as OutboxEntry;
    let state = initialCloudRoomState({ namespace: "alice", account_id: "alice", workspace_id: "w1", room_id: "r1", thread_id: "t1", outbox: [{ ...entry, state: "sending", dispatched: true }] });
    state = cloudRoomReducer(state, {
      type: "operation",
      now: 0,
      result: { status: "accepted", client_operation_id: entry.envelope.client_operation_id, digest: entry.digest, message_id: "m4", room_id: "r1", thread_id: "t1", sequence: "4", redacted: false, retry: "none" },
    });
    expect(timeline(state)).toHaveLength(1);
    state = run(state, [batch([created("4", "m4", "alice", entry.envelope.client_operation_id)], "4")]);
    expect(timeline(state).map((item) => item.kind)).toEqual(["message"]);
  });

  it("keeps the outbox when the selected room changes", async () => {
    const state = run(start(), [batch([created("1", "m1")], "1"), { type: "select", workspace_id: "w1", room_id: "r2", thread_id: "t9" }]);
    expect(state).toMatchObject({ selected_room_id: "r2", messages: [], cursor: null });
  });
});

describe("cloud room reducer: bot runs, cards and revocation", () => {
  const hex = "a".repeat(64);
  const event = (sequence: string, kind: string, payload: Record<string, unknown>): CloudEvent => ({ schema_version: 1, workspace_id: "w1", room_id: "r1", event_id: `ev${sequence}`, sequence, kind, required: true, payload });
  const binding = { invocation_id: "inv1", attempt: 1, fence_gen: "1" };
  const invocation = (patch: Record<string, unknown> = {}) => ({
    ...binding,
    workspace_id: "w1",
    room_id: "r1",
    thread_id: "t1",
    bot_id: "bot1",
    state: "queued",
    model: { provider: "local", model: "m", config_revision: "1" },
    source: { message_id: "m1", version: 1, digest: hex, actor_id: "alice", text: "@bot1 hi", mentions: [], attachment_ids: [] },
    control_revision: "0",
    host_id: null,
    lease_expires_at: null,
    queued_expires_at: "2099-01-01T00:00:00.000Z",
    result_message_id: null,
    stop_requested: false,
    stopped_observed: false,
    replay_safe: true,
    host_online: true,
    ...patch,
  });
  const offered = (sequence: string) => event(sequence, "invocation.offered", { kind: "invocation.offered", ...binding, invocation: invocation() });
  const delta = (sequence: string, delta_id: string, text: string) => event(sequence, "stream.delta", { kind: "stream.delta", ...binding, delta_id, text });
  const finalReply = (sequence: string) => {
    const message = created(sequence, "reply1", "owner", "hello", "t1").payload.message as Record<string, unknown>;
    return event(sequence, "final.commit", { kind: "final.commit", ...binding, message: { ...message, bot_id: "bot1", client_operation_id: "invocation.inv1" } });
  };
  const stream = (sequence: string, text: string): CloudRoomAction => batch([delta(sequence, `d${sequence}`, text)], sequence);

  it("streams provisional text, then shows the committed reply exactly once", () => {
    let state = run(start(), [
      batch([created("1", "m1"), offered("2"), event("3", "invocation.claimed", { kind: "invocation.claimed", ...binding, host_id: "h1", model: invocation().model, lease_expires_at: "2099-01-01T00:00:00.000Z" })], "3"),
      batch([delta("4", "d1", "hel"), delta("5", "d2", "lo")], "5"),
    ]);
    expect(state.runs.runs.inv1).toMatchObject({ state: "leased", host_id: "h1" });
    expect(state.runs.streams.inv1.text).toBe("hello");
    state = run(state, [batch([finalReply("6"), delta("7", "d3", " late")], "7")]);
    expect(state.runs.streams.inv1).toBeUndefined();
    expect(state.runs.runs.inv1.state).toBe("completed");
    expect(state.messages.map((message) => message.message_id)).toEqual(["m1", "reply1"]);
    // The same final replayed after a reconnect does not duplicate it.
    state = run(state, [batch([finalReply("6")], "7")]);
    expect(state.messages.filter((message) => message.message_id === "reply1")).toHaveLength(1);
  });

  it("shows stop progress and approval cards from room events", () => {
    const control = { kind: "stop.requested", ...binding, control_revision: "1" };
    let state = run(start(), [batch([offered("1"), event("2", "stop.requested", control)], "2")]);
    expect(state.runs.runs.inv1).toMatchObject({ state: "held", stop_requested: true });
    state = run(state, [batch([event("3", "stop.observed", { ...control, kind: "stop.observed" })], "3")]);
    expect(state.runs.runs.inv1).toMatchObject({ state: "cancelled", stopped_observed: true });
    const card = { ...binding, approval_id: "ap1", workspace_id: "w1", room_id: "r1", thread_id: "t1", actor_id: "alice", version: 1, effect_id: "e1", digest: hex, title: "t", expires_at: "2099-01-01T00:00:00.000Z", status: "pending", can_view: true, can_decide: true };
    state = run(state, [batch([event("4", "approval.updated", { actor_id: "alice", card }), event("5", "approval.updated", { actor_id: "alice", card: { ...card, version: 2, status: "revoked", can_decide: false } })], "5")]);
    expect(state.runs.cards.ap1).toMatchObject({ version: 2, status: "revoked" });
  });

  it("removal drops content, streams, cards and runs at once; unsent drafts become not sent", async () => {
    const draft = await freezeSend({ namespace: { service: "bos", issuer: "i", subject: "alice", account_id: "alice", workspace_id: "w1", epoch: "e" }, window_id: "window1", window_token: "t", room_id: "r1", thread_id: "t1", text: "hi", mentions: [], expected_policy_revision: "1", now: 0 });
    if ("problem" in draft) throw new Error("bad draft");
    const sent: OutboxEntry = { ...draft, envelope: { ...draft.envelope, client_operation_id: "window1.sentsentsentsent1" }, state: "checking", dispatched: true };
    let state = run({ ...start(), outbox: [draft, sent] }, [batch([created("1", "m1"), offered("2")], "2"), stream("3", "secret")]);
    state = run(state, [{ type: "frame", frame: { type: "error", error: "forbidden" } }]);
    expect(state).toMatchObject({ removed: true, messages: [], runs: { runs: {}, cards: {}, streams: {} } });
    expect(state.outbox.map((entry) => entry.state)).toEqual(["rejected", "checking"]);
    // Nothing more arrives for a room this account lost.
    state = run(state, [stream("4", " more"), batch([created("5", "m5")], "5")]);
    expect(state.runs.streams).toEqual({});
    expect(state.messages).toEqual([]);
  });

  it("goes not-live when the device goes offline", () => {
    const state = run(start(), [batch([], "1", true), { type: "network", online: false }]);
    expect(state).toMatchObject({ online: false, live: false });
  });
});
