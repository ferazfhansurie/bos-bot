import { describe, expect, it } from "vitest";
import { GLYPH_FACES, GLYPH_LAYOUT, GLYPH_PATHS, GLYPH_STROKE, MAUS_COLORS } from "../../shared/glyph-faces";
import { ACCENT_FALLBACK, glyphAccentColor, glyphFaceMarkup, glyphFaceParts } from "./glyph-face";

const MAUS_GREEN = MAUS_COLORS.green;

const numbers = (transform: string) => transform.match(/-?[\d.]+/g)!.map(Number);
const closeTo = (actual: number[], expected: number[]) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 2));

const parts = (over: Partial<Parameters<typeof glyphFaceParts>[0]> = {}) =>
  glyphFaceParts({ state: "working", color: "green", centre: [50, 50], diameter: 80, pixels: 80, ...over });

describe("glyphFaceParts", () => {
  it("places both eyes from the shared layout and tilts the pair", () => {
    const face = parts();
    const box = GLYPH_LAYOUT.eyeBox * 80;
    expect(face.eyes.map(eye => eye.d)).toEqual([GLYPH_PATHS.plus, GLYPH_PATHS.plus]);
    closeTo(numbers(face.eyes[0].transform), [50 - GLYPH_LAYOUT.eyeX * 80 - box / 2, 50 + GLYPH_LAYOUT.eyeY * 80 - box / 2, box / 24]);
    closeTo(numbers(face.eyes[1].transform), [50 + GLYPH_LAYOUT.eyeX * 80 - box / 2, 50 + GLYPH_LAYOUT.eyeY * 80 - box / 2, box / 24]);
    expect(face.tilt).toBe("rotate(-12 50 50)");
    expect(face.eyes[0].width).toBe(GLYPH_STROKE);
  });

  it("anchors every accent where the table says, and only on faces 24px and up", () => {
    for (const [state, face] of Object.entries(GLYPH_FACES)) {
      const big = parts({ state: state as keyof typeof GLYPH_FACES });
      expect(big.accent?.id ?? null).toBe(face.accent);
      expect(parts({ state: state as keyof typeof GLYPH_FACES, pixels: 23 }).accent).toBeNull();
    }
    const left = parts({ state: "waiting" }).accent!;
    const a = GLYPH_LAYOUT.accent.left;
    closeTo(numbers(left.transform), [50 + a.x * 80 - a.box * 40, 50 + a.y * 80 - a.box * 40, a.box * 80 / 24]);
  });

  it("keeps strokes at least 1.5px on a 16px face", () => {
    const face = parts({ pixels: 16 });
    const px = face.eyes[0].width * (GLYPH_LAYOUT.eyeBox * 80 / 24) * (16 / 80);
    expect(px).toBeCloseTo(GLYPH_LAYOUT.minStrokePx, 5);
  });

  it("inks the eyes for the body and accepts any hex", () => {
    expect(parts({ color: "white" }).ink).toBe("#000000");
    expect(parts({ color: "#1e1e2e" })).toMatchObject({ body: "#1E1E2E", ink: "#FFFFFF" });
    expect(parts({ color: "junk" }).body).toBe("#009957");
  });

  it("falls the accent back to the theme ink only for near-black and near-white bodies", () => {
    expect(glyphAccentColor("#009957")).toBe("#009957");
    expect(glyphAccentColor("#7C3AED")).toBe("#7C3AED");
    expect(glyphAccentColor("#1E1E2E")).toBe(ACCENT_FALLBACK);
    expect(glyphAccentColor("#FFFFFF")).toBe(ACCENT_FALLBACK);
    expect(glyphAccentColor("#FFFFFF", "#111111")).toBe("#111111");
  });

  it("writes standalone markup for the notification icon", () => {
    const markup = glyphFaceMarkup(parts({ state: "idle" }));
    expect(markup.split(GLYPH_PATHS.dot).length - 1).toBe(2);
    expect(markup).toContain('stroke="#000000"');
  });

  it("draws heavy dots at rest and every part of a layered eye", () => {
    const idle = parts({ state: "idle" });
    expect(idle.eyes.map(eye => eye.id)).toEqual(["dot", "dot"]);
    expect(idle.eyes[0].width).toBeCloseTo(GLYPH_STROKE * 3.2);
    expect(idle.gaze).toEqual([0, 0]);
    const drowsy = parts({ state: "drowsy" });
    expect(drowsy.eyeParts.map(eye => eye.map(m => m.id))).toEqual([["dot", "lowLid"], ["dot", "lowLid"]]);
    expect(drowsy.eyeParts[0][0].transform).toBe(drowsy.eyeParts[0][1].transform);
    expect(drowsy.gaze[1]).toBeGreaterThan(0);
  });

  it("paints a cheek blush in the colour opposite the eyes", () => {
    expect(parts({ state: "shy", color: "green" }).accentColor).toBe("rgba(255,255,255,0.55)");
    expect(parts({ state: "shy", color: "purple" }).accentColor).toBe("rgba(0,0,0,0.55)");
    expect(parts({ state: "happy", color: "green" }).accentColor).toBe(MAUS_GREEN);
  });

  it("carries the face's motion", () => {
    expect(parts({ state: "thinking" }).motion).toEqual(GLYPH_FACES.thinking.motion);
  });
});
