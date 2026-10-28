// Initiative: the one grounded nudge a bot may add to a turn.
//
// A bot that "checks in proactively" is not a loop scanning the person's
// apps. It is three plain things: a standing rule for when to offer
// something (INITIATIVE_PROMPT in system-prompt.ts), routines that may end
// a run in silence, and signals the server can see but the model cannot.
// This module is the signals half. The first and strongest signal is a
// repeat: the same manual ask arriving on a second or third day is the
// moment to offer a routine, naming the repeat so the person can trace it.
//
// The budget keeps it from turning into nagging: at most one nudge per bot
// every few hours, the same ask never re-offered for two weeks, and a bot
// whose last three offers went nowhere goes quiet for a month.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export interface PastAsk {
  at: number;
  text: string;
}

export interface RepeatSignal {
  /** Stable key for the ask, so the same repeat is offered only once. */
  key: string;
  /** Earlier days (newest first) the person asked for something like this. */
  earlier: PastAsk[];
}

/** Earlier days needed before a repeat counts: this one plus two before. */
export const REPEAT_MIN_EARLIER_DAYS = 2;
/** How far back a repeat is looked for. */
export const REPEAT_WINDOW_MS = 21 * 24 * 60 * 60_000;
/** One nudge per bot in this window. */
export const NUDGE_COOLDOWN_MS = 5 * 60 * 60_000;
/** The same ask is not offered again inside this window. */
export const SAME_ASK_QUIET_MS = 14 * 24 * 60 * 60_000;
/** Offers in a row that went nowhere before the bot goes quiet. */
export const IGNORED_LIMIT = 3;
export const IGNORED_MUTE_MS = 30 * 24 * 60 * 60_000;

const SIMILARITY = 0.5;
const MIN_SHARED = 2;
const MAX_ASK_CHARS = 600;

const STOP = new Set(
  ("the and for you your yours can could would should please pls plz with that this these those from into onto " +
    "what when where which who how why are was were been being have has had our ours mine just also then than " +
    "there their them they its it's about again now today yesterday tomorrow some any all more most other " +
    "want need make help check look see get got give let lets let's tell know think like really very much " +
    "yes yeah yep okay ok hey hi yo thanks thank sure not dont don't cant can't im i'm ill i'll ive i've me my " +
    // reactions are not asks: "nice good job" and "still same" repeat daily
    "nice good great amazing job well done work works worked fixed still same nah nope why")
    .split(" "),
);

/** Lowercased content words, stripped of filler, deduplicated. */
export function askTokens(text: string): Set<string> {
  const words = text
    .slice(0, MAX_ASK_CHARS)
    .toLowerCase()
    // attachment tags and paths carry the same words on every message that
    // has a screenshot, so two unrelated asks would look like a repeat
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)[~.]?\/\S+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word));
  return new Set(words);
}

function similar(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  if (shared < MIN_SHARED) return false;
  return shared / (a.size + b.size - shared) >= SIMILARITY;
}

const dayOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** The repeat behind `text`, or null. Only asks from earlier days count, at
 * most one per day, so a burst of follow-ups in one sitting is not a habit.
 * An ask a standing routine already covers is not a repeat to offer. */
export function findRepeat(
  text: string,
  history: readonly PastAsk[],
  now: number,
  routinePrompts: readonly string[] = [],
): RepeatSignal | null {
  const tokens = askTokens(text);
  if (tokens.size < MIN_SHARED) return null;
  if (routinePrompts.some((prompt) => similar(tokens, askTokens(prompt)))) return null;
  const today = dayOf(now);
  const byDay = new Map<string, PastAsk>();
  for (const ask of history) {
    if (now - ask.at > REPEAT_WINDOW_MS || ask.at > now) continue;
    const day = dayOf(ask.at);
    if (day === today || byDay.has(day)) continue;
    if (similar(tokens, askTokens(ask.text))) byDay.set(day, ask);
  }
  if (byDay.size < REPEAT_MIN_EARLIER_DAYS) return null;
  const earlier = [...byDay.values()].sort((a, b) => b.at - a.at);
  return { key: [...tokens].sort().slice(0, 8).join(" "), earlier };
}

export interface NudgeLedger {
  /** When the last nudge was offered. */
  lastAt?: number;
  /** Routine count at the last offer, to tell later whether it was taken. */
  routinesAtLast?: number;
  /** Offers in a row that ended with no new routine. */
  ignored: number;
  mutedUntil?: number;
  /** ask key → when it was offered */
  offered: Record<string, number>;
  /** Check-in item kinds the person keeps saying no to. */
  kinds?: Record<string, KindLedger>;
  /** When this bot was first offered the daily check-ins, so it is offered once. */
  checkinOfferedAt?: number;
}

