import { describe, expect, it } from "vitest";
import { FOLD_SPRING, SHAPE_SPRING, Spring, notchPath } from "./spring";

const run = (spring: Spring, seconds: number) => {
  let frames = 0;
  for (let t = 0; t < seconds && spring.step(1 / 60); t += 1 / 60) frames += 1;
  return frames;
};

describe("Spring", () => {
  it("settles exactly on its target in about half a second", () => {
    const spring = new Spring(179);
    spring.set(420, SHAPE_SPRING);
    const frames = run(spring, 2);
    expect(frames).toBeLessThan(40);
    expect(spring.value).toBe(420);
    expect(spring.moving).toBe(false);
  });

  it("overshoots a little when growing, never when folding", () => {
    const grow = new Spring(0);
    grow.set(100, SHAPE_SPRING);
    let peak = 0;
    while (grow.step(1 / 60)) peak = Math.max(peak, grow.value);
    expect(peak).toBeGreaterThan(100);
    expect(peak).toBeLessThan(106);

    const fold = new Spring(100);
    fold.set(0, FOLD_SPRING);
    let low = 100;
    while (fold.step(1 / 60)) low = Math.min(low, fold.value);
    expect(low).toBeGreaterThan(-1);
  });

  it("stays stable across a dropped frame", () => {
    const spring = new Spring(0);
    spring.set(300);
    spring.step(0.5);
    expect(Number.isFinite(spring.value)).toBe(true);
    expect(Math.abs(spring.value)).toBeLessThan(400);
  });

  it("carries its speed into a new target", () => {
    const spring = new Spring(0);
    spring.set(400);
    spring.step(0.05);
    const speed = spring.velocity;
    spring.set(200);
    expect(spring.velocity).toBe(speed);
  });
});

describe("notchPath", () => {
  it("is flush with the top and centred", () => {
    const d = notchPath(380, 200, 32, 10, 6);
    expect(d.startsWith("M274 0")).toBe(true);
    expect(d).toContain("486 0Z");
    expect(d).toContain("L467.5 32");
  });

  it("keeps corners inside a tiny shape", () => {
    const d = notchPath(100, 4, 4, 22, 6);
    for (const value of d.match(/-?\d+(\.\d+)?/g)!.map(Number)) expect(Number.isFinite(value)).toBe(true);
    expect(d).not.toContain("NaN");
    expect(notchPath(100, 0, 0, 10, 6)).not.toContain("NaN");
  });
});
