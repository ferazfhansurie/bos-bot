// Check-ins: the few things a bot proposes that wait on the person.
//
// The person stops prompting. Three times a day the chief bot looks at what
// changed and proposes at most three items: something it did, something that
// broke, a decision, or tonight's plan. Each item names its source and the
// work it will do on a yes. The person taps approve, not now or no, and that
// is the only direction they give.
//
// This module is the store and its rules, kept free of the server so it can
// be tested on its own:
// - an item without a traceable source is refused;
// - the same source in the same state is the same item (dedupe by source
//   key + state hash), so a check-in never repeats itself;
// - "already handled" resolvers drop an item the moment the world moved on:
//   the person replied in or closed the source thread, the job finished,
//   the routine recovered;
// - a kind the person keeps saying no to is muted (initiative.ts budget).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  CheckinAction,
  CheckinCounts,
  CheckinItem,
  CheckinKind,
  CheckinSource,
  CheckinSourceType,
} from "../shared/checkins.ts";
import { CHECKIN_KINDS } from "../shared/checkins.ts";
import { nextCronRuns } from "../shared/routine-schedule.ts";
import { writeFileAtomic } from "./atomic.ts";

/** One check-in run keeps at most this many; it may draft more and drop the rest. */
export const CHECKIN_MAX_PER_RUN = 3;
/** An item the person never touched leaves after this and counts as half a no. */
export const CHECKIN_IGNORED_MS = 3 * 24 * 60 * 60_000;
/** Settled items are kept this long for dedupe, then dropped. */
const SETTLED_KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_ITEMS = 500;
const SOURCE_TYPES: readonly CheckinSourceType[] = ["thread", "routine", "commit", "app", "url"];

/** What the store needs to know about a thread, read the way the sidebar reads it. */
export interface CheckinThreadView {
  botId: string;
  closed: boolean;
  archived: boolean;
  running: boolean;
  waiting: boolean;
  queued?: boolean;
  /** Last message the person sent there. */
  lastUserMessageAt?: number;
  /** Last reply the bot posted there. */
  lastReplyAt?: number;
}

export interface CheckinRoutineView {
  lastRunStatus?: string;
  lastRunFinishedAt?: number;
}

/** The live world the resolvers check items against. */
export interface CheckinWorld {
  thread(threadId: string): CheckinThreadView | null;
  routine(routineId: string): CheckinRoutineView | null;
}

export interface ProposeInput {
  botId: string;
  kind: unknown;
  title: unknown;
  why: unknown;
  sources: unknown;
  draft?: unknown;
  plan?: unknown;
  stateHash?: unknown;
  /** The check-in run's thread, for the per-run cap. */
  threadId?: string;
}

export type ProposeResult =
  | { ok: true; item: CheckinItem; status: "created" | "updated" | "duplicate" | "resurfaced" }
  | { ok: false; error: string };

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

const block = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

const isKind = (value: unknown): value is CheckinKind =>
  typeof value === "string" && (CHECKIN_KINDS as readonly string[]).includes(value);

const httpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** Validate and normalise the sources a bot names. Thread and routine
 * sources must exist; a commit is a sha; an app or url carries a link. */
export function normalizeSources(value: unknown, world: CheckinWorld): CheckinSource[] | string {
  if (!Array.isArray(value) || value.length === 0) return "name at least one source (thread, routine, commit, app or url) so the person can trace it";
  if (value.length > 5) return "name at most 5 sources";
  const out: CheckinSource[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return "each source needs a type and a ref";
    const source = raw as Record<string, unknown>;
    const type = source.type;
    if (typeof type !== "string" || !(SOURCE_TYPES as readonly string[]).includes(type)) {
      return `source type must be one of ${SOURCE_TYPES.join(", ")}`;
    }
    const ref = text(source.ref, 2000);
    if (!ref) return "each source needs a ref";
    const label = text(source.label, 80) || undefined;
    const url = httpUrl(source.url);
    if (type === "thread") {
      const thread = world.thread(ref);
      if (!thread) return `no thread ${ref}: use a real thread id from list_threads`;
      out.push({ type, ref, botId: thread.botId, ...(label ? { label } : {}) });
    } else if (type === "routine") {
      if (!world.routine(ref)) return `no routine ${ref}: use a real routine id from list_routines`;
      out.push({ type, ref, ...(label ? { label } : {}) });
    } else if (type === "commit") {
      if (!/^[0-9a-f]{7,40}$/i.test(ref)) return "a commit source ref is its sha";
      out.push({ type, ref: ref.toLowerCase(), ...(url ? { url } : {}), ...(label ? { label } : {}) });
    } else if (type === "url") {
      const link = httpUrl(ref);
      if (!link) return "a url source ref must be an http(s) link";
      out.push({ type, ref: link, ...(label ? { label } : {}) });
    } else {
      if (!url) return "an app source needs its link in url";
      out.push({ type: "app", ref, url, ...(label ? { label } : {}) });
    }
  }
  return out;
}

