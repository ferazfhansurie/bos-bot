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
  | "bang" | "query" | "dots" | "code" | "heart" | "spark" | "lid" | "zz"
  // B · sharp dots (2026-10-27): eye parts
  | "dot" | "ringS" | "arc" | "spiral" | "dollar" | "lowLid"
  | "browAngryL" | "browAngryR" | "browSadL" | "browSadR" | "browUp"
  // and the accents that go with the new faces
  | "page" | "pencil" | "plane" | "check" | "tear" | "blush" | "coin" | "bolt"
  | "wave" | "phone" | "arrow" | "burst" | "confetti" | "sweat";
export type GlyphFaceState =
  // home base
  | "idle" | "glance" | "listening" | "noticed" | "drowsy" | "asleep"
  // working, from the real tool
  | "thinking" | "searching" | "reading" | "writing" | "working" | "focused" | "sending"
  | "waiting" | "finished" | "nailed-it"
  // feelings
  | "happy" | "love" | "excited" | "surprised" | "confused" | "skeptical" | "determined"
  | "sad" | "scared" | "shy" | "wink" | "dizzy" | "failed"
  // more life
  | "waking" | "yawn" | "curious" | "proud" | "laughing" | "mind-blown" | "celebrate"
  | "nervous" | "bored" | "voice" | "calling" | "handing-off" | "waiting-mate"
  // cash only
  | "ka-ching";
export type AccentAnchor = "left" | "top-right" | "split" | "cheek" | "below";

/** One stroke of an eye: a glyph and its stroke weight, as a multiple of
 * GLYPH_STROKE. A heavy round-cap "dot" (weight 3.2) is the resting eye;
 * brows and lids are extra parts drawn in the same eye box. */
export interface GlyphEyePart { glyph: GlyphId; weight: number }

/** Named motions every renderer may play for a face (desktop plays all of
 * them; a still surface ignores them). `eyes` moves the eye pair (spin,
 * twinkle and beat move each eye about its own centre), `accent` the accent,
 * `body` the whole mascot. Times and curves: src/lib/glyph-motion.ts. */
export type GlyphEyeMotion =
  | "look" | "lean" | "drift" | "scan" | "read" | "bob" | "pulse" | "pop" | "shake"
  | "breathe" | "slow" | "spin" | "twinkle" | "beat" | "tilt" | "giggle";
export type GlyphAccentMotion = "float" | "fly" | "burst" | "pulse" | "ring" | "slide";
export type GlyphBodyMotion = "hop" | "squish" | "stretch" | "giggle" | "tap";
export interface GlyphMotion { eyes?: GlyphEyeMotion; accent?: GlyphAccentMotion; body?: GlyphBodyMotion }

export interface GlyphFace {
  /** each eye's main glyph (the first part), for readers that draw one stroke */
  left: GlyphId;
  right: GlyphId;
  accent: GlyphId | null;
  anchor: AccentAnchor | null;
  leftParts: GlyphEyePart[];
  rightParts: GlyphEyePart[];
  /** where the eyes look: both shift by [x, y] body diameters, before the tilt */
  gaze: [number, number];
  motion: GlyphMotion;
}

export const GLYPH_STROKE = 3.2;
export const GLYPH_TILT_DEG = -12;

export const GLYPH_IDS = [
  "dash", "caret", "ring", "plus", "gt", "lt", "star", "cross",
  "bang", "query", "dots", "code", "heart", "spark", "lid", "zz",
  "dot", "ringS", "arc", "spiral", "dollar", "lowLid",
  "browAngryL", "browAngryR", "browSadL", "browSadR", "browUp",
  "page", "pencil", "plane", "check", "tear", "blush", "coin", "bolt",
  "wave", "phone", "arrow", "burst", "confetti", "sweat",
] as const satisfies readonly GlyphId[];

/** Brows sit above the eye in the same box, so their y runs up to -3. */
export const GLYPH_BROWS = ["browAngryL", "browAngryR", "browSadL", "browSadR", "browUp"] as const satisfies readonly GlyphId[];

