import { z } from "zod";
export const MASCOT_EYE_IDS = ["classic", "round", "arches", "angled"] as const;
export const mascotEyesSchema = z.enum(MASCOT_EYE_IDS);
export type MascotEyes = z.infer<typeof mascotEyesSchema>;
export const MASCOT_EYE_STYLES = [
 { id:"classic", name:"Classic pills" }, { id:"round", name:"Round" },
 { id:"arches", name:"Soft arches" }, { id:"angled", name:"Angled" },
] as const;
export function botMascotEyes(value: unknown): MascotEyes { return mascotEyesSchema.safeParse(value).data ?? "classic"; }
