import { describe, expect, it } from "vitest";

import { bestTier, highlightRuns, matchEntry, matchText, rankByName, rankMatches, recentFirst } from "./palette-rank";

const names = (items: Array<{ name: string }>) => items.map((i) => i.name);

describe("rankByName", () => {
  it("puts prefix matches above substring matches", () => {
    const items = [{ name: "Big Momo" }, { name: "Momo" }, { name: "Lemon Momo" }];
    expect(names(rankByName(items, "mo"))).toEqual(["Momo", "Big Momo", "Lemon Momo"]);
  });

  it("matches case-insensitively on both sides", () => {
    const items = [{ name: "MOSS" }, { name: "quiet moss" }];
    expect(names(rankByName(items, "Moss"))).toEqual(["MOSS", "quiet moss"]);
  });

  it("keeps input order within a tier", () => {
    const items = [{ name: "Miso One" }, { name: "Miso Two" }, { name: "A Miso" }, { name: "B Miso" }];
    expect(names(rankByName(items, "miso"))).toEqual(["Miso One", "Miso Two", "A Miso", "B Miso"]);
  });

  it("filters out non-matches", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(rankByName(items, "zebra")).toEqual([]);
    expect(names(rankByName(items, "oss"))).toEqual(["Moss"]);
  });

  it("returns everything in input order for an empty or whitespace query", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(names(rankByName(items, ""))).toEqual(["Momo", "Moss"]);
    expect(names(rankByName(items, "   "))).toEqual(["Momo", "Moss"]);
  });
});

describe("word-start tier", () => {
  it("ranks a later word's start above a mid-word substring", () => {
    const items = [{ name: "Lemon" }, { name: "Big Momo" }, { name: "Momo" }];
    expect(names(rankByName(items, "mo"))).toEqual(["Momo", "Big Momo", "Lemon"]);
  });

  it("treats punctuation as a word boundary", () => {
    const items = [{ name: "infra-ops" }, { name: "shops" }];
    expect(names(rankByName(items, "op"))).toEqual(["infra-ops", "shops"]);
  });
});

describe("fuzzy tier", () => {
  it("matches a subsequence below every contiguous match", () => {
    const items = [{ name: "bos bots" }, { name: "Abba" }, { name: "bbq" }];
    expect(names(rankByName(items, "bb"))).toEqual(["bbq", "Abba", "bos bots"]);
  });

  it("ignores spaces in the query for the subsequence", () => {
    expect(matchText("bos bots", "b b")).toEqual({ kind: "fuzzy", indices: [0, 4] });
  });

  it("prefers word starts when highlighting a subsequence", () => {
    // greedy would light the mid-word b in "abc"; the initials read better
    expect(matchText("bos abc bots", "bb")).toEqual({ kind: "fuzzy", indices: [0, 8] });
  });

  it("falls back to a greedy subsequence when word starts cannot cover it", () => {
    expect(matchText("research", "rsh")).toEqual({ kind: "fuzzy", indices: [0, 2, 7] });
  });

  it("does not fuzz a single character", () => {
    expect(matchText("Momo", "z")).toBeNull();
  });
});

describe("matchText", () => {
  it("returns highlight indices for each contiguous tier", () => {
    expect(matchText("Momo", "MO")).toEqual({ kind: "prefix", indices: [0, 1] });
    expect(matchText("Big Momo", "mo")).toEqual({ kind: "word", indices: [4, 5] });
    expect(matchText("Lemon", "mo")).toEqual({ kind: "substring", indices: [2, 3] });
  });

  it("indexes by code point so emoji do not shift the highlight", () => {
    expect(matchText("🦊 fox", "fox")).toEqual({ kind: "word", indices: [2, 3, 4] });
  });
});

describe("title matching", () => {
  it("matches a bot's title below any name substring but above name fuzz", () => {
    const items = [
      { name: "Kit", title: "Researcher" },
      { name: "Riser" }, // no "res" in order, so it drops out
      { name: "Ares" },
      { name: "r e s" },
    ];
    expect(names(rankByName(items, "res"))).toEqual(["Ares", "Kit", "r e s"]);
  });

  it("reports which field matched", () => {
    expect(matchEntry({ name: "Kit", title: "Researcher" }, "rese")).toMatchObject({ field: "title", kind: "prefix", tier: 3 });
    expect(matchEntry({ name: "Kit", title: "Researcher" }, "ki")).toMatchObject({ field: "name", kind: "prefix", tier: 0 });
  });

  it("does not fuzzy-match titles", () => {
    expect(matchEntry({ name: "Kit", title: "Research" }, "rh")).toBeNull();
  });
});

describe("rankMatches", () => {
  it("returns every item with no match in switcher mode", () => {
    const ranked = rankMatches([{ id: 1 }, { id: 2 }], "  ", () => ({ name: "x" }));
    expect(ranked).toEqual([{ item: { id: 1 }, match: null }, { item: { id: 2 }, match: null }]);
  });

  it("reads the fields through the accessor", () => {
    const actions = [{ label: "New bot", keywords: "create add" }, { label: "Settings", keywords: "preferences" }];
    const ranked = rankMatches(actions, "pref", (a) => ({ name: a.label, title: a.keywords }));
    expect(ranked.map((r) => r.item.label)).toEqual(["Settings"]);
    expect(bestTier(ranked)).toBe(3);
    expect(bestTier([])).toBe(Infinity);
  });
});

describe("highlightRuns", () => {
  it("merges neighbouring hits into one run", () => {
    expect(highlightRuns("bos bots", [0, 1, 4])).toEqual([
      { text: "bo", hit: true },
      { text: "s ", hit: false },
      { text: "b", hit: true },
      { text: "ots", hit: false },
    ]);
  });

  it("returns the text whole without indices", () => {
    expect(highlightRuns("Momo", undefined)).toEqual([{ text: "Momo", hit: false }]);
  });
});

describe("recentFirst", () => {
  it("orders by activity, caps, and drops never-active items", () => {
    const items = [
      { id: "a", at: 10 },
      { id: "b", at: 0 },
      { id: "c", at: 30 },
      { id: "d", at: 20 },
    ];
    expect(recentFirst(items, (i) => i.at, 2).map((i) => i.id)).toEqual(["c", "d"]);
    expect(recentFirst(items, (i) => i.at, 10).map((i) => i.id)).toEqual(["c", "d", "a"]);
  });
});
