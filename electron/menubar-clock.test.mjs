import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Tray: class {}, nativeImage: {} }));
const { clockElapsed, clockTitle, parseClock, ringBitmap } = await import("./menubar-clock.mjs");

describe("menu bar clock", () => {
  const raw = { botId: "c", threadId: "t", name: "Cash", color: "#33dd88", needsYou: false, start: 1_000, plan: { index: 3, count: 5 }, more: 0 };

  it("reads like the phone's card: name, plan, one job clock", () => {
    expect(clockTitle(parseClock(raw), 253_000)).toBe(" cash 3/5 · 4:12");
    expect(clockTitle(parseClock({ ...raw, needsYou: true, plan: undefined, more: 1 }), 49_000)).toBe(" cash needs you · 0:48 +1");
    expect(clockTitle(null, 0)).toBe("");
    expect(clockElapsed(3_789_000)).toBe("1:03:09");
  });

  it("drops a snapshot it cannot trust", () => {
    expect(parseClock({ ...raw, name: " " })).toBeNull();
    expect(parseClock(null)).toBeNull();
    expect(parseClock({ ...raw, color: "red; x", plan: { index: 1, count: 1 } })).toMatchObject({ color: "#ffffff", plan: null });
  });

  it("draws finished steps solid and the rest faint", () => {
    const px = (buf, x, y) => buf.readUInt32BE((y * 36 + x) * 4);
    const ring = ringBitmap(parseClock(raw));
    expect(ring.length).toBe(36 * 36 * 4);
    // twelve o'clock-ish right of the gap: step 1, done, full alpha
    const top = ring[(5 * 36 + 21) * 4 + 3];
    // nine o'clock-ish: step 5, still to do, faint
    const left = ring[(18 * 36 + 5) * 4 + 3];
    expect(top).toBeGreaterThan(200);
    expect(left).toBeLessThan(80);
    expect(left).toBeGreaterThan(0);
    expect(px(ring, 18, 18)).toBe(0);
  });
});
