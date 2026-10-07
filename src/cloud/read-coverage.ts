// Private per-thread read coverage (D05): a contiguous read prefix plus at
// most 256 sparse viewed intervals. Coverage only bridges messages the client
// has actually loaded next to each other; it never marks unloaded or unseen
// content read. At the bound it keeps the old, conservative state.
import { LIMITS, type ReadCoverage } from "../../shared/cloud-protocol/index";
import { compareSequence, type Sequence } from "./sequence";

type Interval = [Sequence, Sequence];

/** Prefix "0" means nothing is read; room sequences start at 1. */
export const EMPTY_COVERAGE: ReadCoverage = { prefix: "0", intervals: [], attention: false };

/**
 * A run of eligible messages loaded with no gap between them. `after` is the
 * eligible message immediately before `sequences[0]`: null when the run starts
 * the thread, undefined when the client does not know.
 */
export interface LoadedRun {
  sequences: Sequence[];
  after?: Sequence | null;
}

export function isRead(coverage: ReadCoverage, sequence: Sequence): boolean {
  if (compareSequence(sequence, coverage.prefix) <= 0) return true;
  return coverage.intervals.some(([start, end]) => compareSequence(start, sequence) <= 0 && compareSequence(sequence, end) <= 0);
}

function normalize(prefix: Sequence, intervals: Interval[]): { prefix: Sequence; intervals: Interval[] } {
  const sorted = intervals.map(([start, end]) => [start, end] as Interval).sort((a, b) => compareSequence(a[0], b[0]));
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && compareSequence(interval[0], last[1]) <= 0) {
      if (compareSequence(interval[1], last[1]) > 0) last[1] = interval[1];
    } else {
      merged.push(interval);
    }
  }
  let nextPrefix = prefix;
  const kept: Interval[] = [];
  for (const interval of merged) {
    if (compareSequence(interval[0], nextPrefix) <= 0) {
      if (compareSequence(interval[1], nextPrefix) > 0) nextPrefix = interval[1];
      continue;
    }
    kept.push(interval);
  }
  return { prefix: nextPrefix, intervals: kept };
}

export interface MarkResult {
  coverage: ReadCoverage;
  status: "ok" | "read_coverage_limit";
  /** Viewed ranges to post; each overlaps existing coverage only where bridging is proven. */
  post: Interval[];
}

/** Record foreground-visible final messages from one loaded run as read. */
export function markViewed(coverage: ReadCoverage, run: LoadedRun, viewed: ReadonlySet<Sequence>): MarkResult {
  // The thread start is represented by the empty prefix itself.
  const items: Sequence[] = [];
  if (run.after === null) items.push("0");
  else if (run.after !== undefined) items.push(run.after);
  items.push(...run.sequences);

  const covered = (item: Sequence) => item === "0" || viewed.has(item) || isRead(coverage, item);
  const post: Interval[] = [];
  let runStart = -1;
  const close = (endIndex: number) => {
    if (runStart < 0) return;
    const slice = items.slice(runStart, endIndex + 1);
    runStart = -1;
    const fresh = slice.filter((item) => viewed.has(item) && !isRead(coverage, item));
    if (fresh.length === 0) return;
    post.push([slice[0], slice[slice.length - 1]]);
  };
  items.forEach((item, index) => {
    if (covered(item)) {
      if (runStart < 0) runStart = index;
    } else {
      close(index - 1);
    }
  });
  close(items.length - 1);

  const next = normalize(coverage.prefix, [...coverage.intervals, ...post]);
  if (next.intervals.length > LIMITS.sparseIntervals) {
    return { coverage, status: "read_coverage_limit", post: [] };
  }
  return { coverage: { ...coverage, ...next }, status: "ok", post };
}

/** Explicit Mark read at an acknowledged watermark; newer content stays unread. */
export function markReadThrough(coverage: ReadCoverage, watermark: Sequence): ReadCoverage {
  const prefix = compareSequence(coverage.prefix, watermark) >= 0 ? coverage.prefix : watermark;
  return { ...coverage, ...normalize(prefix, coverage.intervals) };
}

export interface CountableMessage {
  sequence: Sequence;
  actor_id: string;
  deleted?: boolean;
  /** Provisional bot content never counts as read or unread. */
  provisional?: boolean;
}

/** Other people's messages count; own, deleted and provisional content never does. */
export function isEligible(message: CountableMessage, accountId: string): boolean {
  return !message.deleted && !message.provisional && message.actor_id !== accountId;
}

export function unreadCount(coverage: ReadCoverage, messages: readonly CountableMessage[], accountId: string): number {
  const counted = new Set<Sequence>();
  for (const message of messages) {
    if (isEligible(message, accountId) && !isRead(coverage, message.sequence)) counted.add(message.sequence);
  }
  return counted.size;
}
