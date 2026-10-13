// The desktop launch splash draws your own bots, like the iPhone's
// LaunchSplashView. It runs before React, so the app hands the main process
// a snapshot of the squad (chief in the middle, up to four more) as finished
// SVG, and the next launch shows it.
import { flatMascotBody } from "../../shared/flat-mascot-bodies";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { resolveMausColor, type GlyphFaceState } from "../../shared/glyph-faces";
import { glyphFaceMarkup, glyphFaceParts } from "./glyph-face";
import type { MausColor } from "./mascot";

export interface SplashBot {
  id: string;
  color: MausColor;
  mascotBody?: MascotBodyId | null;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  remote?: unknown;
  homeLink?: unknown;
}

/** One squad member: its resting and smiling faces as standalone SVG, padded
 * 20 units each side so the smile's accent is not clipped. */
export interface SplashMember { idle: string; happy: string }

function face(color: MausColor, bodyId: MascotBodyId | null | undefined, state: GlyphFaceState): string {
  const body = flatMascotBody(bodyId ?? "circle");
  const fill = resolveMausColor(color);
  // the splash is always on black, so an accent that would vanish goes white
  const parts = glyphFaceParts({ state, color: fill, centre: [50 + body.faceX, 50 + body.faceY], diameter: 80, pixels: 96, accentFallback: "#FCFCFC" });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 140 140"><path d="${body.path}" fill="${fill}"/>${glyphFaceMarkup(parts)}</svg>`;
}

/** Chief first, then up to four more of your own visible bots. */
export function splashSquad(bots: SplashBot[]): SplashMember[] {
  const own = bots.filter(bot => !bot.hidden && !bot.remote && !bot.homeLink);
  const chief = own.find(bot => bot.chiefOfStaff) ?? own[0];
  if (!chief) return [];
  return [chief, ...own.filter(bot => bot.id !== chief.id).slice(0, 4)].map(bot => ({
    idle: face(bot.color, bot.mascotBody, "idle"),
    happy: face(bot.color, bot.mascotBody, "happy"),
  }));
}
