import { assertQueueAttachmentsUnchanged } from "./queue-edit.ts";
// Follow-up messages sent while a channel is working.
//
// The renderer must hand these to the harness immediately. Keeping them in a
// mounted composer loses the auto-send intent on navigation, reconnect, or a
// renderer reload. They stay off the transcript until the active channel
// operation settles so the current responder cannot appear to answer words it
// never saw.

import { newId } from "./contracts.ts";
import { chatFollowups, editChatFollowup, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import { sameAttachedSend } from "./steer-queue.ts";

interface ChannelQueueItem {
  id: string;
  text: string;
  replyToId?: string;
  sendId?: string;
  mode: "chat" | "goal";
  deferUntilIdle?: boolean;
  /** kept so the drain appends it with the same provenance it arrived with */
  via?: "api";
  /** the signed-in person who sent it, so the drained row keeps its author */
  sender?: { name: string };
}

interface ChannelQueueEntry {
  groupId: string;
  items: ChannelQueueItem[];
}

const queues = new Map<string, ChannelQueueEntry>(); // threadId -> waiting sends
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
export function onChannelQueueChange(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function queuedChannelSnapshot(ownsThread: (groupId: string, threadId: string) => boolean): Record<string, Array<{ queueId: string; text: string }>> {
  return Object.fromEntries([...queues].filter(([threadId, entry]) => ownsThread(entry.groupId, threadId))
    .map(([threadId, entry]) => [threadId, entry.items.map(item => ({ queueId: item.id, text: item.text }))]));
}


export function restoreChannelMessages(): void {
  queues.clear();
  for (const row of chatFollowups("channel")) {
    if (row.status !== "pending") continue;
    const entry = queues.get(row.threadId) ?? { groupId: row.ownerId, items: [] };
    if (entry.groupId !== row.ownerId) throw new Error("queued task belongs to another channel");
    entry.items.push({ ...row.payload, id: row.id, mode: row.payload.mode ?? "chat" });
    queues.set(row.threadId, entry);
  }
}

export interface QueuedChannelMessage {
  id: string;
  /** A duplicate send joined this already-waiting item. */
  joined?: boolean;
}

export function queueChannelMessage(
  groupId: string,
  threadId: string,
  text: string,
  options: {
    replyToId?: string;
    sendId?: string;
    mode?: "chat" | "goal";
    deferUntilIdle?: boolean;
    via?: "api";
    sender?: { name: string };
  } = {},
): QueuedChannelMessage {
  const entry = queues.get(threadId) ?? { groupId, items: [] };
  if (entry.groupId !== groupId) throw new Error("queued task belongs to another channel");
  // One send = one item (see queueSteeredMessage): a duplicate attachment send
  // that only differs in whitespace joins the waiting one.
  const same = sameAttachedSend(text);
  const pending = same && entry.items.find((queued) => same(queued.text)
    && queued.mode === (options.mode ?? "chat")
    && queued.replyToId === options.replyToId
    && queued.via === options.via
    && queued.sender?.name === options.sender?.name);
  if (pending) return { id: pending.id, joined: true };
  const item: ChannelQueueItem = {
    id: newId(),
    text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    mode: options.mode ?? "chat",
    deferUntilIdle: options.deferUntilIdle,
    via: options.via,
    ...(options.sender ? { sender: options.sender } : {}),
  };
  saveChatFollowup({ id: item.id, kind: "channel", ownerId: groupId, threadId, payload: item });
  entry.items.push(item);
  queues.set(threadId, entry);
  changed();
  return { id: item.id };
}

/** Edit one pending send without lifting/reordering the room queue. */
export function editChannelMessage(groupId: string, threadId: string, queueId: string,
  expectedText: string, text: string): boolean {
  const entry = queues.get(threadId);
  const item = entry?.groupId === groupId ? entry.items.find(item => item.id === queueId) : undefined;
  if (!item || (item.text !== expectedText && item.text !== text)) return false;
  assertQueueAttachmentsUnchanged(item.text, text);
  const next = { ...item, text };
  if (!editChatFollowup("channel", groupId, threadId, queueId, item, next)) return false;
  Object.assign(item, next);
  changed();
  return true;
}

/** Find the stable receipt for an HTTP retry that is still waiting. */
export function queuedChannelMessage(
  groupId: string,
  threadId: string,
  sendId: string,
): ChannelQueueItem | null {
  const entry = queues.get(threadId);
  if (!entry || entry.groupId !== groupId) return null;
  return entry.items.find((item) => item.sendId === sendId) ?? null;
}

/** Inspect the owned FIFO head before claiming it for a tool-boundary steer. */
export function channelQueueHead(groupId: string, threadId: string): ChannelQueueItem | undefined {
  const entry = queues.get(threadId);
  return entry?.groupId === groupId ? entry.items[0] : undefined;
}

/** Remove one queued message before it starts. */
export function cancelChannelMessage(groupId: string, queueId: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.groupId !== groupId) continue;
    const items = entry.items.filter((item) => item.id !== queueId);
    if (items.length === entry.items.length) continue;
    settleChatFollowups([queueId], "cancelled");
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { groupId, items });
    changed();
    return true;
  }
  return false;
}

/** A channel thread's queue lifted out of the map while a live steer is
 * attempted against the room's running speaker. */
