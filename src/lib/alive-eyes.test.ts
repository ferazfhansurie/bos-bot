import { describe, expect, it } from "vitest";
import { DOUBLE_BLINK, GAZE_RADIUS, nextBlink, pointerGaze } from "./alive-eyes";

describe("alive eyes", () => {
  it("watches a pointer within reach and lets go past it", () => {
    const centre = { x: 100, y: 100 };
    expect(pointerGaze({ x: 100, y: 100 }, centre)).toEqual({ x: 0, y: 0 });
    const right = pointerGaze({ x: 190, y: 100 }, centre)!;
    expect(right.x).toBeGreaterThan(0.4);
    expect(right.y).toBe(0);
    const upLeft = pointerGaze({ x: 0, y: 0 }, centre)!;
    expect(upLeft.x).toBeLessThan(0);
    expect(upLeft.y).toBeLessThan(0);
    // at the edge it looks all the way, never past
    expect(pointerGaze({ x: 100 + GAZE_RADIUS, y: 100 }, centre)).toEqual({ x: 1, y: 0 });
    expect(pointerGaze({ x: 100 + GAZE_RADIUS + 1, y: 100 }, centre)).toBeNull();
  });

  it("blinks at random inside the cadence, half as often while you type", () => {
    const seq = (values: number[]) => () => values.shift() ?? 0;
    expect(nextBlink([6000, 14000], { rand: seq([0, 0.9]) })).toEqual({ delayMs: 6000, double: false });
    expect(nextBlink([6000, 14000], { rand: seq([1, 0.9]) })).toEqual({ delayMs: 14000, double: false });
    expect(nextBlink([6000, 14000], { slow: true, rand: seq([0.5, 0.9]) })).toEqual({ delayMs: 20000, double: false });
    expect(nextBlink([6000, 14000], { rand: seq([0.5, DOUBLE_BLINK / 2]) }).double).toBe(true);
  });

  it("is not a fixed loop", () => {
    const delays = new Set(Array.from({ length: 20 }, () => nextBlink([6000, 14000]).delayMs));
    expect(delays.size).toBeGreaterThan(5);
  });
});