export const GLYPH_FACE_STATES = [
  "idle", "glance", "listening", "noticed", "drowsy", "asleep",
  "thinking", "searching", "reading", "writing", "working", "focused", "sending", "waiting", "finished", "nailed-it",
  "happy", "love", "excited", "surprised", "confused", "skeptical", "determined", "sad", "scared", "shy", "wink", "dizzy", "failed",
  "waking", "yawn", "curious", "proud", "laughing", "mind-blown", "celebrate", "nervous", "bored", "voice", "calling",
  "handing-off", "waiting-mate",
  "ka-ching",
] as const satisfies readonly GlyphFaceState[];

export const GLYPH_PATHS: Record<GlyphId, string> = {
  // -  a plain bar
  dash: "M4.5 12L19.5 12",
  // ^  narrow and tall (no longer a face; kept for the phone's list moods)
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
  // .  a near-zero stroke: its round caps draw the heavy resting dot
  dot: "M12 11.9L12 12.1",
  // o  a small ring, for searching
  ringS: "M12 7.5C14.5 7.5 16.5 9.5 16.5 12C16.5 14.5 14.5 16.5 12 16.5C9.5 16.5 7.5 14.5 7.5 12C7.5 9.5 9.5 7.5 12 7.5Z",
  // n  a smiling, upturned eye
  arc: "M5.5 15C7.5 8.5 16.5 8.5 18.5 15",
  // @  dizzy
  spiral: "M12 12C12 10.6 13.9 10.6 13.9 12C13.9 14.3 10.1 14.3 10.1 12C10.1 8.6 15.9 8.6 15.9 12C15.9 16.3 8.1 16.3 8.1 12C8.1 7 17.8 6.8 18.6 11",
  // $
  dollar: "M16 7.6C15.1 6.2 13.7 5.6 12 5.6C9.8 5.6 8.3 6.7 8.3 8.4C8.3 12.4 16 11 16 15.3C16 17.2 14.3 18.4 12 18.4C10.2 18.4 8.7 17.7 7.8 16.3M12 3.2L12 20.8",
  // a flat heavy lid over a dot, for drowsy
  lowLid: "M5 9.5L19 9.5",
  // brows, above the eye in the same box
  browAngryL: "M5 -3L17 1.5",
  browAngryR: "M19 -3L7 1.5",
  browSadL: "M5 1.5L17 -3",
  browSadR: "M19 1.5L7 -3",
  browUp: "M6 0C9 -2.8 15 -2.8 18 0",
  // accents
  page: "M7 3.5L14 3.5L18 7.5L18 20.5L7 20.5Z M10 11L15 11M10 15L15 15",
  pencil: "M5 19L6.2 14.8L15.8 5.2L18.8 8.2L9.2 17.8Z",
  plane: "M3 11.5L21 4L15.5 20L11.5 13.5Z M11.5 13.5L21 4",
  check: "M4.5 12.5L9.5 17.5L19.5 6.5",
  tear: "M12 5C12 5 8 11 8 14.2C8 16.4 9.8 18.2 12 18.2C14.2 18.2 16 16.4 16 14.2C16 11 12 5 12 5Z",
  blush: "M5 15L8 10M10.5 15L13.5 10M16 15L19 10",
  coin: "M12 4C16.4 4 20 7.6 20 12C20 16.4 16.4 20 12 20C7.6 20 4 16.4 4 12C4 7.6 7.6 4 12 4Z M12 8L12 16",
  bolt: "M13.5 3L6 13.5L11.5 13.5L10.5 21L18 10.5L12.5 10.5Z",
  wave: "M5 9C6.5 10.5 6.5 13.5 5 15M9.5 6.5C12.5 9.5 12.5 14.5 9.5 17.5M14 4C18.5 8.5 18.5 15.5 14 20",
  phone: "M7 4L10 4L11.5 8L9.5 9.5C10.5 11.8 12.2 13.5 14.5 14.5L16 12.5L20 14L20 17C20 18.7 18.7 20 17 20C10.4 20 4 13.6 4 7C4 5.3 5.3 4 7 4Z",
  arrow: "M4 12L19 12M14 7L19 12L14 17",
  burst: "M12 2L12 6M12 18L12 22M2 12L6 12M18 12L22 12M5 5L7.8 7.8M16.2 16.2L19 19M19 5L16.2 7.8M7.8 16.2L5 19",
  confetti: "M4 6L6 4M18 4L20 6.5M3 16L5.5 15M19 17L21 19M10 3L10.5 5.5M14 20L13 22",
  sweat: "M12 5C12 5 9.5 9 9.5 11C9.5 12.4 10.6 13.5 12 13.5C13.4 13.5 14.5 12.4 14.5 11C14.5 9 12 5 12 5Z",
};

