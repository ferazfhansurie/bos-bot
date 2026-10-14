// Which transcript rows to mount. A long thread holds hundreds of rows, and
// every mounted bubble re-renders on each store change; only the rows near
// the viewport mount, and spacers stand in for the rest at their measured
// (or, until first seen, estimated) heights.
//
// The mounted range is remembered by row KEY, not index: when an older page
// lands at the front, every index shifts but the same rows stay mounted, so
// the prepend only grows the top spacer and the scroll restore that follows
// it keeps the reader exactly where they were.

/** Rows mounted beyond each edge of the viewport, in pixels. */
export const VIRTUAL_OVERSCAN = 1200;

export interface VirtualRange {
  startKey: string;
  /** Exclusive end; null = through the newest row (the bottom-follow case,
   * so appended rows mount without waiting for a scroll). */
  endKey: string | null;
}

export interface IndexRange {
  start: number;
  end: number;
}

/** Resolve a remembered range against the current rows; null when either
 * edge has gone (thread switch, branch switch, an edit that rewound). */
export function resolveVirtualRange(keys: readonly string[], range: VirtualRange | null): IndexRange | null {
  if (!range) return null;
  const start = keys.indexOf(range.startKey);
  if (start < 0) return null;
  const end = range.endKey === null ? keys.length : keys.indexOf(range.endKey);
  if (end < 0 || end <= start) return null;
  return { start, end };
}

/** The newest rows that fill `viewport` plus the overscan. */
export function tailRange(heights: readonly number[], viewport: number, overscan = VIRTUAL_OVERSCAN): IndexRange {
  let start = heights.length;
  let filled = 0;
  while (start > 0 && filled < viewport + overscan) {
    start -= 1;
    filled += heights[start];
  }
  return { start, end: heights.length };
}

/** Rows intersecting [viewTop, viewBottom] (list coordinates) widened by the
 * overscan. Always at least one row while there are rows. */
export function viewportRange(
  heights: readonly number[],
  viewTop: number,
  viewBottom: number,
  overscan = VIRTUAL_OVERSCAN,
): IndexRange {
  const n = heights.length;
  if (!n) return { start: 0, end: 0 };
  let offset = 0;
  let start = -1;
  let end = n;
  for (let i = 0; i < n; i += 1) {
    const bottom = offset + heights[i];
    if (start < 0 && bottom > viewTop - overscan) start = i;
    if (offset >= viewBottom + overscan) { end = i; break; }
    offset = bottom;
  }
  if (start < 0) start = n - 1;
  return { start, end: Math.max(end, start + 1) };
}

/** Keep a row (a search hit) mounted: a range that misses it is replaced by
 * a small range around it, which the landing scroll then re-centres. */
export function includeIndex(range: IndexRange, index: number, total: number): IndexRange {
  if (index < 0 || (index >= range.start && index < range.end)) return range;
  return { start: Math.max(0, index - 3), end: Math.min(total, index + 8) };
}

/** Sum of heights in [from, to). */
export function spanHeight(heights: readonly number[], from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i += 1) total += heights[i];
  return total;
}

export function sameVirtualRange(a: VirtualRange | null, b: VirtualRange | null): boolean {
  return a === b || (!!a && !!b && a.startKey === b.startKey && a.endKey === b.endKey);
}

/** Measured row heights per thread, so returning to a thread restores its
 * scroll geometry instead of re-estimating every row. Bounded. */
const HEIGHT_CACHE_THREADS = 16;
const heightCaches = new Map<string, Map<string, number>>();

export function rowHeightCache(threadId: string): Map<string, number> {
  const existing = heightCaches.get(threadId);
  if (existing) {
    heightCaches.delete(threadId);
    heightCaches.set(threadId, existing);
    return existing;
  }
  const fresh = new Map<string, number>();
  heightCaches.set(threadId, fresh);
  while (heightCaches.size > HEIGHT_CACHE_THREADS) {
    const oldest = heightCaches.keys().next().value;
    if (oldest === undefined) break;
    heightCaches.delete(oldest);
  }
  return fresh;
}
