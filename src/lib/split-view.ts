/** Split view: the main column can show up to three conversations side by
 * side. The primary pane is always the sidebar selection; the extra panes
 * hold other bots or rooms by id, left to right. The store keeps one live
 * thread per bot, so a bot appears in at most one pane. */

export const SPLIT_DRAG_TYPE = "application/x-bos-split-pane";
/** Panes beside the primary one: three columns in total. */
export const MAX_EXTRA_PANES = 2;
const STORAGE_KEY = "bos.splitPanes";

/** Add a pane at the right edge. The primary id and ids already open are
 * ignored; when full, the new pane replaces the rightmost one. */
export function addSplitPane(panes: readonly string[], id: string, primaryId: string): string[] {
  if (!id || id === primaryId || panes.includes(id)) return [...panes];
  const next = [...panes, id];
  return next.length > MAX_EXTRA_PANES ? [...next.slice(0, MAX_EXTRA_PANES - 1), id] : next;
}

export function removeSplitPane(panes: readonly string[], id: string): string[] {
  return panes.filter((pane) => pane !== id);
}

/** Selecting a conversation that is already open in a pane swaps it with
 * the old primary, so the layout keeps its columns instead of collapsing. */
export function swapIntoPrimary(panes: readonly string[], selectedId: string, previousId: string): string[] {
  const at = panes.indexOf(selectedId);
  if (at < 0) return [...panes];
  if (!previousId || previousId === selectedId || panes.includes(previousId)) return removeSplitPane(panes, selectedId);
  return panes.map((pane, index) => (index === at ? previousId : pane));
}

/** Drop panes whose bot or room no longer exists, and the primary itself. */
export function visibleSplitPanes(panes: readonly string[], knownIds: ReadonlySet<string>, primaryId: string): string[] {
  return panes.filter((pane, index) => pane !== primaryId && knownIds.has(pane) && panes.indexOf(pane) === index).slice(0, MAX_EXTRA_PANES);
}

export function loadSplitPanes(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, MAX_EXTRA_PANES) : [];
  } catch {
    return [];
  }
}

export function saveSplitPanes(panes: readonly string[], storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(panes));
  } catch {
    // private mode or a full store: the split simply does not survive a reload
  }
}
