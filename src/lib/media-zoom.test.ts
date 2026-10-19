import { describe, expect, it } from "vitest";
import { NO_ZOOM, ZOOM_MAX, clampPan, panBy, wheelIntent, wheelZoomFactor, zoomAt, zoomPercent } from "./media-zoom";

const image = { width: 400, height: 300 };
const stage = { width: 800, height: 600 };

describe("media zoom", () => {
  it("keeps the content under the pointer fixed while zooming", () => {
    const point = { x: 100, y: 50 };
    const zoomed = zoomAt(NO_ZOOM, 4, point, image, stage);
    expect(zoomed.scale).toBe(4);
    // content under the pointer before: (100, 50); after: (p - offset) / scale
    expect((point.x - zoomed.x) / zoomed.scale).toBeCloseTo(100);
    expect((point.y - zoomed.y) / zoomed.scale).toBeCloseTo(50);
  });

  it("caps the scale and snaps back to fit at 100%", () => {
    expect(zoomAt(NO_ZOOM, 100, { x: 0, y: 0 }, image, stage).scale).toBe(ZOOM_MAX);
    const zoomed = zoomAt(NO_ZOOM, 3, { x: 150, y: 100 }, image, stage);
    expect(zoomAt(zoomed, 0.1, { x: 0, y: 0 }, image, stage)).toEqual(NO_ZOOM);
  });

  it("stops panning at the image edges and centres a small image", () => {
    const zoomed = { scale: 4, x: 0, y: 0 };
    expect(panBy(zoomed, 10_000, -10_000, image, stage)).toEqual({ scale: 4, x: 400, y: -300 });
    expect(clampPan({ scale: 1.5, x: 80, y: 40 }, image, stage)).toEqual({ scale: 1.5, x: 0, y: 0 });
    expect(panBy(NO_ZOOM, 50, 50, image, stage)).toEqual(NO_ZOOM);
  });

  it("turns wheel and pinch deltas into zoom factors", () => {
    expect(wheelZoomFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-10, 0, true)).toBeCloseTo(Math.exp(0.1));
    expect(wheelZoomFactor(-1, 1, false)).toBeCloseTo(wheelZoomFactor(-16, 0, false));
    expect(zoomPercent({ scale: 2.456, x: 0, y: 0 })).toBe("246%");
  });
});

describe("wheel intent", () => {
  const wheel = (deltaX: number, deltaY: number, extra: Partial<{ deltaMode: number; ctrlKey: boolean; metaKey: boolean }> = {}) =>
    ({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, ...extra });
  it("zooms at fit and on pinch, pans a zoomed trackpad scroll", () => {
    expect(wheelIntent(wheel(0, 4), 1)).toBe("zoom");
    expect(wheelIntent(wheel(3, 4), 2)).toBe("pan");
    expect(wheelIntent(wheel(0, 4.5), 2)).toBe("pan");
    expect(wheelIntent(wheel(0, 100), 2)).toBe("zoom");
    expect(wheelIntent(wheel(0, 3, { deltaMode: 1 }), 2)).toBe("zoom");
    expect(wheelIntent(wheel(2, 3, { ctrlKey: true }), 2)).toBe("zoom");
  });
});
