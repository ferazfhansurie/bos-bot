import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLAT_MASCOT_BODIES, FLAT_MASCOT_GROUPS, flatMascotBody } from "./flat-mascot-bodies";
import { mascotBodySchema } from "./mascot-bodies";
import { flatten, boundsOf } from "../scripts/mascot-bodies/geometry";

function inside(x: number, y: number, ring: [number, number][]) {
  let contained = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) contained = !contained;
  }
  return contained;
}

describe("flat mascot catalog", () => {
  it("offers 40 distinct silhouettes in five groups and accepts every persisted id", () => {
    expect(FLAT_MASCOT_BODIES).toHaveLength(40);
    expect(new Set(FLAT_MASCOT_BODIES.map(b => b.path)).size).toBe(40);
    expect(new Set(FLAT_MASCOT_BODIES.map(b => b.id)).size).toBe(40);
    for (const group of FLAT_MASCOT_GROUPS) expect(FLAT_MASCOT_BODIES.filter(b => b.group === group)).toHaveLength(8);
    for (const body of FLAT_MASCOT_BODIES) expect(mascotBodySchema.parse(body.id)).toBe(body.id);
  });
  it("preserves old hidden aliases and handles unknown data", () => {
    expect(flatMascotBody("shield").id).toBe("hexagon");
    expect(flatMascotBody("diamond").id).toBe("squircle");
    for (const id of [null, undefined, 42, "missing"]) expect(flatMascotBody(id).id).toBe("circle");
  });
  it("keeps each new silhouette in bounds with room for the full eyes and pointer motion", () => {
    for (const body of FLAT_MASCOT_BODIES.slice(8)) {
      const rings = flatten(body.path);
      expect(rings, body.id).toHaveLength(1);
      const bounds = boundsOf(rings);
      expect(bounds.minX, body.id).toBeGreaterThanOrEqual(0);
      expect(bounds.minY, body.id).toBeGreaterThanOrEqual(0);
      expect(bounds.maxX, body.id).toBeLessThanOrEqual(100);
      expect(bounds.maxY, body.id).toBeLessThanOrEqual(100);
      // Capsule-shaped stroke, not just its center: radius3 + pointer2.5.
      for (const [x, y] of [[51, 43], [54, 52], [73, 39], [76, 48]]) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) {
          expect(inside(x + body.faceX + Math.cos(angle) * 5.5, y + body.faceY + Math.sin(angle) * 5.5, rings[0]), `${body.id}: eye at ${x},${y}`).toBe(true);
        }
      }
    }
  });
  it("ships identical flat paths, labels and face offsets to Swift", () => {
    const swift = readFileSync(new URL("../ios/Sources/CompanionCore/FlatMascotBodies.swift", import.meta.url), "utf8");
    for (const body of FLAT_MASCOT_BODIES) {
      expect(swift).toContain(`Body(id: "${body.id}", name: "${body.name}", group: "${body.group}", path: "${body.path}", faceX: ${body.faceX}, faceY: ${body.faceY})`);
    }
  });
});
