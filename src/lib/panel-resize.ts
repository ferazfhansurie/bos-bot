/** Drag-to-resize sizing for a panel docked on one edge of the chat column
 * (the terminal, the tools panel). Sizes are pixels along the drag axis and
 * are remembered across reloads; the chat beside the panel always keeps a
 * usable minimum, so a remembered size from a wider window still fits. */

export type PanelDock = "right" | "bottom";

export interface PanelSizeSpec {
  /** localStorage key for the remembered size. */
  key: string;
  defaultSize: number;
  min: number;
  /** Space the rest of the column keeps along the same axis. */
  reserve: number;
}

/** Arrow-key nudge on a focused handle; Shift moves further. */
export const PANEL_RESIZE_STEP = 16;

/** Largest size the panel may take in `available` pixels. Never below min:
 * on a tiny window the panel wins over the chat rather than vanishing. */
export function maxPanelSize(available: number, spec: PanelSizeSpec): number {
  return Math.max(spec.min, Math.floor(available - spec.reserve));
}

/** Clamp a requested size; NaN/unknown means "use the default". */
export function clampPanelSize(size: number, available: number, spec: PanelSizeSpec): number {
  const max = Number.isFinite(available) && available > 0 ? maxPanelSize(available, spec) : Number.POSITIVE_INFINITY;
  const wanted = Number.isFinite(size) ? size : spec.defaultSize;
  return Math.round(Math.min(max, Math.max(spec.min, wanted)));
}

/** Size for a panel whose free edge was dragged to the pointer. A right-docked
 * panel spans from the pointer to the container's right edge; a bottom-docked
 * one from the pointer to the bottom edge. */
export function panelSizeFromPointer(dock: PanelDock, pointer: { clientX: number; clientY: number }, rect: Pick<DOMRect, "right" | "bottom">): number {
  return dock === "right" ? rect.right - pointer.clientX : rect.bottom - pointer.clientY;
}

/** Keyboard resize for a focused separator. Returns null for other keys.
 * Arrows move the free edge, so on a right dock ← grows the panel. */
export function panelSizeFromKey(dock: PanelDock, key: string, size: number, shift = false): number | null {
  const step = shift ? PANEL_RESIZE_STEP * 4 : PANEL_RESIZE_STEP;
  const grow = dock === "right" ? "ArrowLeft" : "ArrowUp";
  const shrink = dock === "right" ? "ArrowRight" : "ArrowDown";
  if (key === grow) return size + step;
  if (key === shrink) return size - step;
  return null;
}

export function loadPanelSize(spec: PanelSizeSpec, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): number {
  try {
    const raw = storage?.getItem(spec.key);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : spec.defaultSize;
  } catch {
    return spec.defaultSize;
  }
}

export function savePanelSize(spec: PanelSizeSpec, size: number, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage): void {
  try {
    if (Number.isFinite(size)) storage?.setItem(spec.key, String(Math.round(size)));
    else storage?.removeItem(spec.key);
  } catch {
    // private mode or a full store: the size just resets on reload
  }
}