type PartSpec = GlyphId | [GlyphId, number];
const part = (spec: PartSpec): GlyphEyePart =>
  typeof spec === "string" ? { glyph: spec, weight: 1 } : { glyph: spec[0], weight: spec[1] };
/** the heavy resting dot, and a smaller focused one */
const DOT: PartSpec = ["dot", 3.2];
const SMALL_DOT: PartSpec = ["dot", 2.3];
/** gaze from the reference sheet's pixels on a 64px body */
const px = (x: number, y: number): [number, number] => [round3(x / 64), round3(y / 64)];
function round3(n: number) { return Math.round(n * 1000) / 1000 || 0; }

function face(
  left: PartSpec[], right: PartSpec[],
  { accent = null, anchor = null, gaze = [0, 0], motion = {} }:
    { accent?: GlyphId | null; anchor?: AccentAnchor | null; gaze?: [number, number]; motion?: GlyphMotion } = {},
): GlyphFace {
  const leftParts = left.map(part), rightParts = right.map(part);
  return { left: leftParts[0].glyph, right: rightParts[0].glyph, accent, anchor, leftParts, rightParts, gaze, motion };
}

/** Every face in "B · sharp dots" (Firaz, 2026-10-27; reference sheet
 * bos-pages/2026-10-27-smart-eyes.html). Dots are home base, ++ stays the
 * working face, and each face names the event that shows it. */
