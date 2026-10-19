// The image inside the media viewer, with zoom: wheel or trackpad pinch zooms
// at the pointer (chromium sends pinch as ctrl+wheel, safari as gesture
// events), two-finger scroll and drag pan once zoomed, double-click toggles,
// touch pinches, and + / - / 0 / arrows work from the keyboard. The pill at the
// bottom shows the level; clicking the percentage fits the image again.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Minus, Plus } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  NO_ZOOM,
  ZOOM_DOUBLE_CLICK,
  ZOOM_MAX,
  ZOOM_STEP,
  panBy,
  wheelIntent,
  wheelZoomFactor,
  zoomAt,
  zoomPercent,
  type MediaZoom,
} from "@/lib/media-zoom";

const PILL_BUTTON = "flex size-7 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white disabled:text-white/30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";
const KEY_PAN = 80;

type Point = { x: number; y: number };
type GestureLike = Event & { scale: number; clientX: number; clientY: number };

export function ZoomableImage({ src, alt, ready, className, onLoad, onError }: {
  src: string;
  alt: string;
  ready: boolean;
  className?: string;
  onLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  onError: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState<MediaZoom>(NO_ZOOM);
  const [animate, setAnimate] = useState(false);
  const [dragging, setDragging] = useState(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; mid: Point; point: Point; zoom: MediaZoom } | null>(null);
  const drag = useRef<Point | null>(null);
  const gesture = useRef<{ point: Point; zoom: MediaZoom } | null>(null);

  const sizes = useCallback(() => {
    const img = imgRef.current;
    const stage = img?.parentElement;
    return {
      image: { width: img?.offsetWidth ?? 0, height: img?.offsetHeight ?? 0 },
      stage: { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 },
    };
  }, []);

  /** A client point relative to the image's untransformed centre. Scaling is
   * about the centre, so the drawn box is only shifted by the pan offset. */
  const pointAt = useCallback((clientX: number, clientY: number): Point => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const current = zoomRef.current;
    return { x: clientX - (rect.left + rect.width / 2 - current.x), y: clientY - (rect.top + rect.height / 2 - current.y) };
  }, []);

  const apply = useCallback((next: MediaZoom, smooth: boolean) => {
    zoomRef.current = next;
    setAnimate(smooth);
    setZoom(next);
  }, []);

  const zoomBy = useCallback((factor: number, point: Point = { x: 0, y: 0 }, smooth = true) => {
    const { image, stage } = sizes();
    apply(zoomAt(zoomRef.current, factor, point, image, stage), smooth);
  }, [apply, sizes]);

  const pan = useCallback((dx: number, dy: number, smooth = false) => {
    const { image, stage } = sizes();
    apply(panBy(zoomRef.current, dx, dy, image, stage), smooth);
  }, [apply, sizes]);

  // Wheel and safari gestures must be non-passive to stop the page zooming.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const pinching = event.ctrlKey || event.metaKey;
      if (pinching && gesture.current) return;
      if (wheelIntent(event, zoomRef.current.scale) === "pan") {
        pan(-event.deltaX, -event.deltaY);
        return;
      }
      zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode, pinching), pointAt(event.clientX, event.clientY), false);
    };
    const onGestureStart = (event: Event) => {
      const e = event as GestureLike;
      event.preventDefault();
      gesture.current = { point: pointAt(e.clientX, e.clientY), zoom: zoomRef.current };
    };
    const onGestureChange = (event: Event) => {
      const e = event as GestureLike;
      event.preventDefault();
      const start = gesture.current;
      if (!start) return;
      const { image, stage } = sizes();
      apply(zoomAt(start.zoom, e.scale, start.point, image, stage), false);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gesture.current = null;
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    img.addEventListener("gesturestart", onGestureStart);
    img.addEventListener("gesturechange", onGestureChange);
    img.addEventListener("gestureend", onGestureEnd);
    return () => {
      img.removeEventListener("wheel", onWheel);
      img.removeEventListener("gesturestart", onGestureStart);
      img.removeEventListener("gesturechange", onGestureChange);
      img.removeEventListener("gestureend", onGestureEnd);
    };
  }, [apply, pan, pointAt, sizes, zoomBy]);

  // Capture phase, so zoom keys beat page zoom and arrows pan instead of
  // paging while zoomed in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey) return;
      const zoomed = zoomRef.current.scale > 1;
      let handled = true;
      if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
      else if (event.key === "-" || event.key === "_") zoomBy(1 / ZOOM_STEP);
      else if (event.key === "0") apply(NO_ZOOM, true);
      else if (zoomed && event.key === "ArrowLeft") pan(KEY_PAN, 0, true);
      else if (zoomed && event.key === "ArrowRight") pan(-KEY_PAN, 0, true);
      else if (zoomed && event.key === "ArrowUp") pan(0, KEY_PAN, true);
      else if (zoomed && event.key === "ArrowDown") pan(0, -KEY_PAN, true);
      else handled = false;
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [apply, pan, zoomBy]);

  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const [a, b] = points;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid, point: pointAt(mid.x, mid.y), zoom: zoomRef.current };
      drag.current = null;
    } else if (points.length === 1 && zoomRef.current.scale > 1) {
      drag.current = { x: event.clientX, y: event.clientY };
      setDragging(true);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = pinch.current;
    if (start && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { image, stage } = sizes();
      const scaled = zoomAt(start.zoom, Math.hypot(a.x - b.x, a.y - b.y) / start.distance, start.point, image, stage);
      apply(panBy(scaled, mid.x - start.mid.x, mid.y - start.mid.y, image, stage), false);
      return;
    }
    const last = drag.current;
    if (!last) return;
    drag.current = { x: event.clientX, y: event.clientY };
    pan(event.clientX - last.x, event.clientY - last.y);
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLImageElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      drag.current = null;
      setDragging(false);
    }
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    if (zoomRef.current.scale > 1) apply(NO_ZOOM, true);
    else zoomBy(ZOOM_DOUBLE_CLICK, pointAt(event.clientX, event.clientY));
  };

  const zoomed = zoom.scale > 1;
  return (
    <>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        draggable={false}
        onLoad={onLoad}
        onError={onError}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={onDoubleClick}
        style={{
          transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
          transition: animate ? "transform 200ms cubic-bezier(.2,.8,.2,1)" : "none",
          cursor: dragging ? "grabbing" : zoomed ? "grab" : "zoom-in",
          touchAction: "none",
          willChange: "transform",
        }}
        className={className}
      />
      {ready && (
        <div
          role="toolbar"
          aria-label="Zoom"
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-white/[0.12] p-0.5 text-white backdrop-blur-md"
        >
          <button type="button" className={PILL_BUTTON} onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={!zoomed} aria-label="Zoom out" title="Zoom out (−)">
            <Minus size={15} />
          </button>
          <button
            type="button"
            onClick={() => apply(NO_ZOOM, true)}
            disabled={!zoomed}
            aria-label={zoomed ? `Zoom ${zoomPercent(zoom)}. Fit to screen` : "Fit to screen"}
            title="Fit to screen (0)"
            className={cn("h-7 min-w-[52px] rounded-full px-2 text-[12px] font-medium tabular-nums transition-colors", zoomed ? "text-white hover:bg-white/15" : "text-white/60")}
          >
            {zoomPercent(zoom)}
          </button>
          <button type="button" className={PILL_BUTTON} onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom.scale >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (+)">
            <Plus size={15} />
          </button>
        </div>
      )}
    </>
  );
}
