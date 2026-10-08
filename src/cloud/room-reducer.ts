// Cloud room projection (D05) for the selected room/thread, plus this
// device's outbox. The cursor and the projection move together: a batch is
// validated whole, then either applies and advances the cursor or changes
// nothing. Resets replace the projection from a snapshot at watermark H and
// keep the outbox; batches then catch up strictly after H.
import {
  ApprovalCardSchema,
  AuthorityChangedSchema,
  EVENT_KINDS,
  InvocationSchema,
  LIMITS,
  MessageSchema,
  RunBindingSchema,
  type ApprovalCard,
  SCHEMA_VERSION,
  type CloudEvent,
  type CloudFrame,
  type CloudMessage,
  type CloudSnapshot,
  type OperationResult,
  type ReadCoverage,
} from "../../shared/cloud-protocol/index";
import { isUnresolved, operationIdOf, outboxReducer, type OutboxAction, type OutboxEntry, type OutboxState } from "./outbox";
import { applyCard, applyDelta, applyFinal, applyHostPresence, applyRun, EMPTY_RUNS, finalInvocationId, patchRun, runsFromSnapshot, StreamDeltaSchema, type RunProjection } from "./runs";
import { z } from "zod";
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
  /** Bot runs, approval cards and provisional stream text for the selected thread. */
  runs: RunProjection;
  /** The device reports a network connection. */
  online: boolean;
  /** Epoch announced by the last authority_changed; old cursors, windows and drafts don't cross it. */
  authority_epoch?: string;
  /** The loaded messages reach the first message of the thread; there is nothing older to page in. */
  start_loaded: boolean;
  /** An older page is in flight, requested before this sequence. */
  older_before: Sequence | null;
  /** The last older-page request failed; scrolling up again retries. */
  older_failed: boolean;
}

/** One backward page of the selected thread: everything strictly before `before`, newest last. */
export interface HistoryPage {
  room_id: string;
  thread_id: string;
  before: Sequence;
  messages: CloudMessage[];
  /** Null when the page reaches the start of the thread. */
  next_before: Sequence | null;
}

export type CloudRoomAction =
  | { type: "frame"; frame: CloudFrame }
  | { type: "snapshot"; snapshot: CloudSnapshot }
  | { type: "network"; online: boolean }
  | { type: "card"; card: ApprovalCard }
  | { type: "read"; coverage: ReadCoverage }
  | { type: "account_switch"; namespace: string; account_id: string }
  | { type: "select"; workspace_id: string; room_id: string; thread_id: string }
  | { type: "outbox"; action: OutboxAction; namespace?: string }
  | { type: "outbox_persisted"; state: OutboxState; entry: OutboxEntry; namespace?: string }
  | { type: "operation"; result: OperationResult; now: number; namespace?: string }
  | { type: "history_requested"; room_id: string; thread_id: string; before: Sequence }
  | { type: "history"; page: HistoryPage }
  | { type: "history_failed"; room_id: string; thread_id: string; before: Sequence }
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
    runs: EMPTY_RUNS,
    online: true,
    start_loaded: false,
    older_before: null,
    older_failed: false,
  };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(EVENT_KINDS);
// Event payloads also carry `kind` and extras, so read the binding shape without strictness.
const ClaimedSchema = z.object({ ...RunBindingSchema.shape, host_id: z.string(), lease_expires_at: z.string() });
const ControlSchema = z.object({ ...RunBindingSchema.shape, control_revision: z.string() });

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
      case "message.deleted":
      case "final.commit": {
        const parsed = MessageSchema.safeParse((event.payload as { message?: unknown }).message);
        if (!parsed.success) break;
        const message = parsed.data;
        // The committed final replaces the bot's provisional text, exactly once.
        const invocation = finalInvocationId(message);
        if (invocation) next = { ...next, runs: applyFinal(next.runs, invocation, message.message_id) };
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
      case "room.membership_changed": {
        // Membership changes bump the room policy; our own removal arrives as a forbidden error frame.
        const revision = (event.payload as { policy_revision?: unknown }).policy_revision;
        if (isSequence(revision)) next = { ...next, policy_revision: revision };
        break;
      }
      case "invocation.offered":
      case "run.updated": {
        const run = InvocationSchema.safeParse((event.payload as { invocation?: unknown }).invocation);
        if (run.success) next = { ...next, runs: applyRun(next.runs, run.data, next.selected_thread_id) };
        break;
      }
      case "invocation.claimed": {
        const claimed = ClaimedSchema.safeParse(event.payload);
        if (claimed.success) next = { ...next, runs: patchRun(next.runs, claimed.data, { state: "leased", host_id: claimed.data.host_id, lease_expires_at: claimed.data.lease_expires_at }) };
        break;
      }
      case "stop.requested": {
        const stop = ControlSchema.safeParse(event.payload);
        if (stop.success) next = { ...next, runs: patchRun(next.runs, stop.data, { state: "held", stop_requested: true, control_revision: stop.data.control_revision }) };
        break;
      }
      case "stop.observed": {
        const stop = ControlSchema.safeParse(event.payload);
        if (stop.success) next = { ...next, runs: patchRun(next.runs, stop.data, { state: "cancelled", stopped_observed: true, control_revision: stop.data.control_revision }) };
        break;
      }
      case "stream.delta": {
        const delta = StreamDeltaSchema.safeParse(event.payload);
        // Deltas carry no thread; only runs of the selected thread are in the projection.
        if (delta.success && next.runs.runs[delta.data.invocation_id]) next = { ...next, runs: applyDelta(next.runs, delta.data) };
        break;
      }
      case "approval.updated": {
        const card = ApprovalCardSchema.safeParse((event.payload as { card?: unknown }).card);
        if (card.success) next = { ...next, runs: applyCard(next.runs, card.data, next.selected_thread_id) };
        break;
      }
      case "presence": {
        const { host_id, online } = event.payload as { host_id?: unknown; online?: unknown };
        if (typeof host_id === "string" && typeof online === "boolean") next = { ...next, runs: applyHostPresence(next.runs, host_id, online) };
        break;
      }
      case "attachment.updated":
        break;
      case "authority_changed": {
        const moved = AuthorityChangedSchema.safeParse(event.payload);
        if (!moved.success || moved.data.workspace_id !== next.workspace_id) return { ...state, reset_required: true, reset_reason: "invalid_batch", live: false };
        return authorityChanged(next, moved.data.epoch);
      }
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
  // Any older page in flight belonged to the replaced projection and is dropped when it lands.
  return {
    ...state,
    messages,
    start_loaded: snapshot.messages.length < LIMITS.snapshotMessages,
    older_before: null,
    older_failed: false,
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
    runs: runsFromSnapshot(state.runs, { ...snapshot, messages }, state.selected_thread_id),
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
      // The server re-authorizes every publication; forbidden means this account lost room access.
      if (frame.type === "error" && frame.error === "forbidden") return revokeRoom(state);
      return state;
    }
    case "snapshot":
      return applySnapshot(state, action.snapshot);
    case "card": {
      if (state.removed) return state;
      const runs = applyCard(state.runs, action.card, state.selected_thread_id);
      return runs === state.runs ? state : { ...state, runs };
    }
    case "network":
      if (action.online === state.online) return state;
      return { ...state, online: action.online, live: action.online ? state.live : false };
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
    case "history_requested":
      if (!selected(state, action) || olderCursor(state) !== action.before) return state;
      return { ...state, older_before: action.before, older_failed: false };
    case "history_failed":
      if (!selected(state, action) || state.older_before !== action.before) return state;
      return { ...state, older_before: null, older_failed: true };
    case "history":
      return applyOlderPage(state, action.page);
    case "disconnected":
      return state.live ? { ...state, live: false } : state;
  }
}

