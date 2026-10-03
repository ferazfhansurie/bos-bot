// Drag-to-collapse sizing for the desktop sidebar. Numbers match the grok bot
// reference: the expanded sidebar is 240-400px, and dragging it under 210px
// snaps it to the 88px avatar rail. Leaving the rail takes a drag past 220px,
// so a pointer resting near the line doesn't flicker between the two.

export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_RAIL_WIDTH = 88;
export const SIDEBAR_COLLAPSE_BELOW = 210;
export const SIDEBAR_EXPAND_ABOVE = 220;
export const SIDEBAR_RESIZE_STEP = 16;
/** The chat pane never gets narrower than this; below it the sidebar rails. */
export const MAIN_PANE_MIN_WIDTH = 424;
export const SIDEBAR_WIDTH_KEY = "openmausbot.sidebarWidth.v1";

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

export type SidebarDragResult = { collapsed: boolean; width: number };

/**
 * Where a drag lands, given the raw pointer-driven width and whether the
 * sidebar was on the rail when this frame started. `width` is the expanded
 * width to keep; it doesn't change while the sidebar sits on the rail.
 */
export function resolveSidebarDrag(rawWidth: number, collapsed: boolean, expandedWidth: number): SidebarDragResult {
  if (collapsed) {
    if (rawWidth > SIDEBAR_EXPAND_ABOVE) return { collapsed: false, width: clampSidebarWidth(rawWidth) };
    return { collapsed: true, width: expandedWidth };
  }
  if (rawWidth < SIDEBAR_COLLAPSE_BELOW) return { collapsed: true, width: expandedWidth };
  return { collapsed: false, width: clampSidebarWidth(rawWidth) };
}

/** True when the window can't fit the sidebar plus a usable chat pane. */
export function sidebarAutoRail(windowWidth: number, sidebarWidth: number): boolean {
  return windowWidth < sidebarWidth + MAIN_PANE_MIN_WIDTH;
}

export function parseSidebarWidth(value: string | null): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(parsed);
}

export function loadSidebarWidth(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarWidth(target?.getItem(SIDEBAR_WIDTH_KEY) ?? null);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function saveSidebarWidth(width: number, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
  }
}