export interface HeldChannelQueue {
  groupId: string;
  threadId: string;
  items: ChannelQueueItem[];
}

/** Atomically lift a channel thread's whole queue out for a live steer. The
 * entry leaves first so a room that settles while the adapter is still
 * thinking can never also drain the same words as a follow-up turn. Only
 * the HEAD can be lifted: the success path steers and settles items[0], so
 * a request naming a later item must not lift the queue at all (it would
 * steer and delete a different message's words). The caller must either
 * restore the held queue or settle its head. */
export function holdChannelQueue(groupId: string, threadId: string, queueId: string): HeldChannelQueue | null {
  const entry = queues.get(threadId);
  if (!entry || entry.groupId !== groupId || entry.items[0]?.id !== queueId) return null;
  queues.delete(threadId);
  changed();
  return { groupId, threadId, items: entry.items };
}

/** Put a held queue back after the steer was refused. Words queued while the
 * hold was open keep their place behind the restored items. */
export function restoreHeldChannelQueue(held: HeldChannelQueue): void {
  const existing = queues.get(held.threadId);
  if (existing && existing.groupId !== held.groupId) throw new Error("queued task belongs to another channel");
  queues.set(held.threadId, {
    groupId: held.groupId,
    items: existing ? [...held.items, ...existing.items] : held.items,
  });
  changed();
}

/** Resolve the held head's reply target through a caller-supplied resolver.
 * The queue is already lifted out of the map here, so a target that cannot
 * be resolved (missing, non-text, empty — state drift between queueing and
 * the steer) must not strand the held words outside it until restart:
 * restore first, then let the error propagate to the request. */
export function resolveHeldReplyTarget<T>(
  held: HeldChannelQueue,
  resolve: (threadId: string, replyToId: string) => T,
): T | undefined {
  const head = held.items[0];
  if (!head?.replyToId) return undefined;
  try {
    return resolve(held.threadId, head.replyToId);
  } catch (error) {
    restoreHeldChannelQueue(held);
    throw error;
  }
}

/** Mark a held queue's head delivered — its words were folded into the
 * running turn — and re-queue the rest for the room's normal one-at-a-time
 * drain. A restart must not replay the steered head as a fresh follow-up. */
export function settleHeldChannelQueueHead(held: HeldChannelQueue): void {
  const [head, ...rest] = held.items;
  settleChatFollowups([head.id], null);
  if (rest.length === 0) return;
  const existing = queues.get(held.threadId);
  if (existing && existing.groupId !== held.groupId) throw new Error("queued task belongs to another channel");
  queues.set(held.threadId, {
    groupId: held.groupId,
    items: existing ? [...rest, ...existing.items] : rest,
  });
  changed();
}

/**
 * Start at most one follow-up per idle channel. Starting it synchronously
 * marks the channel working again; its completion calls this drain for the
 * next item. Removing first makes repeated settle notifications harmless.
 */
export function drainChannelMessages(
  isWorking: (groupId: string) => boolean,
  run: (input: ChannelQueueItem & { groupId: string; threadId: string }) => void | Promise<void>,
): void {
  for (const [threadId, entry] of queues) {
    if (isWorking(entry.groupId)) continue;
    const item = entry.items[0];
    if (!item) {
      queues.delete(threadId);
      continue;
    }
    settleChatFollowups([item.id], "dispatching");
    entry.items.shift();
    if (entry.items.length === 0) queues.delete(threadId);
    changed();
    const running = run({ ...item, groupId: entry.groupId, threadId });
    void Promise.resolve(running).then(
      () => settleChatFollowups([item.id], null),
      () => settleChatFollowups([item.id], "interrupted"),
    ).catch((error) => console.warn("channel-queue: could not settle durable follow-up", error));
  }
}

/** Sends waiting behind a room thread's current turn. */
export function queuedChannelCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}

/** Test helper. */
export const _queuedChannelCount = queuedChannelCount;

const UNDELIVERED_SNIPPET_CHARS = 80;

/** Transcript text for a queued channel message that reached the head of the
 * drain after its room or task stopped owning the thread. */
export function undeliveredChannelMessageNotice(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const snippet = flat.length > UNDELIVERED_SNIPPET_CHARS
    ? `${flat.slice(0, UNDELIVERED_SNIPPET_CHARS - 1)}…`
    : flat;
  return `queued message not delivered — this room no longer owns the task: "${snippet}"`;
}

/** A queued message whose room or task no longer owns its thread must not
 * vanish: leave a visible row in the thread, or log when the thread itself
 * is gone (deleted threads have no rows left to write beside). */
export function noteUndeliveredChannelMessage(
  transcript: {
    messagesFor(threadId: string): readonly unknown[];
    appendMessage(threadId: string, message: { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean } }): unknown;
  },
  input: { groupId: string; threadId: string; id: string; text: string },
  log: (message: string) => void = (message) => console.warn(message),
): "noted" | "logged" {
  const notice = undeliveredChannelMessageNotice(input.text);
  if (transcript.messagesFor(input.threadId).length === 0) {
    log(`channel-queue: ${notice} (room ${input.groupId}, queue ${input.id}: thread ${input.threadId} gone)`);
    return "logged";
  }
  transcript.appendMessage(input.threadId, { role: "bot", kind: "activity", tool: { name: notice, ok: false } });
  return "noted";
}
