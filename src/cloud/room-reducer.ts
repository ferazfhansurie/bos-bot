// Cloud room projection (D05) for the selected room/thread, plus this
// device's outbox. The cursor and the projection move together: a batch is
// validated whole, then either applies and advances the cursor or changes
// nothing. Resets replace the projection from a snapshot at watermark H and
// keep the outbox; batches then catch up strictly after H.
import {
  EVENT_KINDS,
  MessageSchema,
  SCHEMA_VERSION,
  type CloudEvent,
  type CloudFrame,
  type CloudMessage,
  type CloudSnapshot,
  type OperationResult,
  type ReadCoverage,
} from "../../shared/cloud-protocol/index";
import { isUnresolved, operationIdOf, outboxReducer, type OutboxAction, type OutboxEntry, type OutboxState } from "./outbox";
import { EMPTY_COVERAGE } from "./read-coverage";
import { compareSequence, isSequence, maxSequence, type Sequence } from "./sequence";

export interface CloudRoomState {
  /** The signed-in account's storage namespace; callbacks for another one are ignored. */
  namespace: string;
  account_id: string;
  workspace_id: string;
  selected_room_id: string;
  selected_thread_id: string;
  /** Selected-thread messages in sequence order. */
  messages: CloudMessage[];
  /** Opaque server cursor the subscription resumes from. */
  cursor: string | null;
  /** Highest sequence covered by the projection (applied, scanned or snapshot H). */
  head: Sequence | null;
  live: boolean;
  reset_required: boolean;
  reset_reason?: string;
  upgrade_required: boolean;
  /** This account lost access to the room; the projection is gone. */
  removed: boolean;
  snapshot_id?: string;
  policy_revision?: Sequence;
  members: CloudSnapshot["members"];
  capabilities: string[];
  read: ReadCoverage;
  outbox: OutboxEntry[];
}

export type CloudRoomAction =
  | { type: "frame"; frame: CloudFrame }
  | { type: "snapshot"; snapshot: CloudSnapshot }
  | { type: "read"; coverage: ReadCoverage }
  | { type: "account_switch"; namespace: string; account_id: string }
  | { type: "select"; workspace_id: string; room_id: string; thread_id: string }
  | { type: "outbox"; action: OutboxAction; namespace?: string }
  | { type: "outbox_persisted"; state: OutboxState; entry: OutboxEntry; namespace?: string }
  | { type: "operation"; result: OperationResult; now: number; namespace?: string }
  | { type: "history"; messages: CloudMessage[] }
  | { type: "disconnected" };