function selected(state: CloudRoomState, ref: { room_id: string; thread_id: string }): boolean {
  return ref.room_id === state.selected_room_id && ref.thread_id === state.selected_thread_id;
}

/**
 * The sequence to page backward from, or null when there is nothing to ask
 * for: the start is loaded, a page is already in flight, or the room is gone.
 * The cursor is the oldest loaded message, so a page always joins the
 * projection without a gap.
 */
export function olderCursor(state: CloudRoomState): Sequence | null {
  if (state.start_loaded || state.removed || state.older_before !== null) return null;
  return state.messages[0]?.sequence ?? null;
}

/**
 * Merge an older page in front of the loaded messages: one entry per
 * message id (the higher version wins), server sequence order.
 */
export function mergeOlder(messages: CloudMessage[], older: CloudMessage[]): CloudMessage[] {
  const byId = new Map<string, CloudMessage>();
  for (const message of [...older, ...messages]) {
    const existing = byId.get(message.message_id);
    if (!existing || existing.version < message.version) byId.set(message.message_id, message);
  }
  return [...byId.values()].sort((a, b) => compareSequence(a.sequence, b.sequence));
}

function applyOlderPage(state: CloudRoomState, page: HistoryPage): CloudRoomState {
  if (!selected(state, page) || state.removed) return state;
  // A reset replaced the projection while the page was in flight: it no longer joins, drop it.
  if (state.older_before !== page.before || state.messages[0]?.sequence !== page.before) {
    return state.older_before === page.before ? { ...state, older_before: null } : state;
  }
  const older = page.messages.filter((message) => message.thread_id === state.selected_thread_id && isSequence(message.sequence) && compareSequence(message.sequence, page.before) < 0);
  const start_loaded = page.next_before === null || page.messages.length === 0;
  return { ...state, messages: older.length > 0 ? mergeOlder(state.messages, older) : state.messages, start_loaded, older_before: null, older_failed: false };
}

/**
 * Losing the room drops everything at once: content, provisional streams,
 * cards and runs. Sends that never left the device become "not sent";
 * anything that may have left stays unresolved rather than claiming either way.
 */
function revokeRoom(state: CloudRoomState): CloudRoomState {
  const outbox = state.outbox.map((entry) =>
    entry.envelope.room_id === state.selected_room_id && entry.state === "draft" && !entry.dispatched ? { ...entry, state: "rejected" as const, rejection: "forbidden" } : entry,
  );
  return { ...state, removed: true, live: false, messages: [], members: [], read: EMPTY_COVERAGE, runs: EMPTY_RUNS, outbox };
}

/**
 * The workspace moved to a new authority epoch. Nothing from the old epoch
 * carries over: the cursor and snapshot are dropped so the client re-discovers
 * and reloads, and never-sent drafts are held for review. The rest of the
 * batch belongs to the old cursor and is not applied.
 */
function authorityChanged(state: CloudRoomState, epoch: string): CloudRoomState {
  return withOutbox(
    { ...state, authority_epoch: epoch, cursor: null, snapshot_id: undefined, live: false, reset_required: true, reset_reason: "authority_changed" },
    outboxReducer(state.outbox, { type: "authority_changed", workspace_id: state.workspace_id, epoch }),
  );
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
