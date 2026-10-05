// Needs-me and the daily digest.
//
// The inbox is every open conversation that is waiting on the person: a
// bot blocked on an approval, a card nobody answered, a run that failed, or
// a reply not yet read. One row per conversation, the most urgent reason
// wins. The digest is what moved in a window: threads started, turns that
// finished or failed, threads that closed.
//
// Pure on purpose: the harness (server/index.ts) gathers each thread's live
// signals and a bounded tail of its transcript, and these functions decide.
import type { DigestMove, DigestResponse, InboxItem, OptionCardData, TaskClosedBy } from "../shared/wire.ts";
import { parseChoices } from "../shared/ask-question.ts";
import { summarize } from "./notify.ts";

/** The slice of a transcript line these rules read. */
export interface NeedsMeMessage {
  id: string;
  at: number;
  role: "bot" | "user";
  kind: string;
  text?: string;
  card?: Pick<OptionCardData, "title" | "subtitle" | "answered" | "dismissed"> &
    Partial<Pick<OptionCardData, "options" | "requestId" | "tool" | "skillRequest" | "routineRequest" | "profileRequest" | "teamSetupRequest" | "questionRequest">>;
  tool?: { name: string; ok?: boolean };
  turnTerminal?: boolean;
  turnOutcome?: { ok: boolean; stopReason?: string };
}

/** One conversation as the harness sees it right now. */
export interface NeedsMeThread {
  botId: string;
  groupId?: string;
  threadId: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  closedBy?: TaskClosedBy;
  archived: boolean;
  unread: boolean;
  /** the person cleared a failure from needs-me at this time */
  failureAckedAt?: number;
  /** a live provider ask is parked on the person */
  waiting: boolean;
  /** a turn is running or queued; an old failure is not news while it is */
  working: boolean;
  /** newest messages, oldest first; a bounded tail is enough */
  messages: readonly NeedsMeMessage[];
}

const PREVIEW_CHARS = 140;

export function pendingCard(messages: readonly NeedsMeMessage[]): NeedsMeMessage | undefined {
  return messages.findLast((message) => message.card && !message.card.answered && !message.card.dismissed);
}

/** A failed turn the person has not moved past: the newest settled turn
 * failed and nobody has spoken since. */
export function failedTurn(messages: readonly NeedsMeMessage[]): NeedsMeMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user") return undefined;
    if (message.turnTerminal) return message.turnOutcome?.ok === false ? message : undefined;
  }
  return undefined;
}

const cardPreview = (card: NonNullable<NeedsMeMessage["card"]>) =>
  summarize([card.title, card.subtitle].filter(Boolean).join(" — "), PREVIEW_CHARS);

const messagePreview = (message: NeedsMeMessage) =>
  summarize(message.text || message.tool?.name || "", PREVIEW_CHARS);

const INLINE_OPTIONS = 6;

/** What needs-me may offer to answer a card in place. Only the two plain
 * shapes: a tool approval (allow/deny) and a question with written choices.
 * Proposals (skills, routines, profiles, team setup) and multi-question sets
 * need their full card, so the row only opens the thread. A room's own
 * (non-live) card has no answer path outside the room either. */
function cardAnswer(message: NeedsMeMessage, inRoom: boolean): Pick<InboxItem, "messageId" | "requestId" | "approval" | "options"> {
  const card = message.card!;
  const live = card.requestId ? { requestId: card.requestId } : {};
  const base = { messageId: message.id, ...live };
  if (card.skillRequest || card.routineRequest || card.profileRequest || card.teamSetupRequest || card.questionRequest) return base;
  if (card.tool) return card.requestId ? { ...base, approval: true } : base;
  if (!card.requestId && inRoom) return base;
  const options = parseChoices(card.options, INLINE_OPTIONS);
  return options?.length ? { ...base, options } : base;
}

/** The one inbox row a conversation earns, or null when it needs nothing. */
export function inboxItemFor(thread: NeedsMeThread): InboxItem | null {
  if (thread.closedBy || thread.archived) return null;
  const base = { botId: thread.botId, ...(thread.groupId ? { groupId: thread.groupId } : {}), threadId: thread.threadId, title: thread.title };
  const card = pendingCard(thread.messages);
  const answer = card?.card ? cardAnswer(card, Boolean(thread.groupId)) : {};
  if (thread.waiting) {
    return { id: `waiting-on-you:${thread.threadId}`, kind: "waiting-on-you", ...base,
      preview: card?.card ? cardPreview(card.card) : "Waiting on you", at: card?.at ?? thread.lastActivityAt,
      // the ask that is parked is the live one; an older plain card waits its turn
      ...(answer.requestId ? answer : {}) };
  }
  if (card?.card) {
    return { id: `question:${thread.threadId}`, kind: "question", ...base, preview: cardPreview(card.card), at: card.at, ...answer };
  }
  const failed = thread.working ? undefined : failedTurn(thread.messages);
  // cleared from needs-me: only a newer failure is news again
  if (failed && !(thread.failureAckedAt !== undefined && thread.failureAckedAt >= failed.at)) {
    return { id: `failed:${thread.threadId}`, kind: "failed", ...base,
      preview: summarize(failed.turnOutcome?.stopReason || messagePreview(failed) || "The run failed", PREVIEW_CHARS), at: failed.at };
  }
  if (thread.unread) {
    const reply = thread.messages.findLast((message) => message.role === "bot" && message.kind === "text" && message.text);
    return { id: `unread:${thread.threadId}`, kind: "unread", ...base,
      preview: reply ? messagePreview(reply) : "", at: reply?.at ?? thread.lastActivityAt };
  }
  return null;
}

