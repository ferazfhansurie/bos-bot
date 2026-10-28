import { describe, expect, it } from "vitest";

import { FLAT_MASCOT_BODIES } from "./flat-mascot-bodies";
import { MAUS_COLORS } from "./glyph-faces";
import { MASCOT_ACCESSORIES, botMascotAccessories } from "./mascot-accessories";
import { accessoryAnchors, mascotAccessoryMarkup } from "./mascot-accessory-art";

describe("botMascotAccessories", () => {
  it("keeps known pieces and drops unknown ones slot by slot", () => {
    expect(botMascotAccessories({ head: "crown", eyes: "monocle", neck: "scarf" })).toEqual({ head: "crown", neck: "scarf" });
  });

  it("reads nothing worn as null", () => {
    for (const value of [undefined, null, {}, [], "crown", { head: "nope" }]) expect(botMascotAccessories(value)).toBeNull();
  });
});

describe("mascotAccessoryMarkup", () => {
  it("draws nothing when nothing is worn, so the mascot stays as it was", () => {
    expect(mascotAccessoryMarkup({ accessories: null, bodyId: "circle", color: "green" })).toBe("");
    expect(mascotAccessoryMarkup({ accessories: {}, bodyId: "circle", color: "green" })).toBe("");
  });

  it("draws every accessory on every body as finite, flat svg", () => {
    for (const body of FLAT_MASCOT_BODIES) {
      for (const piece of MASCOT_ACCESSORIES) {
        const markup = mascotAccessoryMarkup({ accessories: { [piece.slot]: piece.id }, bodyId: body.id, color: "blue" });
        expect(markup).toContain(`data-accessory="${piece.id}"`);
        expect(markup).not.toMatch(/NaN|Infinity|undefined|Gradient/);
      }
    }
  });

  it("never paints a piece in the bot's own colour", () => {
    for (const hex of Object.values(MAUS_COLORS)) {
      for (const piece of MASCOT_ACCESSORIES) {
        const markup = mascotAccessoryMarkup({ accessories: { [piece.slot]: piece.id }, bodyId: "circle", color: hex });
        expect(markup.toUpperCase(), `${piece.id} on ${hex}`).not.toContain(`FILL="${hex.toUpperCase()}"`);
      }
    }
  });

  it("puts the hat on the body's top and the bow tie at its bottom", () => {
    for (const body of FLAT_MASCOT_BODIES) {
      const anchors = accessoryAnchors(body.id);
      expect(anchors.head.y).toBeLessThan(anchors.neck.y);
      expect(anchors.head.width).toBeGreaterThan(0);
    }
  });

  it("wears pieces in slot order: neck under mouth under eyes under head", () => {
    const markup = mascotAccessoryMarkup({ accessories: { head: "cap", eyes: "sunglasses", mouth: "mustache", neck: "scarf" }, bodyId: "circle", color: "red" });
    const at = (id: string) => markup.indexOf(`data-accessory="${id}"`);
    expect(at("scarf")).toBeLessThan(at("mustache"));
    expect(at("mustache")).toBeLessThan(at("sunglasses"));
    expect(at("sunglasses")).toBeLessThan(at("cap"));
  });
});
