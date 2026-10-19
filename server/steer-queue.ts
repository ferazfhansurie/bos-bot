import { assertQueueAttachmentsUnchanged } from "./queue-edit.ts";
// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts separated by a blank line.
//
// The durable queue is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. Restart restores only sends
// whose dispatch has not begun. The composer shows a pending chip
// until drain appends the words.
//
// Stop preserves the words and pauses their durable queue until explicit resume.

import { newId } from "./contracts.ts";
import { chatQueuePaused, setChatQueuePaused, chatFollowups, editChatFollowup, reorderChatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  projectBotForTask?(botId: string, threadId: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  /** Keep ownership pinned even when the selected task changes. */
  botId: string;
  items: Array<{
    messageId: string;
    text: string;
    prompt: string;
    replyToId?: string;
    sendId?: string;
    reason?: "capacity";
    deferUntilIdle?: boolean;
    /** The words were queued by a bot already running unattended (a
     * thread it opened on itself). The drained turn must inherit that:
     * a queue is a delay, not a person sitting down at the keyboard. */
    unattended?: boolean;
    peerAsk?: Message["peerAsk"];
    /** A send spoken on a live voice call keeps its call through the wait. */
    origin?: Message["origin"];
    /** A paired person's send keeps their name through the wait. */
    sender?: Message["sender"];
  }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

/** A thread's queue lifted out of the map while a live steer is attempted. */
export interface HeldSteerQueue {
  originalOrder?: string[];
  botId: string;
  threadId: string;
  items: QueueEntry["items"];
}

export function restoreSteeredMessages(): void {
  queues.clear();
  for (const row of chatFollowups("bot")) {
    if (row.status !== "pending") continue;
    const entry = queues.get(row.threadId) ?? { botId: row.ownerId, items: [] };
    if (entry.botId !== row.ownerId) throw new Error("queued task belongs to another bot");
    entry.items.push({ ...row.payload, messageId: row.id, prompt: row.payload.prompt ?? row.payload.text });
    queues.set(row.threadId, entry);
  }
}
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) {
    try { listener(); }
    catch { console.warn("steer-queue: change listener failed"); }
  }
};

/** Public pending chips only: never expose provider prompts or reply context. */
export function queuedSteerSnapshot(ownsThread: (botId: string, threadId: string) => boolean):
  Record<string, Array<{ queueId: string; text: string; paused?: boolean; reason?: "capacity" }>> {
  return Object.fromEntries([...queues]
    .filter(([threadId, entry]) => ownsThread(entry.botId, threadId))
    .map(([threadId, entry]) => [threadId, entry.items.map((item) => ({
      queueId: item.messageId, text: item.text, ...(chatQueuePaused("bot", entry.botId, threadId) ? { paused: true } : {}), ...(item.reason ? { reason: item.reason } : {}),
    }))]));
}

/** Publish changes synchronously so every client can restore/cancel the queue. */
export function onSteeredQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface QueuedSteer {
  id: string;
  /** A duplicate send joined this already-waiting item. */
  joined?: boolean;
}

/** Hold a mid-turn send off the transcript until drain. */
/** Matcher for a duplicate attachment-bearing send: same words and tags,
 * whitespace aside. Null for plain text, where repeats can be deliberate. */
export function sameAttachedSend(text: string): ((other: string) => boolean) | null {
  if (!/<attached-(image|file)[\t ]/.test(text)) return null;
  const fold = (value: string) => value.replace(/\s+/g, " ").trim();
  const key = fold(text);
  return (other) => fold(other) === key;
}