export function buildInbox(threads: Iterable<NeedsMeThread>): { items: InboxItem[]; count: number } {
  const items: InboxItem[] = [];
  for (const thread of threads) {
    const item = inboxItemFor(thread);
    if (item) items.push(item);
  }
  items.sort((a, b) => b.at - a.at);
  return { items, count: items.length };
}

/** A row clearing can settle: an unread reply, a failed run, or a card
 * nobody is blocked on. A live ask is only settled by answering it —
 * clearing must never allow, deny or answer on the person's behalf. */
export function inboxItemClearable(item: InboxItem): boolean {
  return item.kind !== "waiting-on-you" && !item.requestId;
}

/** The rows a clear names (every row when `ids` is absent), split into what
 * clearing settles and what it keeps. Ids the viewer cannot see match
 * nothing, so a scoped viewer can only clear its own rows. */
export function partitionInboxClear(items: readonly InboxItem[], ids?: readonly string[]): { clear: InboxItem[]; kept: InboxItem[] } {
  const named = ids ? new Set(ids) : null;
  const clear: InboxItem[] = [];
  const kept: InboxItem[] = [];
  for (const item of items) {
    if (named && !named.has(item.id)) continue;
    (inboxItemClearable(item) ? clear : kept).push(item);
  }
  return { clear, kept };
}

/** What one conversation did inside [since, until]. A thread can start and
 * finish in the same window; its newest settled turn decides done or failed. */
export function digestMovesFor(thread: NeedsMeThread, since: number, until: number): DigestMove[] {
  const within = (at: number) => at >= since && at <= until;
  const base = { botId: thread.botId, ...(thread.groupId ? { groupId: thread.groupId } : {}), threadId: thread.threadId, title: thread.title };
  const moves: DigestMove[] = [];
  if (within(thread.createdAt)) {
    const ask = thread.messages.find((message) => message.role === "user" && message.text && message.at >= thread.createdAt);
    moves.push({ ...base, change: "started", summary: ask ? messagePreview(ask) : thread.title, at: thread.createdAt });
  }
  const settled = thread.messages.findLast((message) => message.turnTerminal && within(message.at));
  if (settled) {
    const failed = settled.turnOutcome?.ok === false;
    moves.push({ ...base, change: failed ? "failed" : "done",
      summary: failed ? summarize(settled.turnOutcome?.stopReason || messagePreview(settled), PREVIEW_CHARS) : messagePreview(settled),
      at: settled.at });
  }
  if (thread.closedBy && within(thread.closedBy.at)) {
    moves.push({ ...base, change: "closed", summary: `Closed by ${thread.closedBy.name}`, at: thread.closedBy.at });
  }
  return moves;
}

export function buildDigest(threads: Iterable<NeedsMeThread>, since: number, until: number, waiting: number): DigestResponse {
  const moved: DigestMove[] = [];
  for (const thread of threads) moved.push(...digestMovesFor(thread, since, until));
  moved.sort((a, b) => b.at - a.at);
  const counts = { done: 0, started: 0, closed: 0, failed: 0, waiting };
  for (const move of moved) counts[move.change] += 1;
  return { since, until, counts, moved };
}

/** One line for the lock screen. */
export function digestNotificationBody(digest: DigestResponse): string {
  const { counts } = digest;
  const parts = [
    counts.done && `${counts.done} done`,
    counts.started && `${counts.started} started`,
    counts.failed && `${counts.failed} failed`,
    counts.closed && `${counts.closed} closed`,
  ].filter(Boolean);
  const waiting = counts.waiting ? `${counts.waiting} waiting on you` : "nothing waiting on you";
  return parts.length ? `${parts.join(", ")} · ${waiting}` : `Quiet day · ${waiting}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day, as the persisted last-sent marker stores it. */
export function localDateKey(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The digest goes out once per local day, at or after `hour`. A restart
 * after it went out today finds today's key and stays quiet. */
export function digestDue(now: Date, hour: number, lastSentDate: string | null): boolean {
  return now.getHours() >= hour && lastSentDate !== localDateKey(now);
}
