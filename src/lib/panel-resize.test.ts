import { describe, expect, it } from "vitest";

import { clampPanelSize, loadPanelSize, maxPanelSize, panelSizeFromKey, panelSizeFromPointer, savePanelSize, type PanelSizeSpec } from "./panel-resize";

const spec: PanelSizeSpec = { key: "test.panel", defaultSize: 480, min: 300, reserve: 360 };

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe("panel resize", () => {
  it("keeps the chat its reserve and the panel its minimum", () => {
    expect(clampPanelSize(2000, 1200, spec)).toBe(840);
    expect(clampPanelSize(100, 1200, spec)).toBe(300);
    expect(clampPanelSize(612.6, 1200, spec)).toBe(613);
    // a window too small for both: the panel keeps its minimum
    expect(maxPanelSize(500, spec)).toBe(300);
    expect(clampPanelSize(450, 500, spec)).toBe(300);
  });

  it("falls back to the default before the container is measured or for junk", () => {
    expect(clampPanelSize(Number.NaN, 1200, spec)).toBe(480);
    expect(clampPanelSize(5000, Number.NaN, spec)).toBe(5000);
    expect(clampPanelSize(Number.NaN, Number.NaN, spec)).toBe(480);
  });

  it("measures from the docked edge to the pointer", () => {
    expect(panelSizeFromPointer("right", { clientX: 700, clientY: 0 }, { right: 1200, bottom: 800 })).toBe(500);
    expect(panelSizeFromPointer("bottom", { clientX: 0, clientY: 550 }, { right: 1200, bottom: 800 })).toBe(250);
  });

  it("nudges with arrow keys toward the free edge", () => {
    expect(panelSizeFromKey("right", "ArrowLeft", 400)).toBe(416);
    expect(panelSizeFromKey("right", "ArrowRight", 400, true)).toBe(336);
    expect(panelSizeFromKey("bottom", "ArrowUp", 200)).toBe(216);
    expect(panelSizeFromKey("bottom", "ArrowLeft", 200)).toBeNull();
  });

  it("remembers a size and forgets it on reset", () => {
    const storage = memory();
    expect(loadPanelSize(spec, storage)).toBe(480);
    savePanelSize(spec, 555.4, storage);
    expect(storage.data.get("test.panel")).toBe("555");
    expect(loadPanelSize(spec, storage)).toBe(555);
    savePanelSize(spec, Number.NaN, storage);
    expect(storage.data.has("test.panel")).toBe(false);
    expect(loadPanelSize(spec, memory({ "test.panel": "garbage" }))).toBe(480);
    expect(loadPanelSize(spec, memory({ "test.panel": "-4" }))).toBe(480);
  });

  it("survives a storage that throws", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
    expect(loadPanelSize(spec, broken)).toBe(480);
    expect(() => savePanelSize(spec, 400, broken)).not.toThrow();
  });
});
