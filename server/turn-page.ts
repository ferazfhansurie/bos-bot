// Turn-counted transcript pages.
//
// A raw row page ("the newest 80 rows") is the wrong unit for a transcript a
// person reads: one long tool-heavy turn fills every row with tool chips, and
// the prompt that started it, plus everything said before, falls off the
// page. Reopening such a thread showed "just tool calls and the last
// message". A turn page is still a contiguous run of raw rows (so `before`
// cursors, branch siblings and patches keep working exactly as before), but
// its start is chosen by the conversation: it reaches back to the Nth newest
// user prompt on the active branch, so every turn it holds is whole.

/** Rows a single turn page may carry, whatever `turns` asks for. A runaway
 * turn with thousands of tool rows still answers with the newest rows. */
export const TURN_PAGE_ROW_MAX = 600;
/** Largest `turns` a client may ask for in one page. */
export const TURN_PAGE_TURNS_MAX = 50;

export interface TurnRow {
  id: string;
  parentId?: string | null;
  role: string;
  kind: string;
}

export type TurnPageStart =
  | { start: number }
  /** The rows held do not reach the Nth prompt (or the active path leaves
   * them); a caller holding a partial tail should read further back. */
  | { needMore: true };

/**
 * Where a turn page that ends just before `stop` should start.
 *
 * `rows` are contiguous raw rows in storage order; `complete` says whether
 * they begin at the start of the thread. The active path is walked from
 * `activeLeafId` (which may sit after `stop`, when paging back with a cursor)
 * and its user text messages before `stop` are counted. The page starts at
 * the `turns`-th newest one, then is widened to at least `minRows` and
 * clipped to at most `maxRows` rows ending at `stop`.
 */
export function turnPageStart(
  rows: readonly TurnRow[],
  activeLeafId: string | null,
  stop: number,
  turns: number,
  minRows: number,
  maxRows: number = TURN_PAGE_ROW_MAX,
  complete = true,
): TurnPageStart {
  const end = Math.max(0, Math.min(stop, rows.length));
  const index = new Map<string, number>();
  rows.forEach((row, i) => index.set(row.id, i));
  const leaf = activeLeafId ?? rows.at(-1)?.id ?? null;

  let start: number | null = null;
  let counted = 0;
  let at = leaf === null ? undefined : index.get(leaf);
  if (at === undefined && leaf !== null && !complete) return { needMore: true };
  while (at !== undefined) {
    const row = rows[at]!;
    if (at < end && row.role === "user" && row.kind === "text") {
      counted += 1;
      if (counted >= turns) { start = at; break; }
    }
    const parent = row.parentId;
    if (parent === null || parent === undefined) {
      // The whole branch is here and holds fewer prompts than asked: the
      // page reaches back to its root.
      start = Math.min(at, end);
      break;
    }
    const next = index.get(parent);
    if (next === undefined) {
      if (!complete) return { needMore: true };
      start = Math.min(at, end);
      break;
    }
    at = next;
  }
  if (start === null) start = complete ? 0 : end;
  start = Math.min(start, end - Math.min(minRows, end));
  start = Math.max(start, end - maxRows, 0);
  return { start };
}

/** `?turns=` as a page size: undefined = absent, null = unusable. */
export function turnCount(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1) return null;
  return Math.min(size, TURN_PAGE_TURNS_MAX);
}
