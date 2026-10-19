// Zoom and pan maths for the media viewer. The image is drawn with
// `translate(x, y) scale(scale)` around its centre, so a point p measured from
// the image centre shows content point (p - offset) / scale. Zooming at a
// point keeps that content under the pointer; panning stops at the edges.

export type MediaZoom = { scale: number; x: number; y: number };
export type Size = { width: number; height: number };

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.5;
export const ZOOM_DOUBLE_CLICK = 2.5;
export const NO_ZOOM: MediaZoom = { scale: 1, x: 0, y: 0 };

/** Keep the zoomed image covering the stage: no blank gap past an edge, and
 * centred on any axis where it is still smaller than the stage. */
export function clampPan(zoom: MediaZoom, image: Size, stage: Size): MediaZoom {
  const maxX = Math.max(0, (image.width * zoom.scale - stage.width) / 2);
  const maxY = Math.max(0, (image.height * zoom.scale - stage.height) / 2);
  return { scale: zoom.scale, x: Math.min(maxX, Math.max(-maxX, zoom.x)), y: Math.min(maxY, Math.max(-maxY, zoom.y)) };
}

/** Scale by `factor` keeping the content under `point` (relative to the
 * image's untransformed centre) still under it. */
export function zoomAt(zoom: MediaZoom, factor: number, point: { x: number; y: number }, image: Size, stage: Size): MediaZoom {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.scale * factor));
  if (scale === ZOOM_MIN) return NO_ZOOM;
  const ratio = scale / zoom.scale;
  return clampPan({ scale, x: point.x - (point.x - zoom.x) * ratio, y: point.y - (point.y - zoom.y) * ratio }, image, stage);
}

export function panBy(zoom: MediaZoom, dx: number, dy: number, image: Size, stage: Size): MediaZoom {
  if (zoom.scale === ZOOM_MIN) return zoom;
  return clampPan({ scale: zoom.scale, x: zoom.x + dx, y: zoom.y + dy }, image, stage);
}

/** Wheel and trackpad pinch (Chromium reports pinch as ctrl+wheel) to a zoom
 * factor; pinch deltas are small, so it gets the steeper curve. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-pixels * (pinch ? 0.01 : 0.002));
}

export function zoomPercent(zoom: MediaZoom): string {
  return `${Math.round(zoom.scale * 100)}%`;
}

/** Once zoomed, a two-finger trackpad scroll pans; a mouse wheel notch (whole
 * line steps or big integer deltas, no sideways part) and any pinch zoom. */
export function wheelIntent(event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean }, scale: number): "zoom" | "pan" {
  if (event.ctrlKey || event.metaKey || scale <= ZOOM_MIN) return "zoom";
  if (event.deltaMode !== 0) return "zoom";
  const trackpad = event.deltaX !== 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 50;
  return trackpad ? "pan" : "zoom";
}
