import { afterEach, describe, expect, it } from "vitest";
import { __noteFace, __resetStage, arrivedHome, faceHere, walkingHome, clearDone, clearOpened, markOpened, openedTab, hasTabSlot, markDone, registerTabSlot, resetSpot, spotOf, travelName, travelTo } from "./v3-stage";

afterEach(() => __resetStage());

describe("v3 stage", () => {
  it("a bot starts in its row and moves without a DOM by plain swap", () => {
    expect(spotOf("a")).toBe("sidebar");
    travelTo("a", "island");
    expect(spotOf("a")).toBe("island");
    travelTo("a", "sidebar");
    expect(spotOf("a")).toBe("sidebar");
  });

  it("reset sends the bot home with no trip", () => {
    travelTo("a", "pointing");
    resetSpot("a");
    expect(spotOf("a")).toBe("sidebar");
  });

  it("tab slots count holders", () => {
    const off1 = registerTabSlot("a");
    const off2 = registerTabSlot("a");
    off1();
    expect(hasTabSlot("a")).toBe(true);
    off2();
    expect(hasTabSlot("a")).toBe(false);
  });

  it("only the travelling slot that holds the bot wears the name", () => {
    expect(travelName({ spot: "island", travelling: true }, "island")).toEqual({ viewTransitionName: "v3-mascot" });
    expect(travelName({ spot: "island", travelling: true }, "sidebar")).toBeUndefined();
    expect(travelName({ spot: "island", travelling: false }, "island")).toBeUndefined();
  });

  it("done marks are idempotent", () => {
    markDone("a");
    markDone("a");
    clearDone("a");
    clearDone("a");
  });

  it("the opened tab is one per bot and clears with the turn", () => {
    markOpened("a", "t1");
    markOpened("a", "t2");
    expect(openedTab("a")).toBe("t2");
    expect(openedTab("b")).toBeUndefined();
    clearOpened("a");
    clearOpened("a");
    expect(openedTab("a")).toBeUndefined();
  });

  it("the one face is drawn in exactly one place", () => {
    const places = ["sidebar", "empty", "island", "tab", "pointing"] as const;
    for (const spot of places) {
      const shown = places.filter((here) => faceHere({ spot }, here));
      expect(shown).toEqual([spot]);
    }
    // walking home above the page: no place draws it until it arrives
    expect(places.filter((here) => faceHere({ spot: "sidebar", walking: true }, here))).toEqual([]);
  });

  it("an empty thread holds the face big, then hands it to the island", () => {
    travelTo("a", "empty");
    expect(spotOf("a")).toBe("empty");
    expect(travelName({ spot: "empty", travelling: true }, "empty")).toEqual({ viewTransitionName: "v3-mascot" });
    travelTo("a", "island");
    expect(spotOf("a")).toBe("island");
  });

  it("a bot whose chat closes walks home from where it stood, then sits", () => {
    const doc = globalThis.document;
    Object.assign(globalThis, { document: { hidden: false } });
    try {
      __noteFace("a", { left: 400, top: 500, width: 112, height: 112 });
      travelTo("a", "empty");
      resetSpot("a");
      expect(spotOf("a")).toBe("sidebar");
      expect(walkingHome("a")).toEqual({ left: 400, top: 500, width: 112, height: 112 });
      arrivedHome("a");
      expect(walkingHome("a")).toBeUndefined();
      // never seen out: no walk, just home
      travelTo("b", "island");
      resetSpot("b");
      expect(walkingHome("b")).toBeUndefined();
    } finally {
      Object.assign(globalThis, { document: doc });
    }
  });

  it("keep in place and a hidden page send it home with no walk", () => {
    const doc = globalThis.document;
    Object.assign(globalThis, { document: { hidden: true } });
    try {
      __noteFace("a", { left: 1, top: 1, width: 34, height: 34 });
      travelTo("a", "island");
      resetSpot("a");
      expect(walkingHome("a")).toBeUndefined();
    } finally {
      Object.assign(globalThis, { document: doc });
    }
    const store = new Map([["bos-v3-keep-in-place", "1"]]);
    const ls = globalThis.localStorage;
    Object.assign(globalThis, { document: { hidden: false }, localStorage: { getItem: (k: string) => store.get(k) ?? null } });
    try {
      __noteFace("a", { left: 1, top: 1, width: 34, height: 34 });
      travelTo("a", "island");
      resetSpot("a");
      expect(walkingHome("a")).toBeUndefined();
    } finally {
      Object.assign(globalThis, { document: doc, localStorage: ls });
    }
  });
});