export const GLYPH_FACES: Record<GlyphFaceState, GlyphFace> = {
  // nothing running
  idle: face([DOT], [DOT]),
  // the idle fidget, every few minutes
  glance: face([DOT], [DOT], { motion: { eyes: "look" } }),
  // the person is typing to it
  listening: face([DOT], [DOT], { motion: { eyes: "lean" } }),
  // the cursor comes near
  noticed: face([DOT], [DOT], { gaze: px(5, -3) }),
  // a long stretch with no work
  drowsy: face([["dot", 2.4], "lowLid"], [["dot", 2.4], "lowLid"], { gaze: px(0, 2), motion: { eyes: "slow" } }),
  // its computer is offline, or night
  asleep: face(["lid"], ["lid"], { accent: "zz", anchor: "top-right", motion: { eyes: "breathe", accent: "float", body: "squish" } }),
  // a turn started, no tool yet: dots glance up beside a ?
  thinking: face([DOT], [DOT], { accent: "query", anchor: "left", gaze: px(4, -5), motion: { eyes: "drift" } }),
  // a web search
  searching: face(["ringS"], ["ringS"], { accent: "dots", anchor: "top-right", motion: { eyes: "scan" } }),
  // reading a file or page
  reading: face([SMALL_DOT], [SMALL_DOT], { accent: "page", anchor: "top-right", motion: { eyes: "read" } }),
  // editing a file
  writing: face([DOT], [DOT], { accent: "pencil", anchor: "below", gaze: px(1, 4), motion: { eyes: "bob" } }),
  // running a command
  working: face(["plus"], ["plus"], { accent: "code", anchor: "top-right" }),
  // a command running for over 30s
  focused: face([SMALL_DOT], [SMALL_DOT], { accent: "bolt", anchor: "top-right" }),
  // a whatsapp or email went out (a real receipt)
  sending: face([DOT], [DOT], { accent: "plane", anchor: "top-right", gaze: px(3, -2), motion: { accent: "fly" } }),
  // needs you: an approval or a question
  waiting: face(["ring"], ["ring"], { accent: "bang", anchor: "left", motion: { eyes: "pulse" } }),
  // the job finished
  finished: face(["gt"], ["lt"], { accent: "spark", anchor: "split", motion: { body: "hop" } }),
  // tests passed, deploy healthy
  "nailed-it": face(["arc"], ["arc"], { accent: "check", anchor: "top-right", motion: { body: "hop" } }),
  // the person says thanks
  happy: face(["arc"], ["arc"], { accent: "heart", anchor: "top-right", motion: { accent: "float" } }),
  // "love it", "perfect"
  love: face([["heart", 0.9]], [["heart", 0.9]], { motion: { eyes: "beat" } }),
  // a big win, the first reply of the day
  excited: face(["star"], ["star"], { accent: "spark", anchor: "split", motion: { eyes: "twinkle", body: "hop" } }),
  // a huge paste or an image dropped in
  surprised: face([["ring", 1.1]], [["ring", 1.1]], { gaze: px(0, -1), motion: { eyes: "pop" } }),
  // an unclear ask, about to clarify
  confused: face([DOT], ["ringS"], { accent: "query", anchor: "top-right", gaze: px(2, 0) }),
  // a risky command, double-checking
  skeptical: face([DOT, "browUp"], ["dash"]),
  // retrying after a fail
  determined: face([DOT, "browAngryL"], [DOT, "browAngryR"], { gaze: px(0, 1) }),
  // the person stops it or says it's wrong
  sad: face([DOT, "browSadL"], [DOT, "browSadR"], { accent: "tear", anchor: "left", gaze: px(0, 3) }),
  // select-all + delete
  scared: face([SMALL_DOT, "browSadL"], [SMALL_DOT, "browSadR"], { motion: { eyes: "shake" } }),
  // hovered for 3s+
  shy: face([DOT], [DOT], { accent: "blush", anchor: "cheek", gaze: px(-5, 3) }),
  // a joke or an emoji
  wink: face([DOT], ["arc"], { accent: "spark", anchor: "split" }),
  // poked five times fast
  dizzy: face(["spiral"], ["spiral"], { motion: { eyes: "spin" } }),
  // a tool or job failed
  failed: face(["cross"], ["cross"], { motion: { eyes: "shake" } }),
  // a routine fires while it's asleep
  waking: face([["ring", 1.1]], [["ring", 1.1]], { accent: "bang", anchor: "top-right", gaze: px(0, -2), motion: { eyes: "pop", body: "hop" } }),
  // the first open of the day
  yawn: face(["lid"], ["lid"], { gaze: px(0, -1), motion: { eyes: "slow", body: "stretch" } }),
  // its name is mentioned
  curious: face([DOT], [["dot", 4.2]], { gaze: px(3, -2), motion: { eyes: "tilt" } }),
  // the person ships what it built
  proud: face(["arc", "browUp"], ["arc", "browUp"], { accent: "spark", anchor: "split" }),
  // haha, lol, wkwk
  laughing: face(["gt"], ["lt"], { motion: { eyes: "giggle", body: "giggle" } }),
  // a result it didn't expect
  "mind-blown": face([["ring", 1.2]], [["ring", 1.2]], { accent: "burst", anchor: "top-right", gaze: px(0, -1), motion: { eyes: "pop", accent: "burst" } }),
  // a paid sale or a big milestone
  celebrate: face(["star"], ["star"], { accent: "confetti", anchor: "split", motion: { eyes: "twinkle", accent: "float", body: "hop" } }),
  // about to do something irreversible
  nervous: face([SMALL_DOT], [SMALL_DOT], { accent: "sweat", anchor: "left", gaze: px(-2, 0), motion: { eyes: "shake" } }),
  // the person has been away a long time
  bored: face(["dash"], ["dash"], { gaze: px(-5, 1), motion: { eyes: "look" } }),
  // the person is talking to it
  voice: face([DOT], [DOT], { accent: "wave", anchor: "top-right", gaze: px(2, 0), motion: { eyes: "lean", accent: "pulse" } }),
  // ringing the person's phone
  calling: face(["ring"], ["ring"], { accent: "phone", anchor: "top-right", motion: { eyes: "pulse", accent: "ring" } }),
  // passing work to a teammate
  "handing-off": face([DOT], [DOT], { accent: "arrow", anchor: "below", gaze: px(6, 1), motion: { accent: "slide" } }),
  // a teammate hasn't replied yet
  "waiting-mate": face([DOT], [DOT], { accent: "dots", anchor: "top-right", gaze: px(6, 2), motion: { body: "tap" } }),
  // cash only: a new bos bot sign-up
  "ka-ching": face(["dollar"], ["dollar"], { accent: "coin", anchor: "top-right", motion: { accent: "float", body: "hop" } }),
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
    /** on the body, under the left eye: drawn in the colour opposite the
     * eye ink at onBodyAlpha (white blush on a mid-tone body) */
    cheek: { x: -0.02, y: 0.3, box: 0.42, stroke: 2.2, onBodyAlpha: 0.55 },
    /** under the body, a little right: the pencil and the hand-off arrow */
    below: { x: 0.12, y: 0.66, box: 0.36, stroke: GLYPH_STROKE },
  },
  /** hide the accent when the body is drawn smaller than this (px/pt) */
  accentMinSize: 24,
  /** never stroke thinner than this many px/pt, so 16px faces stay bold */
  minStrokePx: 1.5,
} as const;

