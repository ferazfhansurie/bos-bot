import { describe, expect, it } from "vitest";
import { AWAY_AFTER_MS, MacPresence, parseHidIdleMs } from "./mac-presence.ts";

describe("parseHidIdleMs", () => {
  it("reads nanoseconds of input silence", () => {
    expect(parseHidIdleMs('    | |   "HIDIdleTime" = 2500000000\n')).toBe(2_500);
    expect(parseHidIdleMs("nothing here")).toBeUndefined();
  });
});

describe("MacPresence", () => {
  it("is unknown until read, then present or away by the idle clock", async () => {
    let idleNs = 1_000_000_000;
    let now = 0;
    const presence = new MacPresence({ read: async () => `"HIDIdleTime" = ${idleNs}`, now: () => now });
    expect(presence.present()).toBeUndefined();
    await presence.refresh();
    expect(presence.present()).toBe(true);
    idleNs = (AWAY_AFTER_MS + 1_000) * 1_000_000;
    now += 10_000;
    await presence.refresh();
    expect(presence.present()).toBe(false);
  });
  it("forgets a reading that fails", async () => {
    const presence = new MacPresence({ read: async () => { throw new Error("no ioreg"); }, now: () => 0 });
    await presence.refresh();
    expect(presence.present()).toBeUndefined();
  });
});