/** Stable key for "the same source": sorted type:ref pairs. */
export function sourceKeyOf(sources: readonly CheckinSource[]): string {
  return [...new Set(sources.map((source) => `${source.type}:${source.ref}`))].sort().join("|");
}

const hashOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Why an item no longer needs the person, or null while it still does. */
export function handledReason(item: CheckinItem, world: CheckinWorld): string | null {
  if (item.outcome === "approved") {
    if (!item.threadId || item.decidedAt == null) return null;
    const thread = world.thread(item.threadId);
    if (!thread) return null;
    if (thread.closed) return "job finished";
    const settled = !thread.running && !thread.waiting && !thread.queued;
    return settled && (thread.lastReplyAt ?? 0) > item.decidedAt ? "job finished" : null;
  }
  if (item.outcome !== "pending" && item.outcome !== "not-now") return null;
  for (const source of item.sources) {
    if (source.type === "thread") {
      const thread = world.thread(source.ref);
      if (!thread) return "source thread gone";
      if (thread.closed) return "thread closed";
      if (thread.archived) return "thread archived";
      if ((thread.lastUserMessageAt ?? 0) > item.createdAt) return "owner replied";
      // A stall or a question moved on by itself: the bot replied after the
      // item was proposed and the thread is no longer waiting on anyone.
      if (
        (item.kind === "broke" || item.kind === "decide") &&
        !thread.running && !thread.waiting && !thread.queued &&
        (thread.lastReplyAt ?? 0) > item.createdAt
      ) {
        return "job finished";
      }
    } else if (source.type === "routine") {
      const routine = world.routine(source.ref);
      if (!routine) return "routine gone";
      if (item.kind === "broke" && routine.lastRunStatus === "completed" && (routine.lastRunFinishedAt ?? 0) > item.createdAt) {
        return "routine recovered";
      }
    }
  }
  return null;
}

/** The next 9am in `timeZone` that falls on a later calendar day than `now`. */
export function nextMorning(now: number, timeZone: string): number {
  const day = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  try {
    const today = day(now);
    const runs = nextCronRuns({ type: "cron", expression: "0 9 * * *", timeZone }, now, 2);
    return runs.find((at) => day(at) !== today) ?? runs.at(-1) ?? now + 24 * 60 * 60_000;
  } catch {
    return now + 24 * 60 * 60_000;
  }
}

/** How a person's answer reads to the kind budget in initiative.ts. */
export function answerFor(action: CheckinAction): "yes" | "no" | null {
  if (action === "approve" || action === "done") return "yes";
  if (action === "no") return "no";
  return null;
}

/** Visible now: waiting on the person and not snoozed. Newest-surfaced order
 * is not what matters; what breaks and what needs a call come first. */
const KIND_RANK: Record<CheckinKind, number> = { broke: 0, decide: 1, tonight: 2, did: 3 };

export function rankItems(items: readonly CheckinItem[]): CheckinItem[] {
  return [...items].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.createdAt - a.createdAt);
}

