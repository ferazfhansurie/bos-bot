import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { cn } from "@/lib/cn";
import { clampPanelSize, loadPanelSize, maxPanelSize, panelSizeFromKey, panelSizeFromPointer, savePanelSize, type PanelDock, type PanelSizeSpec } from "@/lib/panel-resize";

/** Width (right dock) or height (bottom dock) of the container. */
function containerSpan(container: HTMLElement | null, dock: PanelDock): number {
  if (!container) return Number.NaN;
  return dock === "right" ? container.clientWidth : container.clientHeight;
}

export interface ResizablePanel {
  /** Pixels along the drag axis, already clamped to the container. */
  size: number;
  resizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  min: number;
  max: number;
}

/** A panel on one edge of `containerRef`, resized by dragging its free edge.
 * The size is saved when a drag ends and re-clamped whenever the container
 * changes size, so shrinking the window never squeezes the chat to nothing. */
export function useResizablePanel(spec: PanelSizeSpec, dock: PanelDock, containerRef: RefObject<HTMLElement | null>): ResizablePanel {
  const [stored, setStored] = useState(() => loadPanelSize(spec));
  const [available, setAvailable] = useState(Number.NaN);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setAvailable(containerSpan(container, dock));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, dock]);

  const size = clampPanelSize(stored, available, spec);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const container = containerRef.current;
    if (event.button !== 0 || !container) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setResizing(true);
    let latest = size;
    const move = (moveEvent: PointerEvent) => {
      latest = clampPanelSize(panelSizeFromPointer(dock, moveEvent, container.getBoundingClientRect()), containerSpan(container, dock), spec);
      setStored(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setResizing(false);
      savePanelSize(spec, latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const onDoubleClick = () => {
    setStored(spec.defaultSize);
    savePanelSize(spec, Number.NaN);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const next = panelSizeFromKey(dock, event.key, size, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    const clamped = clampPanelSize(next, available, spec);
    setStored(clamped);
    savePanelSize(spec, clamped);
  };

  const max = Number.isFinite(available) ? maxPanelSize(available, spec) : spec.min;
  return { size, resizing, onPointerDown, onDoubleClick, onKeyDown, min: spec.min, max };
}

/** The draggable edge. Double-click puts the default size back. It sits over
 * the panel border, so it adds no layout width of its own. */
export function PanelResizeHandle({ panel, dock, label, testId }: { panel: ResizablePanel; dock: PanelDock; label: string; testId?: string }) {
  return (
    <div role="separator" tabIndex={0} aria-orientation={dock === "right" ? "vertical" : "horizontal"} aria-label={label} title={label}
      aria-valuenow={panel.size} aria-valuemin={panel.min} aria-valuemax={panel.max} data-testid={testId}
      onPointerDown={panel.onPointerDown} onDoubleClick={panel.onDoubleClick} onKeyDown={panel.onKeyDown}
      className={cn("absolute z-30 transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
        panel.resizing && "bg-accent/40",
        dock === "right" ? "-left-[3px] inset-y-0 w-[6px] cursor-col-resize" : "-top-[3px] inset-x-0 h-[6px] cursor-row-resize")} />
  );
}

/** While dragging, embedded content (terminal canvas, web views, iframes)
 * must not swallow the pointer, or the drag stops at the panel edge. */
export function PanelResizeShield({ active, dock }: { active: boolean; dock: PanelDock }) {
  if (!active) return null;
  return <div aria-hidden="true" className={cn("fixed inset-0 z-40", dock === "right" ? "cursor-col-resize" : "cursor-row-resize")} />;
}
