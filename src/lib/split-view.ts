/** Split view: the main column can show up to three conversations side by
 * side. The primary pane is always the sidebar selection; the extra panes
 * hold other bots or rooms by id, left to right. A bot id shows that bot's
 * live thread; a thread pane id (`thread:<botId>:<threadId>`) pins one of
 * its other threads, so the same bot can run in several panes at once. */

export const SPLIT_DRAG_TYPE = "application/x-bos-split-pane";
/** Panes beside the primary one: three columns in total. */
export const MAX_EXTRA_PANES = 2;
const STORAGE_KEY = "bos.splitPanes";

/** Add a pane at the right edge. The primary id and ids already open are
 * ignored; when full, the new pane replaces the rightmost one. */
const THREAD_PANE_PREFIX = "thread:";

export function threadPaneId(botId: string, threadId: string): string {
  return `${THREAD_PANE_PREFIX}${botId}:${threadId}`;
}

export function parseThreadPane(id: string): { botId: string; threadId: string } | null {
  if (!id.startsWith(THREAD_PANE_PREFIX)) return null;
  const rest = id.slice(THREAD_PANE_PREFIX.length);
  const at = rest.indexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return { botId: rest.slice(0, at), threadId: rest.slice(at + 1) };
}

/** The bot a pane belongs to: its own id, or the owner of a thread pane. */
export function paneOwnerId(id: string): string {
  return parseThreadPane(id)?.botId ?? id;
}

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

/** Drop panes whose bot or room no longer exists, the primary itself, and
 * thread panes whose thread is already on screen as a bot's live thread
 * (`liveThread` gives a bot's current thread id). */
export function visibleSplitPanes(panes: readonly string[], knownIds: ReadonlySet<string>, primaryId: string, liveThread: (botId: string) => string | undefined = () => undefined): string[] {
  const shownBots = new Set([primaryId, ...panes.filter((pane) => !parseThreadPane(pane))]);
  return panes.filter((pane, index) => {
    if (pane === primaryId || panes.indexOf(pane) !== index) return false;
    const thread = parseThreadPane(pane);
    if (!thread) return knownIds.has(pane);
    return knownIds.has(thread.botId) && !(shownBots.has(thread.botId) && liveThread(thread.botId) === thread.threadId);
  }).slice(0, MAX_EXTRA_PANES);
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

const WIDTH_KEY = "bos.splitPaneWidth";
/** Default share of the chat column each extra pane takes before a drag. */
export const DEFAULT_PANE_SHARE = 0.4;
const MIN_PANE_SHARE = 0.2;
/** The primary pane always keeps at least this much of the column. */
const MIN_PRIMARY_SHARE = 0.25;

/** Clamp a pane's share so the primary and every extra pane stay usable. */
export function clampPaneShare(share: number, extraCount: number): number {
  const max = (1 - MIN_PRIMARY_SHARE) / Math.max(1, extraCount);
  if (!Number.isFinite(share)) return Math.min(DEFAULT_PANE_SHARE, max);
  return Math.min(max, Math.max(MIN_PANE_SHARE, share));
}

/** All extra panes share a width. A divider with N panes to its right
 * controls N + 1 equal shares between that divider and the column edge. */
export function shareFromPointer(pointerX: number, left: number, width: number, panesToRight: number, share: number): number {
  if (width <= 0) return share;
  return (left + width - pointerX) / width / (panesToRight + 1);
}

export function loadPaneShare(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): number {
  try {
    const parsed = Number(storage?.getItem(WIDTH_KEY));
    return parsed > 0 && parsed < 1 ? parsed : DEFAULT_PANE_SHARE;
  } catch {
    return DEFAULT_PANE_SHARE;
  }
}

export function savePaneShare(share: number, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(WIDTH_KEY, String(share));
  } catch {
    // the width just resets on reload
  }
}
