import { describe, expect, it } from "vitest";

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
  loadSidebarWidth,
  parseSidebarWidth,
  resolveSidebarDrag,
  saveSidebarWidth,
  sidebarAutoRail,
  type SidebarDragResult,
} from "./sidebar-resize";

/** Feed a pointer path through the resolver the way the drag handler does. */
function drag(path: number[], start: SidebarDragResult): SidebarDragResult[] {
  let state = start;
  return path.map((raw) => (state = resolveSidebarDrag(raw, state.collapsed, state.width)));
}

describe("sidebar drag snap", () => {
  it("follows the pointer between min and max, clamped", () => {
    expect(resolveSidebarDrag(300, false, 280)).toEqual({ collapsed: false, width: 300 });
    expect(resolveSidebarDrag(520, false, 280)).toEqual({ collapsed: false, width: SIDEBAR_MAX_WIDTH });
    expect(resolveSidebarDrag(225, false, 280)).toEqual({ collapsed: false, width: SIDEBAR_MIN_WIDTH });
  });

  it("snaps to the rail under 210px and keeps the expanded width", () => {
    expect(resolveSidebarDrag(210, false, 300)).toEqual({ collapsed: false, width: SIDEBAR_MIN_WIDTH });
    expect(resolveSidebarDrag(209, false, 300)).toEqual({ collapsed: true, width: 300 });
  });

  it("needs a drag past 220px to leave the rail", () => {
    expect(resolveSidebarDrag(215, true, 300)).toEqual({ collapsed: true, width: 300 });
    expect(resolveSidebarDrag(220, true, 300)).toEqual({ collapsed: true, width: 300 });
    expect(resolveSidebarDrag(221, true, 300)).toEqual({ collapsed: false, width: SIDEBAR_MIN_WIDTH });
  });

  it("doesn't flicker when the pointer wobbles around the snap line", () => {
    const states = drag([260, 209, 212, 215, 218, 214, 219], { collapsed: false, width: 280 });
    expect(states.map((s) => s.collapsed)).toEqual([false, true, true, true, true, true, true]);
    const back = drag([200, 222, 216, 212, 211], states.at(-1)!);
    expect(back.map((s) => s.collapsed)).toEqual([true, false, false, false, false]);
  });
});

describe("sidebar auto rail", () => {
  it("rails when the chat pane would drop under 424px", () => {
    expect(sidebarAutoRail(703, 280)).toBe(true);
    expect(sidebarAutoRail(704, 280)).toBe(false);
  });
});

describe("sidebar width storage", () => {
  it("parses, clamps and falls back to the default", () => {
    expect(parseSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("nope")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("999")).toBe(SIDEBAR_MAX_WIDTH);
    expect(parseSidebarWidth("312.4")).toBe(312);
  });

  it("round-trips through storage", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    saveSidebarWidth(333, storage);
    expect(data.get(SIDEBAR_WIDTH_KEY)).toBe("333");
    expect(loadSidebarWidth(storage)).toBe(333);
  });

  it("survives storage that throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadSidebarWidth(broken)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(() => saveSidebarWidth(300, broken)).not.toThrow();
  });
});
