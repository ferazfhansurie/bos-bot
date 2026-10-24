import { beforeEach, describe, expect, it } from "vitest";

import { isPinned, pinPage, readPins, unpinPage } from "./pins";

const memory = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) },
  window: Object.assign(new EventTarget(), {}),
});

describe("new tab pins", () => {
  beforeEach(() => memory.clear());
  const deck = { botId: "bos", threadId: "t1", path: "bos-pages/deck.html", title: "Deck" };

  it("pins in the order added, refreshes a title instead of duplicating, and unpins", () => {
    pinPage(deck);
    pinPage({ ...deck, path: "bos-pages/dash.html", title: "Dash" });
    pinPage({ ...deck, title: "Deck v2" });
    expect(readPins().map(p => p.title)).toEqual(["Deck v2", "Dash"]);
    unpinPage(deck);
    expect(readPins().map(p => p.path)).toEqual(["bos-pages/dash.html"]);
  });

  it("treats the same file name in two chats as two pages", () => {
    pinPage(deck);
    pinPage({ ...deck, threadId: "t2" });
    expect(readPins()).toHaveLength(2);
    expect(isPinned(readPins(), { botId: "bos", threadId: "t2", path: deck.path })).toBe(true);
    expect(isPinned(readPins(), { botId: "other", threadId: "t1", path: deck.path })).toBe(false);
  });

  it("ignores junk in storage", () => {
    memory.set("bos.newtab.pins", JSON.stringify([{ botId: 1 }, deck, "x"]));
    expect(readPins()).toEqual([deck]);
    memory.set("bos.newtab.pins", "{not json");
    expect(readPins()).toEqual([]);
  });
});
