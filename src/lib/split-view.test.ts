import { describe, expect, it } from "vitest";

import {
  MAX_EXTRA_PANES,
  addSplitPane,
  loadSplitPanes,
  removeSplitPane,
  saveSplitPanes,
  swapIntoPrimary,
  visibleSplitPanes,
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
