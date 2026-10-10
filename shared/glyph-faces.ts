/** Glyph mascot faces: a flat solid circle, two bold text-glyph eyes, and one
 * floating accent glyph outside the body in the body colour.
 *
 * This module is the one expression table for every client. Desktop imports
 * it; iOS (and android later) read shared/glyph-faces.json, generated from
 * here by `pnpm gen:glyphs` and golden-tested against it.
 *
 * Glyph geometry: every GLYPH_PATHS entry is an SVG path "d" in a 24x24 box,
 * meant to be stroked (never filled) with width GLYPH_STROKE in that box,
 * round caps and round joins. Only absolute M, L, C and Z commands are used,
 * so a native client can parse them with a few lines of code. Each glyph is
 * centred on (12, 12) and keeps its stroke inside the box.
 *
 * The whole face (both eyes) is rotated GLYPH_TILT_DEG about the body centre,
 * which puts the left eye lower than the right. The accent is not tilted.
 * GLYPH_LAYOUT carries the suggested proportions so every platform places
 * the same face the same way. */
import type { BotActivity } from "./wire.ts";

/** The 13 named mascot colours. A bot's `color` is one of these names or a
 * "#RRGGBB" hex; read it through resolveMausColor. src/lib/mascot.ts
 * re-exports these for the desktop; glyph-faces.json carries them to iOS.
 * (They live here rather than in their own module because a shared module the
 * desktop imports cannot value-import a sibling "./x.ts".) */
export const MAUS_COLOR_NAMES = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
  "white",
  "brown",
  "gray",
] as const;

export type MausColorName = (typeof MAUS_COLOR_NAMES)[number];

export const MAUS_COLORS = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
  white: "#FFFFFF",
  brown: "#885E36",
  gray: "#808080",
} satisfies Record<MausColorName, string>;

export type GlyphId =
  | "dash" | "caret" | "ring" | "plus" | "gt" | "lt" | "star" | "cross"
  | "bang" | "query" | "dots" | "code" | "heart" | "spark" | "lid" | "zz";
export type GlyphFaceState = "idle" | "thinking" | "searching" | "working" | "waiting" | "finished" | "happy" | "failed" | "asleep";
export type AccentAnchor = "left" | "top-right" | "split";
export interface GlyphFace { left: GlyphId; right: GlyphId; accent: GlyphId | null; anchor: AccentAnchor | null }

export const GLYPH_STROKE = 3.2;
export const GLYPH_TILT_DEG = -12;

export const GLYPH_IDS = [
  "dash", "caret", "ring", "plus", "gt", "lt", "star", "cross",
  "bang", "query", "dots", "code", "heart", "spark", "lid", "zz",
] as const satisfies readonly GlyphId[];

export const GLYPH_FACE_STATES = [
  "idle", "thinking", "searching", "working", "waiting", "finished", "happy", "failed", "asleep",
] as const satisfies readonly GlyphFaceState[];

export const GLYPH_PATHS: Record<GlyphId, string> = {
  // -  a plain bar; also the blink frame for every other eye
  dash: "M4.5 12L19.5 12",
  // ^  narrow and tall, like the reference
  caret: "M6 17L12 6L18 17",
  // o  a slightly tall oval, four cubic quarters
  ring: "M12 5.5C15.31 5.5 18 8.41 18 12C18 15.59 15.31 18.5 12 18.5C8.69 18.5 6 15.59 6 12C6 8.41 8.69 5.5 12 5.5Z",
  // +
  plus: "M12 5L12 19M5 12L19 12",
  // >  wide and flat, a squeezed-shut eye
  gt: "M5 6.5L19 12L5 17.5",
  // <
  lt: "M19 6.5L5 12L19 17.5",
  // *  six-armed asterisk
  star: "M12 4L12 20M5.07 8L18.93 16M5.07 16L18.93 8",
  // x
  cross: "M6 6L18 18M18 6L6 18",
  // !  the dot is a short stroke so round caps draw it everywhere
  bang: "M12 3.5L12 14M12 19.8L12 20.2",
  // ?
  query: "M7.5 8.2C7.5 5.6 9.5 3.6 12 3.6C14.5 3.6 16.5 5.4 16.5 7.8C16.5 9.9 15.1 10.9 13.6 11.8C12.5 12.5 12 13.3 12 14.6M12 19.8L12 20.2",
  // ...
  dots: "M4.3 12L4.7 12M11.8 12L12.2 12M19.3 12L19.7 12",
  // </>
  code: "M7 7L2.5 12L7 17M13.6 4.5L10.4 19.5M17 7L21.5 12L17 17",
  // <3 as a heart outline
  heart: "M12 20C12 20 3.5 15 3.5 9.2C3.5 6.4 5.6 4.4 8.1 4.4C9.9 4.4 11.3 5.4 12 6.9C12.7 5.4 14.1 4.4 15.9 4.4C18.4 4.4 20.5 6.4 20.5 9.2C20.5 15 12 20 12 20Z",
  // ' ,  two ticks at opposite corners of the box; with anchor "split" the
  // box is centred on the body and larger than it, so one tick floats off
  // the top-left of the body and the other off the bottom-right
  spark: "M2.9 9.4C2.1 9 2 7.9 2.8 7.3M16.6 20.4C17.4 20.8 17.5 21.9 16.7 22.5",
  // u  a closed, sleeping eye
  lid: "M5 10C7.2 16.5 16.8 16.5 19 10",
  // zz  a small z and a lower, later one
  zz: "M3 4.5L9 4.5L3 10.5L9 10.5M13 12.5L19 12.5L13 18.5L19 18.5",
};