export function initialCloudRoomState(input: {
  namespace: string;
  account_id: string;
  workspace_id: string;
  room_id: string;
  thread_id: string;
  outbox?: OutboxEntry[];
}): CloudRoomState {
  return {
    namespace: input.namespace,
    account_id: input.account_id,
    workspace_id: input.workspace_id,
    selected_room_id: input.room_id,
    selected_thread_id: input.thread_id,
    messages: [],
    cursor: null,
    head: null,
    live: false,
    reset_required: false,
    upgrade_required: false,
    removed: false,
    members: [],
    capabilities: [],
    read: EMPTY_COVERAGE,
    outbox: input.outbox ?? [],
  };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(EVENT_KINDS);

function understood(event: CloudEvent): boolean {
  return KNOWN_KINDS.has(event.kind) && event.schema_version <= SCHEMA_VERSION;
}

function upsertMessage(messages: CloudMessage[], message: CloudMessage): CloudMessage[] {
  const index = messages.findIndex((existing) => existing.message_id === message.message_id);
  if (index >= 0) {
    if (messages[index].version > message.version) return messages;
    const next = [...messages];
    next[index] = message;
    return next;
  }
  // Order is server commit order, never a device clock.
  return [...messages, message].sort((a, b) => compareSequence(a.sequence, b.sequence));
}

function membershipRemovesMe(event: CloudEvent, accountId: string): boolean {
  const payload = event.payload as { account_id?: unknown; removed?: unknown; change?: unknown };
  return payload.account_id === accountId && (payload.removed === true || payload.change === "removed");
}

function applyBatch(state: CloudRoomState, frame: Extract<CloudFrame, { type: "event_batch" }>): CloudRoomState {
  if (state.upgrade_required || state.reset_required || state.removed) return state;
  if (frame.workspace_id !== state.workspace_id || frame.room_id !== state.selected_room_id) return state;
  // Validate the whole batch before any mutation.
  for (const event of frame.events) {
    if (!understood(event) && event.required) return { ...state, upgrade_required: true, live: false };
    if (!isSequence(event.sequence) || event.workspace_id !== frame.workspace_id || event.room_id !== frame.room_id) {
      return { ...state, reset_required: true, reset_reason: "invalid_batch", live: false };
    }
  }

  let next: CloudRoomState = state;
  for (const event of frame.events) {
    if (next.head !== null && compareSequence(event.sequence, next.head) <= 0) continue;
    next = { ...next, head: event.sequence };
    if (!understood(event)) continue;
    switch (event.kind) {
      case "message.created":
      case "message.updated":
      case "message.deleted": {
        const parsed = MessageSchema.safeParse((event.payload as { message?: unknown }).message);
        if (!parsed.success) break;
        const message = parsed.data;
        if (message.actor_id === next.account_id && message.client_operation_id) {
          next = { ...next, outbox: outboxReducer(next.outbox, { type: "stream_accepted", operation_id: message.client_operation_id, message_id: message.message_id, sequence: message.sequence }) };
        }
        // Content for other threads advances the cursor without moving the selection.
        if (message.thread_id === next.selected_thread_id) next = { ...next, messages: upsertMessage(next.messages, message) };
        break;
      }
      case "room.policy_changed": {
        const revision = (event.payload as { policy_revision?: unknown }).policy_revision;
        if (isSequence(revision)) next = { ...next, policy_revision: revision };
        break;
      }
      case "room.membership_changed":
        if (membershipRemovesMe(event, next.account_id)) {
          // Removal is processed before any further content: drop the projection.
          return { ...next, removed: true, live: false, messages: [], members: [], read: EMPTY_COVERAGE, cursor: frame.cursor };
        }
        break;
      case "presence":
        break;
    }
  }
  return { ...next, cursor: frame.cursor, head: maxSequence(next.head, frame.scanned_sequence), live: frame.live };
}

function applySnapshot(state: CloudRoomState, snapshot: CloudSnapshot): CloudRoomState {
  if (snapshot.workspace_id !== state.workspace_id || snapshot.room_id !== state.selected_room_id) return state;
  if (snapshot.thread_id !== state.selected_thread_id || state.removed) return state;
  const messages = snapshot.messages
    .filter((message) => message.thread_id === state.selected_thread_id)
    .sort((a, b) => compareSequence(a.sequence, b.sequence));
  // Atomic projection replacement; the outbox is independent and survives.
  return {
    ...state,
    messages,
    cursor: snapshot.cursor,
    head: snapshot.watermark,
    live: false,
    reset_required: false,
    reset_reason: undefined,
    snapshot_id: snapshot.snapshot_id,
    policy_revision: snapshot.policy_revision,
    members: snapshot.members,
    capabilities: snapshot.capabilities,
    read: snapshot.read,
  };
}

export function cloudRoomReducer(state: CloudRoomState, action: CloudRoomAction): CloudRoomState {
  switch (action.type) {
    case "frame": {
      const frame = action.frame;
      if (frame.type === "event_batch") return applyBatch(state, frame);
      if (frame.type === "reset_required") {
        if (frame.workspace_id !== state.workspace_id || frame.room_id !== state.selected_room_id) return state;
        if (frame.snapshot) return applySnapshot({ ...state, reset_required: true }, frame.snapshot);
        return { ...state, reset_required: true, reset_reason: frame.reason, live: false };
      }
      if (frame.type === "error" && frame.error === "upgrade_required") return { ...state, upgrade_required: true, live: false };
      return state;
    }
    case "snapshot":
      return applySnapshot(state, action.snapshot);
    case "read":
      return { ...state, read: action.coverage };
    case "account_switch":
      // Never carry content, cursors or pending sends across identities.
      return {
        ...initialCloudRoomState({
          namespace: action.namespace,
          account_id: action.account_id,
          workspace_id: state.workspace_id,
          room_id: state.selected_room_id,
          thread_id: state.selected_thread_id,
        }),
      };
    case "select":
      if (action.workspace_id === state.workspace_id && action.room_id === state.selected_room_id && action.thread_id === state.selected_thread_id) return state;
      return {
        ...initialCloudRoomState({ namespace: state.namespace, account_id: state.account_id, workspace_id: action.workspace_id, room_id: action.room_id, thread_id: action.thread_id, outbox: state.outbox }),
      };
    case "outbox":
      if (action.namespace !== undefined && action.namespace !== state.namespace) return state;
      return withOutbox(state, outboxReducer(state.outbox, action.action));
    case "outbox_persisted": {
      if (action.namespace !== undefined && action.namespace !== state.namespace) return state;
      const entry = { ...action.entry, state: action.state, dispatched: action.entry.dispatched || action.state !== "draft" };
      return withOutbox(state, outboxReducer(state.outbox, { type: "queued", entry }));
    }
    case "operation":
      if (action.namespace !== undefined && action.namespace !== state.namespace) return state;
      return withOutbox(state, outboxReducer(state.outbox, { type: "operation_result", result: action.result, now: action.now }));
    case "history": {
      let messages = state.messages;
      for (const message of action.messages) {
        if (message.thread_id === state.selected_thread_id) messages = upsertMessage(messages, message);
      }
      return messages === state.messages ? state : { ...state, messages };
    }
    case "disconnected":
      return state.live ? { ...state, live: false } : state;
  }
}

function withOutbox(state: CloudRoomState, outbox: OutboxEntry[]): CloudRoomState {
  return outbox === state.outbox ? state : { ...state, outbox };
}

export type TimelineItem = { kind: "message"; message: CloudMessage } | { kind: "pending"; entry: OutboxEntry };

/** Committed messages in server order, then this device's unresolved or failed sends for the thread. */
export function timeline(state: CloudRoomState): TimelineItem[] {
  const committed = new Set(state.messages.map((message) => message.client_operation_id));
  const items: TimelineItem[] = state.messages.map((message) => ({ kind: "message", message }));
  for (const entry of state.outbox) {
    if (entry.envelope.room_id !== state.selected_room_id || entry.envelope.thread_id !== state.selected_thread_id) continue;
    if (committed.has(operationIdOf(entry))) continue;
    // An HTTP acceptance shows as sent until its event reaches the projection.
    const awaitingEvent = entry.state === "accepted" && entry.sequence !== undefined && (state.head === null || compareSequence(entry.sequence, state.head) > 0);
    if (!isUnresolved(entry) && entry.state !== "rejected" && !awaitingEvent) continue;
    items.push({ kind: "pending", entry });
  }
  return items;
}
