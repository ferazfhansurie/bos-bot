/** Accessories a bot mascot can wear: a hat, glasses, a mustache, a bow tie.
 * One per slot. Every piece is flat SVG drawn in the flat bodies' 100-unit box
 * (shared/flat-mascot-bodies.ts) and placed from the body's own outline, so a
 * new body needs no hand-tuned anchors and a new accessory is one catalog row
 * plus one draw function in mascot-accessory-art.ts. This half has no
 * relative imports so the server (node strip-types) and the app share it. */
import { z } from "zod";

export const MASCOT_ACCESSORY_SLOTS = ["head", "eyes", "mouth", "neck"] as const;
export type MascotAccessorySlot = (typeof MASCOT_ACCESSORY_SLOTS)[number];

export const MASCOT_ACCESSORIES = [
  { id: "top-hat", name: "Top hat", slot: "head" },
  { id: "cap", name: "Cap", slot: "head" },
  { id: "beanie", name: "Beanie", slot: "head" },
  { id: "crown", name: "Crown", slot: "head" },
  { id: "party-hat", name: "Party hat", slot: "head" },
  { id: "bow", name: "Bow", slot: "head" },
  { id: "headphones", name: "Headphones", slot: "head" },
  { id: "round-glasses", name: "Round glasses", slot: "eyes" },
  { id: "sunglasses", name: "Sunglasses", slot: "eyes" },
  { id: "mustache", name: "Mustache", slot: "mouth" },
  { id: "bow-tie", name: "Bow tie", slot: "neck" },
  { id: "scarf", name: "Scarf", slot: "neck" },
] as const satisfies ReadonlyArray<{ id: string; name: string; slot: MascotAccessorySlot }>;

export type MascotAccessoryId = (typeof MASCOT_ACCESSORIES)[number]["id"];
type SlotIds<S extends MascotAccessorySlot> = Extract<(typeof MASCOT_ACCESSORIES)[number], { slot: S }>["id"];

function slotSchema<S extends MascotAccessorySlot>(slot: S) {
  const ids = MASCOT_ACCESSORIES.filter(a => a.slot === slot).map(a => a.id) as [SlotIds<S>, ...SlotIds<S>[]];
  return z.enum(ids, { error: `${slot} must be one of ${ids.join(", ")}` });
}

/** What a bot wears, one id per slot; an absent slot is bare. */
export const mascotAccessoriesSchema = z.object({
  head: slotSchema("head").optional(),
  eyes: slotSchema("eyes").optional(),
  mouth: slotSchema("mouth").optional(),
  neck: slotSchema("neck").optional(),
}, { error: "mascotAccessories must be an object of slot → accessory id" }).strict();
export type MascotAccessories = z.infer<typeof mascotAccessoriesSchema>;

/** A persisted or wire value, read leniently: unknown ids drop out slot by
 * slot (an older build meeting a newer accessory shows the rest), and a bot
 * wearing nothing reads as null so callers can skip the layer entirely. */
export function botMascotAccessories(value: unknown): MascotAccessories | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: MascotAccessories = {};
  for (const slot of MASCOT_ACCESSORY_SLOTS) {
    const parsed = slotSchema(slot).safeParse((value as Record<string, unknown>)[slot]);
    if (parsed.success) (out as Record<string, string>)[slot] = parsed.data;
  }
  return Object.keys(out).length ? out : null;
}

export function mascotAccessory(id: string) {
  return MASCOT_ACCESSORIES.find(a => a.id === id);
}