export const GLYPH_FACES: Record<GlyphFaceState, GlyphFace> = {
  idle: { left: "dash", right: "dash", accent: null, anchor: null },
  thinking: { left: "caret", right: "caret", accent: "query", anchor: "left" },
  searching: { left: "ring", right: "ring", accent: "dots", anchor: "top-right" },
  working: { left: "plus", right: "plus", accent: "code", anchor: "top-right" },
  waiting: { left: "ring", right: "ring", accent: "bang", anchor: "left" },
  finished: { left: "gt", right: "lt", accent: "spark", anchor: "split" },
  happy: { left: "star", right: "star", accent: "heart", anchor: "top-right" },
  failed: { left: "cross", right: "cross", accent: null, anchor: null },
  // a bot whose computer can't be reached right now
  asleep: { left: "lid", right: "lid", accent: "zz", anchor: "top-right" },
};

/** Suggested placement, as fractions of the body diameter D, measured from
 * the body centre (x right, y down). A glyph "box" is the 24x24 path box
 * scaled to that side length. Eyes stroke at GLYPH_STROKE; each accent anchor
 * carries its own stroke (in its 24 box) so the accent weight matches across
 * anchors: "split" spreads the spark's two ticks over a box larger than the
 * body, so it strokes thinner in box units to land at the same visual weight.
 * Renderers may adapt, but matching these keeps desktop and phone identical. */
export const GLYPH_LAYOUT = {
  /** each eye's box side */
  eyeBox: 0.4,
  /** eye centres sit at (±eyeX, eyeY), then the face rotates GLYPH_TILT_DEG */
  eyeX: 0.22,
  eyeY: 0.05,
  /** accent box centre, side and stroke per anchor (accent is not tilted) */
  accent: {
    left: { x: -0.76, y: -0.3, box: 0.48, stroke: GLYPH_STROKE },
    "top-right": { x: 0.68, y: -0.52, box: 0.52, stroke: GLYPH_STROKE },
    split: { x: 0, y: 0, box: 1.5, stroke: 1.4 },
  },
  /** hide the accent when the body is drawn smaller than this (px/pt) */
  accentMinSize: 24,
  /** never stroke thinner than this many px/pt, so 16px faces stay bold */
  minStrokePx: 1.5,
} as const;

/** Every expression name the app already uses — CursorAvatar's states, the
 * legacy ten-face names (src/lib/mascot.ts LEGACY_STATES), MAUS_MOTIONS and
 * the live-turn gestures (shared/mascot-choreography.ts) — mapped to a glyph
 * face. Anything not listed rests on idle. */
