import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOTION, SPRINGS, settleMs, springAt } from "./mascot-motion";

const JSON_PATH = new URL("./motion.json", import.meta.url);
const generated = `${JSON.stringify(MOTION, null, 2)}\n`;

describe("motion table", () => {
  it("motion.json matches mascot-motion.ts (UPDATE_MOTION=1 regenerates it)", () => {
    if (process.env.UPDATE_MOTION === "1") writeFileSync(JSON_PATH, generated);
    expect(readFileSync(JSON_PATH, "utf8")).toBe(generated);
  });

  it("every spring starts at rest, ends at rest and settles in a sane time", () => {
    for (const spec of Object.values(SPRINGS)) {
      expect(springAt(spec, 0)).toBeCloseTo(0, 6);
      expect(Math.abs(1 - springAt(spec, settleMs(spec) / 1000))).toBeLessThan(0.002);
      expect(settleMs(spec)).toBeGreaterThan(100);
      expect(settleMs(spec)).toBeLessThan(3000);
    }
    for (const spring of Object.values(MOTION.springs)) {
      expect(spring.css).toMatch(/^linear\(0, .*, 1\)$/);
    }
  });

  it("carries the mascot gesture timings the desktop plays", () => {
    expect(MOTION.gestures.finished).toEqual({ playMs: 900, restMs: 0 });
    expect(Object.keys(MOTION.gestures)).toEqual(["thinking", "searching", "reading", "browsing", "writing", "working", "waiting", "finished", "idle"]);
  });
});