/** Every expression name the app already uses — CursorAvatar's states, the
 * legacy ten-face names (src/lib/mascot.ts LEGACY_STATES), MAUS_MOTIONS and
 * the live-turn gestures (shared/mascot-choreography.ts) — mapped to a glyph
 * face, so a scared or proud bot wears its own face. Anything not listed
 * rests on idle. Shipped in glyph-faces.json, which iOS and Android read. */
const EXPRESSION_STATES: Record<string, GlyphFaceState> = {
  // every glyph state maps to itself
  ...Object.fromEntries(GLYPH_FACE_STATES.map((state) => [state, state])),
  // tool poses (shared/mascot-choreography.ts toolGesture)
  browsing: "searching",
  // the sheet's own words
  rest: "idle", "needs-you": "waiting", done: "finished", "nailed": "nailed-it", "mind blown": "mind-blown",
  "handoff": "handing-off", kaching: "ka-ching", "waking-up": "waking",
  // CursorAvatar lifecycle
  sleeping: "asleep", spawning: "noticed", humming: "idle",
  // CursorAvatar reactions
  suspicious: "skeptical", angry: "determined", playful: "wink",
  // CursorAvatar agent morphs
  orbit: "searching", radar: "searching", progress: "working",
  // CursorAvatar product cycle
  loading: "working", dictating: "voice", receiving: "reading", uploading: "sending",
  notifying: "waiting", alerting: "waiting", dragging: "working", bouncing: "happy",
  "powering-down": "drowsy",
  // legacy ten-face names
  deadpan: "idle", friendly: "happy", sleepy: "drowsy", worried: "nervous", mischievous: "wink",
  // MAUS_MOTIONS
  none: "idle", arrive: "noticed", switch: "glance", customize: "happy", alert: "waiting",
  launch: "working", success: "finished", blink: "idle", surprise: "surprised", failure: "failed",
  // plain words the plan's table uses
  pending: "waiting", thanked: "happy", stopped: "sad", error: "failed", dead: "failed",
  // voice calls
  ringing: "calling", speaking: "voice",
};

/** Glyph states that already describe a live turn; a working bot keeps one of
 * these instead of being flattened to "working". */
const LIVE_STATES = new Set<GlyphFaceState>([
  "thinking", "searching", "reading", "writing", "working", "focused", "sending",
  "confused", "skeptical", "determined", "nervous", "voice", "calling", "handing-off", "waiting-mate",
]);

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
    version: 2,
    stroke: GLYPH_STROKE,
    tiltDeg: GLYPH_TILT_DEG,
    viewBox: 24,
    states: GLYPH_FACE_STATES,
    faces: GLYPH_FACES,
    paths: GLYPH_PATHS,
    layout: GLYPH_LAYOUT,
    // glyphStateFor's tables, so the phones read the mapping instead of copying it
    expressions: EXPRESSION_STATES,
    liveStates: [...LIVE_STATES],
    palette: MAUS_COLORS,
    fallbackColor: MAUS_COLORS.green,
  };
}

/** The exact bytes of glyph-faces.json. */
export function glyphFacesJson(): string {
  return JSON.stringify(glyphFacesDocument(), null, 2) + "\n";
}
