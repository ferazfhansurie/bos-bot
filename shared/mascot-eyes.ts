import { z } from "zod";
export const MASCOT_EYE_IDS = ["glyph", "classic", "round", "arches", "angled"] as const;
export const mascotEyesSchema = z.enum(MASCOT_EYE_IDS);
export type MascotEyes = z.infer<typeof mascotEyesSchema>;
export const MASCOT_EYE_STYLES = [
 { id:"glyph", name:"Glyph" }, { id:"classic", name:"Classic pills" }, { id:"round", name:"Round" },
 { id:"arches", name:"Soft arches" }, { id:"angled", name:"Angled" },
] as const;
/** A bot's eye style. Glyph faces (shared/glyph-faces.ts) are the default for
 * every bot; an explicit classic/round/arches/angled stays as picked. */
export function botMascotEyes(value: unknown): MascotEyes { return mascotEyesSchema.safeParse(value).data ?? "glyph"; }
