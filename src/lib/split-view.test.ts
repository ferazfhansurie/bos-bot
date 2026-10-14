import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANE_SHARE,
  MAX_EXTRA_PANES,
  addSplitPane,
  clampPaneShare,
  loadPaneShare,
  savePaneShare,
  shareFromPointer,
  loadSplitPanes,
  removeSplitPane,
  saveSplitPanes,
  swapIntoPrimary,
  visibleSplitPanes,
  threadPaneId,
} from "./split-view";

describe("split view panes", () => {
  it("adds panes to the right, skipping the primary and duplicates", () => {
    expect(addSplitPane([], "b", "a")).toEqual(["b"]);
    expect(addSplitPane(["b"], "c", "a")).toEqual(["b", "c"]);
    expect(addSplitPane(["b"], "a", "a")).toEqual(["b"]);
    expect(addSplitPane(["b"], "b", "a")).toEqual(["b"]);
  });

  it("replaces the rightmost pane when all three columns are taken", () => {
    expect(MAX_EXTRA_PANES).toBe(2);
    expect(addSplitPane(["b", "c"], "d", "a")).toEqual(["b", "d"]);
  });

  it("removes a pane", () => {
    expect(removeSplitPane(["b", "c"], "b")).toEqual(["c"]);
  });

  it("swaps a pane with the old primary when it becomes the selection", () => {
    expect(swapIntoPrimary(["b", "c"], "c", "a")).toEqual(["b", "a"]);
    expect(swapIntoPrimary(["b", "c"], "d", "a")).toEqual(["b", "c"]);
    expect(swapIntoPrimary(["b"], "b", "")).toEqual([]);
  });

  it("hides panes for deleted conversations and the primary", () => {
    expect(visibleSplitPanes(["b", "gone", "a", "c"], new Set(["a", "b", "c"]), "a")).toEqual(["b", "c"]);
  });

  it("trades pinned threads of the same bot without collapsing a column", () => {
    const first = threadPaneId("a", "first");
    const second = threadPaneId("a", "second");
    const swapped = swapIntoPrimary([second], second, first);
    expect(swapped).toEqual([first]);
    expect(visibleSplitPanes(swapped, new Set(["a"]), "a", () => "second")).toEqual([first]);
    expect(addSplitPane([second], second, first)).toEqual([second]);
    expect(addSplitPane([], first, first)).toEqual([]);
  });

  it("round-trips through storage and ignores junk", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    saveSplitPanes(["b", "c"], storage);
    expect(loadSplitPanes(storage)).toEqual(["b", "c"]);
    data.set("bos.splitPanes", "{not json");
    expect(loadSplitPanes(storage)).toEqual([]);
    data.set("bos.splitPanes", JSON.stringify(["x", 3, "", "y", "z"]));
    expect(loadSplitPanes(storage)).toEqual(["x", "y"]);
    expect(loadSplitPanes(undefined)).toEqual([]);
  });
});

describe("split pane width", () => {
  it("clamps so the primary keeps a quarter and each pane a fifth", () => {
    expect(clampPaneShare(0.5, 1)).toBe(0.5);
    expect(clampPaneShare(0.9, 1)).toBe(0.75);
    expect(clampPaneShare(0.05, 1)).toBe(0.2);
    expect(clampPaneShare(0.5, 2)).toBe(0.375);
    expect(clampPaneShare(Number.NaN, 1)).toBe(DEFAULT_PANE_SHARE);
  });

  it("maps the pointer to equal shares for all panes to its right", () => {
    expect(shareFromPointer(600, 0, 1000, 0, 0.4)).toBeCloseTo(0.4);
    expect(shareFromPointer(300, 0, 1000, 1, 0.3)).toBeCloseTo(0.35);
    expect(shareFromPointer(300, 0, 1000, 1, 0.35)).toBeCloseTo(0.35);
    expect(shareFromPointer(300, 0, 0, 0, 0.4)).toBe(0.4);
  });

  it("remembers the width and ignores junk", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(loadPaneShare(storage)).toBe(DEFAULT_PANE_SHARE);
    savePaneShare(0.55, storage);
    expect(loadPaneShare(storage)).toBe(0.55);
    storage.setItem("bos.splitPaneWidth", "abc");
    expect(loadPaneShare(storage)).toBe(DEFAULT_PANE_SHARE);
  });
});