export class CheckinStore {
  private items: CheckinItem[] = [];
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "checkins.json");
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { items?: CheckinItem[] };
        this.items = Array.isArray(parsed.items) ? parsed.items : [];
      }
    } catch {
      this.items = [];
    }
  }

  all(): CheckinItem[] {
    return this.items.map((item) => ({ ...item, sources: item.sources.map((s) => ({ ...s })) }));
  }

  get(id: string): CheckinItem | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    return item ? { ...item, sources: item.sources.map((s) => ({ ...s })) } : undefined;
  }

  /** Latest change to any item, for the no-model check-in gate. */
  lastChangeAt(): number {
    return this.items.reduce((max, item) => Math.max(max, item.updatedAt), 0);
  }

  propose(input: ProposeInput, world: CheckinWorld, now: number, muted: (kind: CheckinKind) => boolean): ProposeResult {
    if (!isKind(input.kind)) return { ok: false, error: `kind must be one of ${CHECKIN_KINDS.join(", ")}` };
    const kind = input.kind;
    const title = text(input.title, 120);
    if (!title) return { ok: false, error: "give the item a short title" };
    const why = text(input.why, 400);
    if (!why) return { ok: false, error: "say why the person would want to know, in one line" };
    const sources = normalizeSources(input.sources, world);
    if (typeof sources === "string") return { ok: false, error: sources };
    const draft = block(input.draft, 4000);
    const plan = block(input.plan, 4000);
    if ((kind === "decide" || kind === "tonight") && !plan && !draft) {
      return { ok: false, error: "a decide or tonight item needs the plan (or draft) that runs on approve" };
    }
    const sourceKey = sourceKeyOf(sources);
    const stateHash = text(input.stateHash, 200) || hashOf(`${kind}\n${title}\n${why}\n${plan ?? ""}\n${draft ?? ""}`);
    const existing = this.items.find((item) => item.botId === input.botId && item.sourceKey === sourceKey);
    if (existing && existing.stateHash === stateHash) return { ok: true, item: { ...existing }, status: "duplicate" };
    if (muted(kind)) {
      return { ok: false, error: `the person said no to ${kind} items three times, so ${kind} is muted for now. skip it` };
    }
    const open = existing && (existing.outcome === "pending" || existing.outcome === "not-now");
    if (!open && input.threadId) {
      const fromRun = this.items.filter((item) => item.proposedInThreadId === input.threadId).length;
      if (fromRun >= CHECKIN_MAX_PER_RUN) {
        return { ok: false, error: `a check-in keeps at most ${CHECKIN_MAX_PER_RUN} items. keep the best ${CHECKIN_MAX_PER_RUN} and drop the rest` };
      }
    }
    const fields = { kind, title, why, sources, sourceKey, stateHash, draft, plan, updatedAt: now };
    if (existing) {
      const index = this.items.indexOf(existing);
      const next: CheckinItem = open
        ? { ...existing, ...fields }
        : {
            ...existing,
            ...fields,
            outcome: "pending",
            createdAt: now,
            surfacedAt: undefined,
            snoozedUntil: undefined,
            threadId: undefined,
            resolvedBy: undefined,
            decidedAt: undefined,
            proposedInThreadId: input.threadId,
          };
      this.items[index] = stripUndefined(next);
      this.save();
      return { ok: true, item: { ...this.items[index]! }, status: open ? "updated" : "resurfaced" };
    }
    const item = stripUndefined<CheckinItem>({
      id: `ci-${randomUUID().slice(0, 12)}`,
      botId: input.botId,
      ...fields,
      createdAt: now,
      outcome: "pending",
      proposedInThreadId: input.threadId,
    });
    this.items.push(item);
    this.prune(now);
    this.save();
    return { ok: true, item: { ...item }, status: "created" };
  }

  /** Settle what the world already settled, wake snoozed items, expire the
   * ones left untouched. Returns the items whose state changed, with the
   * answer each one feeds the kind budget ("ignored" counts half a no). */
  refresh(world: CheckinWorld, now: number): Array<{ item: CheckinItem; answer?: "ignored" }> {
    const changed: Array<{ item: CheckinItem; answer?: "ignored" }> = [];
    for (let index = 0; index < this.items.length; index += 1) {
      const item = this.items[index]!;
      let next: CheckinItem | null = null;
      let answer: "ignored" | undefined;
      const reason = handledReason(item, world);
      if (reason) {
        next = { ...item, outcome: "done", resolvedBy: reason, updatedAt: now, ...(item.decidedAt == null ? { decidedAt: now } : {}) };
      } else if (item.outcome === "not-now" && (item.snoozedUntil ?? 0) <= now) {
        next = { ...item, outcome: "pending", snoozedUntil: undefined, surfacedAt: undefined, createdAt: now, updatedAt: now };
      } else if (item.outcome === "pending" && now - (item.surfacedAt ?? item.createdAt) > CHECKIN_IGNORED_MS) {
        next = { ...item, outcome: "no", resolvedBy: "ignored", decidedAt: now, updatedAt: now };
        answer = "ignored";
      }
      if (next) {
        this.items[index] = stripUndefined(next);
        changed.push({ item: { ...this.items[index]! }, ...(answer ? { answer } : {}) });
      }
    }
    if (changed.length) this.save();
    return changed;
  }

  /** Items waiting on the person now, ranked. */
  visible(now: number): CheckinItem[] {
    return rankItems(this.items.filter((item) => item.outcome === "pending" || (item.outcome === "not-now" && (item.snoozedUntil ?? 0) <= now)));
  }

  /** Today's tallies for the bottom of the brief. */
  counts(now: number): CheckinCounts {
    const since = now - 24 * 60 * 60_000;
    const recent = (item: CheckinItem) => (item.decidedAt ?? 0) >= since;
    return {
      later: this.items.filter((item) => item.outcome === "not-now" && (item.snoozedUntil ?? 0) > now).length,
      done: this.items.filter((item) => (item.outcome === "done" || item.outcome === "approved") && recent(item)).length,
      no: this.items.filter((item) => item.outcome === "no" && item.resolvedBy !== "ignored" && recent(item)).length,
    };
  }

  /** Stamp the items a check-in just put in front of the person. */
  markSurfaced(ids: readonly string[], now: number): void {
    let dirty = false;
    for (const item of this.items) {
      if (ids.includes(item.id) && item.outcome === "pending" && item.surfacedAt == null) {
        item.surfacedAt = now;
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  /** The person's answer. Approve leaves the thread to the caller, who
   * attaches it with attachThread once it started. */
  act(id: string, action: CheckinAction, now: number, timeZone: string): CheckinItem | string {
    const index = this.items.findIndex((item) => item.id === id);
    const item = this.items[index];
    if (!item) return "that item is gone";
    if (item.outcome !== "pending" && item.outcome !== "not-now") return "already answered";
    let next: CheckinItem;
    if (action === "not-now") next = { ...item, outcome: "not-now", snoozedUntil: nextMorning(now, timeZone), updatedAt: now };
    else if (action === "approve") next = { ...item, outcome: "approved", decidedAt: now, updatedAt: now, snoozedUntil: undefined };
    else if (action === "done") next = { ...item, outcome: "done", resolvedBy: "owner", decidedAt: now, updatedAt: now, snoozedUntil: undefined };
    else next = { ...item, outcome: "no", decidedAt: now, updatedAt: now, snoozedUntil: undefined };
    this.items[index] = stripUndefined(next);
    this.save();
    return { ...this.items[index]! };
  }

  /** Undo an approve whose thread could not start, so the person can try again. */
  reopen(id: string, now: number): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.outcome !== "approved") return;
    item.outcome = "pending";
    delete item.decidedAt;
    item.updatedAt = now;
    this.save();
  }

  attachThread(id: string, threadId: string, now: number): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.threadId = threadId;
    item.updatedAt = now;
    this.save();
  }

  /** The bot itself settles an item (resolve_item): done, or withdrawn. */
  resolve(id: string, botId: string, outcome: "done" | "withdrawn", reason: string, now: number): CheckinItem | string {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return "no such item";
    if (item.botId !== botId) return "only the bot that proposed an item can resolve it";
    if (item.outcome !== "pending" && item.outcome !== "not-now") return "already settled";
    item.outcome = "done";
    item.resolvedBy = text(reason, 120) || (outcome === "withdrawn" ? "withdrawn" : "bot finished it");
    item.decidedAt = now;
    item.updatedAt = now;
    delete item.snoozedUntil;
    this.save();
    return { ...item };
  }

  /** Forget a deleted bot's items. */
  forgetBot(botId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.botId !== botId);
    if (this.items.length !== before) this.save();
  }

  /** Bring a personal check-in ledger (bin/checkin.py's ledger.jsonl) in, so
   * the items the person already answered there are never asked again. */
  importLedger(botId: string, content: string, now: number): { imported: number; skipped: number } {
    const latest = new Map<string, LedgerLine>();
    let skipped = 0;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as LedgerLine;
        if (typeof parsed?.key === "string" && parsed.key) latest.set(parsed.key, parsed);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    let imported = 0;
    for (const entry of latest.values()) {
      const item = ledgerItem(botId, entry, now);
      if (!item) {
        skipped += 1;
        continue;
      }
      const index = this.items.findIndex((candidate) => candidate.botId === botId && candidate.sourceKey === item.sourceKey);
      if (index >= 0) {
        if (this.items[index]!.updatedAt >= item.updatedAt) continue;
        this.items[index] = { ...item, id: this.items[index]!.id };
      } else {
        this.items.push(item);
      }
      imported += 1;
    }
    if (imported) {
      this.prune(now);
      this.save();
    }
    return { imported, skipped };
  }

  private prune(now: number): void {
    const settled = (item: CheckinItem) => item.outcome !== "pending" && item.outcome !== "not-now";
    this.items = this.items.filter((item) => !settled(item) || now - item.updatedAt < SETTLED_KEEP_MS);
    if (this.items.length > MAX_ITEMS) {
      const drop = this.items.filter(settled).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, this.items.length - MAX_ITEMS);
      const gone = new Set(drop.map((item) => item.id));
      this.items = this.items.filter((item) => !gone.has(item.id));
    }
  }

  private save(): void {
    try {
      writeFileAtomic(this.path, JSON.stringify({ version: 1, items: this.items }), { mode: 0o600 });
    } catch (error) {
      console.warn(`check-in store write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function stripUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) if (value[key] === undefined) delete value[key];
  return value;
}

/** One line of bin/checkin.py's ledger.jsonl. */
interface LedgerLine {
  key: string;
  state_hash?: string;
  kind?: string;
  title?: string;
  surfaced_at?: string | number;
  outcome?: string;
  at?: string | number;
  thread?: string;
  note?: string;
}

const LEDGER_KINDS: Record<string, CheckinKind> = {
  did: "did", done: "did", shipped: "did",
  broke: "broke", stall: "broke", failed: "broke", health: "broke",
  decide: "decide", ask: "decide", req: "decide", promise: "decide", parked: "decide",
  tonight: "tonight", plan: "tonight",
};

const LEDGER_OUTCOMES: Record<string, CheckinItem["outcome"]> = {
  yes: "approved", started: "approved", done: "done", no: "no", ignored: "no", later: "not-now",
};

const when = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
};

/** Map a ledger line to a settled item. Candidates and surfaced lines are
 * the personal script's own working state, not answers, so they stay there;
 * whatsapp keys never cross over (check-ins never relay chat content). */
function ledgerItem(botId: string, entry: LedgerLine, now: number): CheckinItem | null {
  const outcome = entry.outcome ? LEDGER_OUTCOMES[entry.outcome] : undefined;
  if (!outcome) return null;
  const [prefix = "", ...rest] = entry.key.split(":");
  if (prefix === "wa") return null;
  const ref = rest.join(":");
  const source: CheckinSource =
    ["thread", "stall", "ask", "done", "open"].includes(prefix) && ref
      ? { type: "thread", ref }
      : ["routine", "run"].includes(prefix) && ref
        ? { type: "routine", ref }
        : { type: "app", ref: entry.key, url: "bos://checkins/ledger", label: "personal check-in ledger" };
  const at = when(entry.at) ?? now;
  const kind = (entry.kind && (LEDGER_KINDS[entry.kind] ?? (isKind(entry.kind) ? entry.kind : undefined))) || LEDGER_KINDS[prefix] || "decide";
  return stripUndefined<CheckinItem>({
    id: `ci-${randomUUID().slice(0, 12)}`,
    botId,
    kind,
    title: text(entry.title, 120) || entry.key,
    why: text(entry.note, 400) || "imported from the personal check-in ledger",
    sources: [source],
    sourceKey: sourceKeyOf([source]),
    stateHash: text(entry.state_hash, 200) || "imported",
    createdAt: at,
    updatedAt: at,
    surfacedAt: when(entry.surfaced_at),
    outcome,
    decidedAt: outcome === "not-now" ? undefined : at,
    snoozedUntil: outcome === "not-now" ? at + 24 * 60 * 60_000 : undefined,
    threadId: entry.thread || undefined,
    resolvedBy: entry.outcome === "ignored" ? "ignored" : outcome === "done" ? "imported" : undefined,
  });
}

/** The cheap no-model gate in front of each check-in run: skip the model
 * when nothing moved since the last check-in. Anything newer than the last
 * run counts: a thread's activity, another routine finishing, an item change. */
export function checkinShouldRun(input: {
  lastCheckinAt?: number;
  lastThreadActivityAt: number;
  lastRoutineFinishedAt: number;
  lastItemChangeAt: number;
}): boolean {
  if (input.lastCheckinAt == null) return true;
  return (
    input.lastThreadActivityAt > input.lastCheckinAt ||
    input.lastRoutineFinishedAt > input.lastCheckinAt ||
    input.lastItemChangeAt > input.lastCheckinAt
  );
}
