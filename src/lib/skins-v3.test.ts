// The v3 flag must be a no-op while off: every value the pre-3.0 lookup could
// meet resolves the same way. Under 3.0, liquid glass is a layer over any
// skin, on by default, and never changes which skin is worn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SKIN, SKIN_IDS, glassOn, migrateGlassSkin, pickSkin, pickableSkins, readSkin, setGlass } from "./skins";

let data: Map<string, string>;
let dark = true;
beforeEach(() => {
  data = new Map();
  dark = true;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("dark") ? dark : false }));
  // applySkin stamps the document and pokes the windows caption bridge
  vi.stubGlobal("document", { documentElement: { dataset: {} as Record<string, string> } });
  vi.stubGlobal("window", { matchMedia: globalThis.matchMedia });
});
afterEach(() => vi.unstubAllGlobals());

describe("readSkin with v3 off", () => {
  it("is the pre-3.0 lookup", () => {
    expect(readSkin()).toBe(DEFAULT_SKIN);
    for (const id of SKIN_IDS) {
      data.set("omb-skin", id);
      expect(readSkin()).toBe(id);
    }
    data.set("omb-skin", "renamed-long-ago");
    expect(readSkin()).toBe(DEFAULT_SKIN);
    expect(data.has("bos-glass")).toBe(false);
  });

  it("offers every skin, and no glass skins", () => {
    expect(pickableSkins().map((s) => s.id)).toEqual([...SKIN_IDS]);
    expect(SKIN_IDS.some((id) => id.startsWith("glass-"))).toBe(false);
  });
});

describe("liquid glass under 3.0", () => {
  it("a fresh install starts with glass on, over the default skin", () => {
    expect(readSkin(true)).toBe(DEFAULT_SKIN);
    expect(glassOn()).toBe(true);
    expect(data.get("bos-glass")).toBe("1");
  });

  it("an existing user keeps their skin and gets glass over it", () => {
    data.set("omb-skin", "lagoon");
    expect(readSkin(true)).toBe("lagoon");
    expect(glassOn()).toBe(true);
  });

  it("the switch frosts the skin being worn and never changes it", () => {
    data.set("omb-skin", "foundry");
    readSkin(true);
    setGlass(false);
    expect(glassOn()).toBe(false);
    expect(document.documentElement.dataset.liquidGlass).toBeUndefined();
    // off sticks across launches
    expect(readSkin(true)).toBe("foundry");
    expect(glassOn()).toBe(false);
    setGlass(true);
    expect(document.documentElement.dataset.liquidGlass).toBe("");
    expect(readSkin(true)).toBe("foundry");
  });

  it("picking from the grid leaves glass as it was", () => {
    data.set("bos-glass", "1");
    pickSkin("sakura");
    expect(glassOn()).toBe(true);
    expect(readSkin(true)).toBe("sakura");
    data.set("bos-glass", "0");
    pickSkin("velvet");
    expect(glassOn()).toBe(false);
    expect(readSkin(true)).toBe("velvet");
  });

  it("an early 3.0 glass skin becomes its matching flat skin, once", () => {
    data.set("omb-skin", "glass-dark");
    data.set("bos-glass", "1");
    expect(readSkin(true)).toBe("midnight");
    expect(data.get("omb-skin")).toBe("midnight");
    expect(glassOn()).toBe(true);
    data.set("omb-skin", "glass-light");
    expect(readSkin(false)).toBe("daylight");
  });

  it("the migration prefers the flat skin worn before, when it is the same light or dark", () => {
    expect(migrateGlassSkin("glass-dark", "dusk")).toBe("dusk");
    expect(migrateGlassSkin("glass-light", "linen")).toBe("linen");
    expect(migrateGlassSkin("glass-dark", "linen")).toBe("midnight");
    expect(migrateGlassSkin("glass-light", "foundry")).toBe("daylight");
    expect(migrateGlassSkin("glass-light", null)).toBe("daylight");
  });
});
