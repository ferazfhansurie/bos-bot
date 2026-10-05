/** Ranking for the command palette's name lists (bots, rooms, actions).
 *
 * A prefix match is almost always what a few typed letters mean, so those
 * rows outrank a match at the start of a later word, which outranks a plain
 * substring. A secondary field (a bot's title, an action's keywords) comes
 * next, and a loose subsequence match ("bb" → "bos bots") sits at the
 * bottom so a sloppy query still finds something. Within each tier the input
 * order is preserved — the caller's list already encodes a meaningful order
 * (pinned first, recency, …) and re-sorting it here would fight that. */

export type MatchKind = "prefix" | "word" | "substring" | "fuzzy";

/** Where a query landed in one string. `indices` are code-point offsets
 * (Array.from), so highlighting never splits a surrogate pair. */
export interface TextMatch {
  kind: MatchKind;
  indices: number[];
}

export interface PaletteMatch extends TextMatch {
  field: "name" | "title";
  /** 0 is best; lower tiers sort first */
  tier: number;
}

export interface Ranked<T> {
  item: T;
  /** null in switcher mode (empty query), where nothing is matched */
  match: PaletteMatch | null;
}

const NAME_TIER: Record<MatchKind, number> = { prefix: 0, word: 1, substring: 2, fuzzy: 4 };
// any non-fuzzy hit on the secondary field ranks between name substring and
// name fuzzy; a fuzzy title hit is too noisy to be worth showing
const TITLE_TIER = 3;

// per-code-point lowercase; toLowerCase on the whole string can change its
// length ("İ") and shift every index after it
const fold = (text: string) => Array.from(text, (ch) => ch.toLowerCase());

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

const range = (start: number, length: number) => Array.from({ length }, (_, i) => start + i);

function occursAt(hay: string[], needle: string[], at: number): boolean {
  for (let j = 0; j < needle.length; j++) if (hay[at + j] !== needle[j]) return false;
  return true;
}

// subsequence through word starts only — "bb" on "bos bots" lights both b's
// rather than the first two it happens to meet
function wordStartSubsequence(hay: string[], needle: string[], raw: string[]): number[] | null {
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    const start = isWordChar(raw[i]) && !isWordChar(raw[i - 1]);
    if (start && hay[i] === needle[j]) {
      out.push(i);
      j++;
    }
  }
  return j === needle.length ? out : null;
}

function greedySubsequence(hay: string[], needle: string[]): number[] | null {
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) {
      out.push(i);
      j++;
    }
  }
  return j === needle.length ? out : null;
}

/** Match one string against a query, or null. Case-insensitive. */
export function matchText(text: string, query: string): TextMatch | null {
  const q = fold(query.trim());
  if (!q.length) return null;
  const raw = Array.from(text);
  const hay = fold(text);

  if (occursAt(hay, q, 0)) return { kind: "prefix", indices: range(0, q.length) };

  let firstSubstring = -1;
  for (let i = 1; i + q.length <= hay.length; i++) {
    if (!occursAt(hay, q, i)) continue;
    // a word start beats an earlier mid-word hit ("mo" on "Lemon Momo")
    if (!isWordChar(raw[i - 1])) return { kind: "word", indices: range(i, q.length) };
    if (firstSubstring < 0) firstSubstring = i;
  }
  if (firstSubstring >= 0) return { kind: "substring", indices: range(firstSubstring, q.length) };

  // spaces in a sloppy query are noise for a subsequence
  const loose = q.filter((ch) => ch.trim() !== "");
  // a single character already had its chance as a substring
  if (loose.length < 2) return null;
  const indices = wordStartSubsequence(hay, loose, raw) ?? greedySubsequence(hay, loose);
  return indices ? { kind: "fuzzy", indices } : null;
}

/** The best match of a query against an item's name and optional title. */
export function matchEntry(fields: { name: string; title?: string }, query: string): PaletteMatch | null {
  const name = matchText(fields.name, query);
  if (name && name.kind !== "fuzzy") return { ...name, field: "name", tier: NAME_TIER[name.kind] };
  const title = fields.title ? matchText(fields.title, query) : null;
  if (title && title.kind !== "fuzzy") return { ...title, field: "title", tier: TITLE_TIER };
  return name ? { ...name, field: "name", tier: NAME_TIER.fuzzy } : null;
}

/** Rank items by tier, keeping input order inside a tier. An empty query
 * returns everything untouched with no match (switcher mode). */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => { name: string; title?: string },
): Ranked<T>[] {
  if (!query.trim()) return items.map((item) => ({ item, match: null }));
  const hits: Array<Ranked<T> & { match: PaletteMatch; order: number }> = [];
  items.forEach((item, order) => {
    const match = matchEntry(fields(item), query);
    if (match) hits.push({ item, match, order });
  });
  hits.sort((a, b) => a.match.tier - b.match.tier || a.order - b.order);
  return hits.map(({ item, match }) => ({ item, match }));
}

/** Name-only ranking, kept for callers that just want the ordered items. */
export function rankByName<T extends { name: string; title?: string }>(items: readonly T[], query: string): T[] {
  return rankMatches(items, query, (item) => ({ name: item.name, title: item.title })).map((r) => r.item);
}

/** Lowest (best) tier in a ranked list, for ordering whole sections. */
export function bestTier(ranked: readonly Ranked<unknown>[]): number {
  let best = Infinity;
  for (const r of ranked) if (r.match && r.match.tier < best) best = r.match.tier;
  return best;
}

/** Split text into plain and highlighted runs for the given code-point
 * indices, merging neighbours so one match renders as one <mark>. */
export function highlightRuns(text: string, indices: readonly number[] | undefined): Array<{ text: string; hit: boolean }> {
  const chars = Array.from(text);
  if (!indices?.length) return [{ text, hit: false }];
  const marked = new Set(indices);
  const runs: Array<{ text: string; hit: boolean }> = [];
  chars.forEach((ch, i) => {
    const hit = marked.has(i);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += ch;
    else runs.push({ text: ch, hit });
  });
  return runs;
}

/** Most recently active first, capped. Items with no activity yet (at <= 0)
 * are left out — "recent" with a never-used bot in it reads as a bug. */
export function recentFirst<T>(items: readonly T[], at: (item: T) => number, limit: number): T[] {
  return items
    .map((item, order) => ({ item, at: at(item), order }))
    .filter((entry) => entry.at > 0)
    .sort((a, b) => b.at - a.at || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.item);
}