const EXPRESSION_STATES: Record<string, GlyphFaceState> = {
  // glyph states and gestures map to themselves
  idle: "idle", thinking: "thinking", searching: "searching", working: "working",
  waiting: "waiting", finished: "finished", happy: "happy", failed: "failed",
  // CursorAvatar lifecycle
  sleeping: "asleep", waking: "idle", listening: "searching",
  // CursorAvatar reactions
  excited: "happy", surprised: "waiting", suspicious: "thinking", angry: "waiting",
  drowsy: "idle", curious: "thinking", confused: "thinking", bored: "idle",
  proud: "finished", shy: "happy", sad: "idle", laughing: "finished",
  scared: "waiting", playful: "happy", celebrate: "finished",
  // CursorAvatar agent morphs
  orbit: "searching", radar: "searching", progress: "working",
  // CursorAvatar product cycle
  spawning: "idle", humming: "idle", loading: "working", dictating: "searching",
  writing: "working", sending: "working", receiving: "searching", uploading: "working",
  notifying: "waiting", alerting: "waiting", dragging: "working", bouncing: "happy",
  "powering-down": "idle",
  // legacy ten-face names
  deadpan: "idle", friendly: "happy", focused: "working", sleepy: "idle",
  skeptical: "thinking", worried: "waiting", mischievous: "happy",
  // MAUS_MOTIONS
  none: "idle", arrive: "idle", switch: "idle", customize: "idle", alert: "waiting",
  launch: "working", success: "finished", blink: "idle", surprise: "waiting", failure: "failed",
  // plain words the plan's table uses
  pending: "waiting", thanked: "happy", stopped: "failed", error: "failed", dead: "failed",
};

/** Glyph states that already describe a live turn; a working bot keeps one of
 * these instead of being flattened to "working". */
const LIVE_STATES = new Set<GlyphFaceState>(["thinking", "searching", "working"]);

/** The face to draw for a bot. Activity wins where it is decisive: a dead bot
 * is failed, a bot waiting on the person is waiting, and a working bot shows
 * working unless its expression is already a live state (thinking,
 * searching). Otherwise the expression decides; unknown -> idle. */
export function glyphStateFor(expression: string | null | undefined, activity?: BotActivity): GlyphFaceState {
  const fromExpression = (expression && Object.hasOwn(EXPRESSION_STATES, expression)
    ? EXPRESSION_STATES[expression]
    : undefined) ?? "idle";
  if (activity === "dead") return "failed";
  if (activity === "waiting-on-you") return "waiting";
  if (activity === "working") return LIVE_STATES.has(fromExpression) ? fromExpression : "working";
  return fromExpression;
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const NAMED_COLORS: ReadonlySet<string> = new Set(MAUS_COLOR_NAMES);

/** A bot colour as "#RRGGBB": a palette name maps to its hex, a 6-digit hex
 * passes through uppercased, anything else is green. */
export function resolveMausColor(color: string | null | undefined): string {
  if (typeof color !== "string") return MAUS_COLORS.green;
  if (NAMED_COLORS.has(color)) return MAUS_COLORS[color as keyof typeof MAUS_COLORS];
  if (HEX_COLOR.test(color)) return color.toUpperCase();
  return MAUS_COLORS.green;
}

/** A bot colour as stored: a palette name stays as is, a 6-digit hex is
 * uppercased, anything else is null (rejected at the API boundary). */
export function normalizeMausColor(color: unknown): string | null {
  if (typeof color !== "string") return null;
  if (NAMED_COLORS.has(color)) return color;
  if (HEX_COLOR.test(color)) return color.toUpperCase();
  return null;
}

function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Eye colour for a body: black when black contrasts at least as well as
 * white (WCAG 2 relative luminance), else white. Accepts anything
 * resolveMausColor does. */
export function glyphInk(hex: string): "#000000" | "#FFFFFF" {
  const luminance = relativeLuminance(resolveMausColor(hex));
  const againstBlack = (luminance + 0.05) / 0.05;
  const againstWhite = 1.05 / (luminance + 0.05);
  return againstBlack >= againstWhite ? "#000000" : "#FFFFFF";
}

/** The document shipped as shared/glyph-faces.json (and the iOS copy). */
export function glyphFacesDocument() {
  return {
    version: 1,
    stroke: GLYPH_STROKE,
    tiltDeg: GLYPH_TILT_DEG,
    viewBox: 24,
    states: GLYPH_FACE_STATES,
    faces: GLYPH_FACES,
    paths: GLYPH_PATHS,
    layout: GLYPH_LAYOUT,
    palette: MAUS_COLORS,
    fallbackColor: MAUS_COLORS.green,
  };
}

/** The exact bytes of glyph-faces.json. */
export function glyphFacesJson(): string {
  return JSON.stringify(glyphFacesDocument(), null, 2) + "\n";
}
