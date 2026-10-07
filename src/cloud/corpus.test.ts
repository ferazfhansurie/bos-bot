// Runs every reducer case in the shared cloud protocol corpus against the web
// reducer. The corpus is api's; this file only translates its steps.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CloudFrame, CloudMessage, CloudSnapshot, OperationResult, ReadCoverage, SendEnvelope } from "../../shared/cloud-protocol/index";
import { envelopeDigest, type OutboxEntry, type OutboxState } from "./outbox";
import { cloudRoomReducer, initialCloudRoomState, type CloudRoomState } from "./room-reducer";

type Step =
  | { type: "outbox"; state: OutboxState; envelope: SendEnvelope; namespace?: string }
  | { type: "operation"; result: OperationResult; namespace?: string }
  | { type: "frame"; frame: CloudFrame }
  | { type: "snapshot"; snapshot: CloudSnapshot }
  | { type: "read"; coverage: ReadCoverage }
  | { type: "account_switch"; namespace: string };

interface ReducerCase {
  id: string;
  initial: {
    namespace: string;
    selected_room_id: string;
    selected_thread_id: string;
    messages: CloudMessage[];
    cursor: string | null;
    live: boolean;
    outbox: Record<string, { state: OutboxState; envelope: SendEnvelope }>;
    read: ReadCoverage;
  };
  steps: Step[];
  expected: Partial<{
    message_ids: string[];
    cursor: string | null;
    live: boolean;
    outbox_state: OutboxState;
    outbox_envelope: SendEnvelope;
    outbox_empty: boolean;
    upgrade_required: boolean;
    reset_required: boolean;
    recovery_required: boolean;
    read: ReadCoverage;
    namespace: string;
    selected_room_id: string;
    selected_thread_id: string;
  }>;
}

const corpus = JSON.parse(readFileSync(new URL("../../shared/cloud-protocol/fixtures.json", import.meta.url), "utf8")) as {
  schema_version: number;
  digest_vectors: Array<{ envelope: SendEnvelope; sha256: string }>;
  reducer_cases: ReducerCase[];
};

function workspaceOf(testCase: ReducerCase): string {
  for (const step of testCase.steps) {
    if (step.type === "frame") return step.frame.type === "event_batch" || step.frame.type === "reset_required" ? step.frame.workspace_id : "w1";
    if (step.type === "snapshot") return step.snapshot.workspace_id;
    if (step.type === "outbox") return step.envelope.namespace.workspace_id;
  }
  return "w1";
}

async function entryFor(envelope: SendEnvelope, state: OutboxState): Promise<OutboxEntry> {
  return { envelope, digest: await envelopeDigest(envelope), state, created_at: 0, dispatched: state !== "draft", attempts: 0 };
}

async function run(testCase: ReducerCase): Promise<{ state: CloudRoomState; operationId: string | null }> {
  const initial = testCase.initial;
  let operationId: string | null = null;
  const outbox: OutboxEntry[] = [];
  for (const [id, entry] of Object.entries(initial.outbox)) {
    outbox.push(await entryFor(entry.envelope, entry.state));
    operationId = id;
  }
  let state: CloudRoomState = {
    ...initialCloudRoomState({
      namespace: initial.namespace,
      account_id: initial.namespace,
      workspace_id: workspaceOf(testCase),
      room_id: initial.selected_room_id,
      thread_id: initial.selected_thread_id,
      outbox,
    }),
    messages: initial.messages,
    cursor: initial.cursor,
    live: initial.live,
    read: initial.read,
  };
  for (const step of testCase.steps) {
    switch (step.type) {
      case "outbox":
        operationId = step.envelope.client_operation_id;
        state = cloudRoomReducer(state, { type: "outbox_persisted", state: step.state, entry: await entryFor(step.envelope, step.state), namespace: step.namespace });
        break;
      case "operation":
        state = cloudRoomReducer(state, { type: "operation", result: step.result, now: 0, namespace: step.namespace });
        break;
      case "frame":
        state = cloudRoomReducer(state, { type: "frame", frame: step.frame });
        break;
      case "snapshot":
        state = cloudRoomReducer(state, { type: "snapshot", snapshot: step.snapshot });
        break;
      case "read":
        state = cloudRoomReducer(state, { type: "read", coverage: step.coverage });
        break;
      case "account_switch":
        state = cloudRoomReducer(state, { type: "account_switch", namespace: step.namespace, account_id: step.namespace });
        break;
      default:
        throw new Error(`unknown corpus step ${(step as { type: string }).type}`);
    }
  }
  return { state, operationId };
}

describe("cloud protocol corpus (web reducer)", () => {
  it("pins schema version 1", () => {
    expect(corpus.schema_version).toBe(1);
    expect(corpus.reducer_cases.length).toBeGreaterThan(0);
  });

  for (const vector of corpus.digest_vectors) {
    it(`digest ${vector.sha256.slice(0, 8)}`, async () => {
      expect(await envelopeDigest(vector.envelope)).toBe(vector.sha256);
    });
  }

  for (const testCase of corpus.reducer_cases) {
    it(testCase.id, async () => {
      const { state, operationId } = await run(testCase);
      const expected = testCase.expected;
      const entry = state.outbox.find((item) => item.envelope.client_operation_id === operationId);
      if (expected.message_ids !== undefined) expect(state.messages.map((message) => message.message_id)).toEqual(expected.message_ids);
      if (expected.cursor !== undefined) expect(state.cursor).toBe(expected.cursor);
      if (expected.live !== undefined) expect(state.live).toBe(expected.live);
      if (expected.outbox_state !== undefined) expect(entry?.state).toBe(expected.outbox_state);
      if (expected.outbox_envelope !== undefined) expect(entry?.envelope).toEqual(expected.outbox_envelope);
      if (expected.outbox_empty !== undefined) expect(state.outbox.length === 0).toBe(expected.outbox_empty);
      if (expected.upgrade_required !== undefined) expect(state.upgrade_required).toBe(expected.upgrade_required);
      if (expected.reset_required !== undefined) expect(state.reset_required).toBe(expected.reset_required);
      if (expected.recovery_required !== undefined) expect(Boolean(entry?.recovery_required)).toBe(expected.recovery_required);
      if (expected.read !== undefined) expect(state.read).toEqual(expected.read);
      if (expected.namespace !== undefined) expect(state.namespace).toBe(expected.namespace);
      if (expected.selected_room_id !== undefined) expect(state.selected_room_id).toBe(expected.selected_room_id);
      if (expected.selected_thread_id !== undefined) expect(state.selected_thread_id).toBe(expected.selected_thread_id);
      const known = new Set(["message_ids", "cursor", "live", "outbox_state", "outbox_envelope", "outbox_empty", "upgrade_required", "reset_required", "recovery_required", "read", "namespace", "selected_room_id", "selected_thread_id"]);
      expect(Object.keys(expected).filter((key) => !known.has(key))).toEqual([]);
    });
  }
});