export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string; reason?: "capacity"; deferUntilIdle?: boolean; unattended?: boolean; peerAsk?: Message["peerAsk"]; origin?: Message["origin"]; sender?: Message["sender"] } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  // A thread cannot legitimately change owners. Refuse to merge unrelated
  // queues even if a corrupt caller reuses a thread id.
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  // One send = one item: a second send of the same attachment-bearing text
  // (only the blank lines differ, e.g. re-sent from a one-line chip) while
  // the first still waits joins it instead of delivering the image twice.
  const same = sameAttachedSend(text);
  const pending = same && !options.unattended && !options.peerAsk
    && entry.items.find((queued) => same(queued.text) && !queued.unattended && !queued.peerAsk && queued.replyToId === options.replyToId);
  if (pending) return { id: pending.messageId, joined: true };
  const item = {
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    reason: options.reason,
    deferUntilIdle: options.deferUntilIdle,
    unattended: options.unattended,
    peerAsk: options.peerAsk,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.sender ? { sender: options.sender } : {}),
  };
  saveChatFollowup({ id, kind: "bot", ownerId: botId, threadId, payload: item });
  entry.items.push(item);
  queues.set(threadId, entry);
  changed();
  return { id };
}

/** Synchronous map + disk compare; held queues are deliberately unavailable. */
export function editSteeredMessage(botId: string, threadId: string, queueId: string,
  expectedText: string, text: string, makePrompt?: (replyToId?: string) => string): boolean {
  const entry = queues.get(threadId);
  const item = entry?.botId === botId ? entry.items.find(item => item.messageId === queueId) : undefined;
  if (!item || item.unattended || item.peerAsk || (item.text !== expectedText && item.text !== text)) return false;
  assertQueueAttachmentsUnchanged(item.text, text);
  const next = { ...item, text, prompt: item.text === text ? item.prompt : makePrompt ? makePrompt(item.replyToId) : text };
  if (!editChatFollowup("bot", botId, threadId, queueId, item, next)) return false;
  Object.assign(item, next);
  changed();
  return true;
}

/** Put a thread's waiting sends in the person's order. `order` must name
 * every waiting item exactly once; a queue that changed meanwhile refuses.
 * Durable first, so a restart restores the same order. */
export function reorderSteeredMessages(botId: string, threadId: string, order: string[]): boolean {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return false;
  const byId = new Map(entry.items.map((item) => [item.messageId, item]));
  if (order.length !== entry.items.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) return false;
  if (!reorderChatFollowups("bot", botId, threadId, order)) return false;
  entry.items = order.map((id) => byId.get(id)!);
  changed();
  return true;
}

/** Where a thread stands among this bot's threads waiting for a free slot:
 * 1 for the next to start. The drain visits queues in insertion order, so
 * insertion order is the line. Null when nothing of this bot's is waiting
 * on that thread. */
export function queuedThreadPosition(botId: string, threadId: string): number | null {
  let position = 0;
  for (const [candidate, entry] of queues) {
    if (entry.botId !== botId || !entry.items.some((item) => item.reason === "capacity")) continue;
    position += 1;
    if (candidate === threadId) return position;
  }
  return null;
}

/** Any queued correction supersedes a tool-planned continuation, whether it
 * waits for this thread's turn or for the bot's shared capacity. */
export function hasQueuedSteeredMessages(botId: string, threadId: string): boolean {
  const entry = queues.get(threadId);
  return entry?.botId === botId && entry.items.length > 0;
}

