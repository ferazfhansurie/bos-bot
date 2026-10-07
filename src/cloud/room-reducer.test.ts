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

  it("drops the projection when this account is removed", () => {
    const removal: CloudEvent = { schema_version: 1, workspace_id: "w1", room_id: "r1", event_id: "ev2", sequence: "2", kind: "room.membership_changed", required: true, payload: { account_id: "alice", removed: true } };
    const state = run(start(), [batch([created("1", "m1"), removal], "2"), batch([created("3", "m3")], "3")]);
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