export interface KindLedger {
  /** No's since the last yes; a check-in item left untouched counts half. */
  no: number;
  mutedUntil?: number;
}

/** Three no's on one kind of check-in item and the bot stops proposing that
 * kind for two weeks. A yes clears the count, so it is no's in a row. */
export const CHECKIN_NO_LIMIT = 3;
export const CHECKIN_MUTE_MS = 14 * 24 * 60 * 60_000;

export function kindMuted(ledger: NudgeLedger, kind: string, now: number): boolean {
  const until = ledger.kinds?.[kind]?.mutedUntil;
  return until != null && now < until;
}

/** Fold the person's answer to one check-in item into the bot's ledger. */
export function recordKindAnswer(
  ledger: NudgeLedger,
  kind: string,
  answer: "yes" | "no" | "ignored",
  now: number,
): NudgeLedger {
  const kinds = { ...(ledger.kinds ?? {}) };
  const current: KindLedger = { ...(kinds[kind] ?? { no: 0 }) };
  if (current.mutedUntil != null && now >= current.mutedUntil) delete current.mutedUntil;
  if (answer === "yes") current.no = 0;
  else current.no += answer === "no" ? 1 : 0.5;
  if (current.no >= CHECKIN_NO_LIMIT) {
    current.mutedUntil = now + CHECKIN_MUTE_MS;
    current.no = 0;
  }
  kinds[kind] = current;
  return { ...ledger, kinds };
}

export const emptyLedger = (): NudgeLedger => ({ ignored: 0, offered: {} });

/** Whether a nudge may be offered now, after settling the previous one: an
 * offer followed by no new routine counts as waved off. Returns the updated
 * ledger either way, since settling is a write the caller keeps. */
export function admitNudge(
  ledger: NudgeLedger,
  key: string,
  now: number,
  routineCount: number,
): { allowed: boolean; ledger: NudgeLedger } {
  const next: NudgeLedger = { ...ledger, offered: { ...ledger.offered } };
  for (const [k, at] of Object.entries(next.offered)) if (now - at > SAME_ASK_QUIET_MS) delete next.offered[k];
  if (next.lastAt != null && next.routinesAtLast != null && now - next.lastAt >= NUDGE_COOLDOWN_MS) {
    next.ignored = routineCount > next.routinesAtLast ? 0 : next.ignored + 1;
    next.routinesAtLast = undefined;
    if (next.ignored >= IGNORED_LIMIT) {
      next.mutedUntil = now + IGNORED_MUTE_MS;
      next.ignored = 0;
    }
  }
  const allowed =
    !(next.mutedUntil != null && now < next.mutedUntil) &&
    !(next.lastAt != null && now - next.lastAt < NUDGE_COOLDOWN_MS) &&
    next.offered[key] == null;
  return { allowed, ledger: next };
}

export function recordNudge(ledger: NudgeLedger, key: string, now: number, routineCount: number): NudgeLedger {
  return { ...ledger, lastAt: now, routinesAtLast: routineCount, offered: { ...ledger.offered, [key]: now } };
}

const fold = (text: string, max: number) => {
  const folded = text.replace(/\s+/g, " ").trim();
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
};

const shortDay = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The prompt block for a repeat. Written as a signal the bot may use, not
 * an order: it still decides whether the offer fits this turn. */
export function repeatSignalPrompt(signal: RepeatSignal): string {
  const seen = signal.earlier
    .slice(0, 3)
    .map((ask) => `${shortDay(ask.at)} (${JSON.stringify(fold(ask.text, 80))})`)
    .join(", ");
  return (
    ` Initiative signal: the person has asked for something like this on earlier days too — ${seen}.` +
    " Handle this request first. Then, if it really is the same recurring job, end with one short offer to run it as a" +
    " routine: name the repeat and a sensible time (weekdays in waking hours unless the job says otherwise). Do not create" +
    " it without a yes, and if they pass, drop it. If it is not actually the same job, ignore this signal."
  );
}

/** Per-bot ledgers in one small file beside the rest of the server state. */
export class NudgeLedgers {
  private ledgers: Record<string, NudgeLedger> = {};
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "initiative.json");
    try {
      if (existsSync(this.path)) this.ledgers = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, NudgeLedger>;
    } catch {
      this.ledgers = {};
    }
  }

  get(botId: string): NudgeLedger {
    return this.ledgers[botId] ?? emptyLedger();
  }

  set(botId: string, ledger: NudgeLedger): void {
    this.ledgers[botId] = ledger;
    this.save();
  }

  forget(botId: string): void {
    if (!(botId in this.ledgers)) return;
    delete this.ledgers[botId];
    this.save();
  }

  private save(): void {
    try {
      writeFileAtomic(this.path, JSON.stringify(this.ledgers), { mode: 0o600 });
    } catch (error) {
      console.warn(`initiative ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