/** Drain every queue whose task is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts separated by a blank line. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * Entries leave the map BEFORE running so a settle racing another settle
 * can never fire the same queue twice. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
    unattended: boolean,
  ) => void | Promise<void>,
  isBlocked?: (botId: string, threadId: string) => boolean,
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.projectBotForTask
      ? store.projectBotForTask(entry.botId, threadId)
      : store.bot(entry.botId);
    if (!bot) {
      // the bot or task was deleted while messages waited
      settleChatFollowups(entry.items.map((item) => item.messageId), "cancelled");
      queues.delete(threadId);
      changed();
      continue;
    }
    if (chatQueuePaused("bot", entry.botId, threadId) || bot.busy || isBlocked?.(entry.botId, threadId)) continue;
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    const ids = entry.items.map((item) => item.messageId);
    settleChatFollowups(ids, "dispatching");
    queues.delete(threadId);
    changed();
    const appended: Message[] = [];
    for (const item of entry.items) {
      // queueId is the pending-chip identity from the 202; append still
      // assigns a fresh transcript id so replay/exclude keep using message.id.
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          ...(item.origin ? { origin: item.origin } : {}),
          ...(item.sender ? { sender: item.sender } : {}),
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    // Keep each queued message on its own Markdown block boundary. A single
    // newline can merge a trailing standalone attachment tag with the next
    // message into one HTML block, which makes that attachment stop being a
    // native image when the combined follow-up is dispatched.
    const prompt = entry.items.map((item) => item.prompt).join("\n\n");
    const running = run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
      // one unattended line makes the whole drained turn unattended: a
      // person's words in the same queue cannot re-attend a bot's own
      entry.items.some((item) => item.unattended === true),
    );
    void Promise.resolve(running).then(
      () => settleChatFollowups(ids, null),
      () => settleChatFollowups(ids, "interrupted"),
    ).catch((error) => console.warn("steer-queue: could not settle durable follow-up", error));
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string; reason?: "capacity" } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId, ...(item.reason ? { reason: item.reason } : {}) } : null;
}

/** Drop one waiting send owned by this bot so it never drains. The queue id
 * is stable even if the bot switches away from the task while the request is
 * in flight. Returns false when it was already drained, belongs to another
 * bot, or dispatch has already started. */
export function cancelSteeredMessage(botId: string, messageId: string, expectedThreadId?: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId || (expectedThreadId !== undefined && threadId !== expectedThreadId)) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    settleChatFollowups([messageId], "cancelled");
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    changed();
    return true;
  }
  return false;
}

/** Atomically lift a thread's whole queue out of the map for a live steer.
 * The entry leaves first so a settle that starts draining while the adapter
 * is still thinking can never also dispatch the same words as a follow-up
 * turn. The caller must either restore the held queue or settle its rows. */
export function holdSteeredQueue(botId: string, threadId: string, queueId: string, onlyThis = false): HeldSteerQueue | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId || !entry.items.some((item) => item.messageId === queueId)) return null;
  const items = onlyThis ? entry.items.filter(item => item.messageId === queueId) : entry.items;
  const rest = entry.items.filter(item => !items.includes(item));
  if (rest.length) queues.set(threadId, { botId, items: rest });
  else queues.delete(threadId);
  changed();
  return { botId, threadId, items, ...(onlyThis ? { originalOrder: entry.items.map(item => item.messageId) } : {}) };
}

/** Put a held queue back after the steer was refused. Words queued while the
 * hold was open keep their place behind the restored items. */
export function restoreHeldSteeredQueue(held: HeldSteerQueue): void {
  const existing = queues.get(held.threadId);
  if (existing && existing.botId !== held.botId) throw new Error("queued task belongs to another bot");
  const items = existing ? [...held.items, ...existing.items] : held.items;
  if (held.originalOrder) {
    const order = new Map(held.originalOrder.map((id, i) => [id, i]));
    items.sort((a, b) => (order.get(a.messageId) ?? Infinity) - (order.get(b.messageId) ?? Infinity));
  }
  queues.set(held.threadId, {
    botId: held.botId,
    items,
  });
  changed();
}

/** Mark a held queue's durable rows delivered: the words were folded into the
 * running turn, so a restart must not replay them as a fresh follow-up. */
export function settleHeldSteeredQueue(held: HeldSteerQueue): void {
  settleChatFollowups(held.items.map((item) => item.messageId), null);
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}

/** Default queued sends never enter a running provider at a tool boundary. */
export function steerQueueWaitsForTurn(botId: string, threadId: string): boolean {
  const entry = queues.get(threadId);
  return chatQueuePaused("bot", botId, threadId) || (entry?.botId === botId && entry.items[0]?.deferUntilIdle === true);
}

export function setSteeredQueuePaused(botId: string, threadId: string, paused: boolean): void {
  setChatQueuePaused("bot", botId, threadId, paused);
  changed();
}
