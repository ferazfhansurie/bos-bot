/** Check-in items: work a bot proposes and waits on the person for. The
 * person's three daily check-ins (morning, afternoon, night) are the only
 * place these surface; everything else stays quiet. Wire form, shared by the
 * server store, the desktop today screen, the chat card and the phone. */

export type CheckinKind = "did" | "broke" | "decide" | "tonight";
export const CHECKIN_KINDS: readonly CheckinKind[] = ["did", "broke", "decide", "tonight"];

export type CheckinOutcome = "pending" | "approved" | "done" | "not-now" | "no";

export type CheckinSourceType = "thread" | "routine" | "commit" | "app" | "url";

/** Where an item came from. Every item has at least one, so the person can
 * trace it; an item that cannot name its source is refused. */
export interface CheckinSource {
  type: CheckinSourceType;
  /** thread id, routine id, commit sha, app id, or the url itself */
  ref: string;
  url?: string;
  label?: string;
  /** owning bot of a thread source, when it is not the proposing bot */
  botId?: string;
}

export type CheckinSlot = "morning" | "afternoon" | "night";

export interface CheckinItem {
  id: string;
  botId: string;
  kind: CheckinKind;
  title: string;
  why: string;
  sources: CheckinSource[];
  /** A message the bot drafted for the person to send or approve. */
  draft?: string;
  /** What the bot will do on approve, in its own words. */
  plan?: string;
  /** The proposer's fingerprint of the source's current state. Same source +
   * same state is the same item; a changed state may surface again. */
  stateHash: string;
  sourceKey: string;
  createdAt: number;
  updatedAt: number;
  /** When it was last put in front of the person. */
  surfacedAt?: number;
  outcome: CheckinOutcome;
  /** not-now: back at this time (next 9am). */
  snoozedUntil?: number;
  /** approve: the fresh thread started on the owning bot. */
  threadId?: string;
  /** Why it left the list without the person deciding, e.g. "owner replied". */
  resolvedBy?: string;
  decidedAt?: number;
  /** The check-in run (thread) that proposed it. */
  proposedInThreadId?: string;
}

export interface CheckinCounts {
  later: number;
  done: number;
  no: number;
}

export interface CheckinsSnapshot {
  items: CheckinItem[];
  counts: CheckinCounts;
  /** Check-in routines exist for the chief bot. */
  setUp: boolean;
  chiefBotId?: string;
  slots: CheckinSlot[];
}

export type CheckinAction = "approve" | "done" | "not-now" | "no";

/** The bot that owns the work behind an item: the bot of its first thread
 * source (the chief often proposes for a teammate), else the proposer.
 * Approve starts the fresh thread there; the today list shows its face. */
export function checkinOwnerBotId(item: Pick<CheckinItem, "botId" | "sources">): string {
  return item.sources.find((source) => source.type === "thread" && source.botId)?.botId ?? item.botId;
}
