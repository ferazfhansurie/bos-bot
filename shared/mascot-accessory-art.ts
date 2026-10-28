/** How mascot accessories (shared/mascot-accessories.ts) are drawn: flat SVG
 * in the flat bodies' 100-unit box, placed from the body's own outline so a
 * new body needs no hand-tuned anchors. App-only (extensionless imports);
 * iOS can port the same numbers. */
import { flatMascotBody } from "./flat-mascot-bodies";
import { GLYPH_LAYOUT, GLYPH_TILT_DEG, glyphInk, resolveMausColor } from "./glyph-faces";
import { botMascotAccessories, type MascotAccessoryId, type MascotAccessorySlot } from "./mascot-accessories";

/* ---------------------------------------------------------------- geometry */

type Point = [number, number];

const outlines = new Map<string, Point[]>();

/** Dense points along a body outline (absolute M/C/Z only, as the flat
 * bodies are authored). Cached per body. */
function outlinePoints(path: string): Point[] {
  const cached = outlines.get(path);
  if (cached) return cached;
  const tokens = path.match(/[MCZ]|-?\d*\.?\d+/g) ?? [];
  const points: Point[] = [];
  let i = 0;
  let pen: Point = [0, 0];
  let cmd = "";
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "M" || t === "C" || t === "Z") { cmd = t; i += 1; if (t === "Z") continue; }
    const n = (k: number) => Number(tokens[i + k]);
    if (cmd === "M") { pen = [n(0), n(1)]; points.push(pen); i += 2; }
    else if (cmd === "C") {
      const [x0, y0] = pen;
      const [x1, y1, x2, y2, x3, y3] = [n(0), n(1), n(2), n(3), n(4), n(5)];
      for (let s = 1; s <= 24; s += 1) {
        const u = s / 24, v = 1 - u;
        points.push([
          v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3,
          v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3,
        ]);
      }
      pen = [x3, y3];
      i += 6;
    } else i += 1;
  }
  outlines.set(path, points);
  return points;
}

function edgeAt(points: Point[], x: number, top: boolean): number {
  for (const band of [2.5, 6, 12, 50]) {
    const ys = points.filter(p => Math.abs(p[0] - x) <= band).map(p => p[1]);
    if (ys.length) return top ? Math.min(...ys) : Math.max(...ys);
  }
  return top ? 10 : 90;
}

function spanAt(points: Point[], y: number): [number, number] {
  for (const band of [2, 5, 10, 50]) {
    const xs = points.filter(p => Math.abs(p[1] - y) <= band).map(p => p[0]);
    if (xs.length >= 2) return [Math.min(...xs), Math.max(...xs)];
  }
  return [10, 90];
}

export interface AccessoryAnchors {
  /** face centre the glyph eyes are laid out around */
  centre: Point;
  /** where a hat sits: top of the body above the face, and the width there */
  head: { x: number; y: number; width: number };
  /** the body's sides at eye level, for headphone cups */
  sides: [number, number];
  /** the body's bottom edge below the face, and its span a little above it */
  neck: { x: number; y: number; width: number; left: number; right: number };
}

/** Anchors for `bodyId` with its face drawn at `centre` (callers differ: the
 * sidebar mascot uses the body's full face offset, the live mascot half). */
export function accessoryAnchors(bodyId: unknown, centre?: Point): AccessoryAnchors {
  const body = flatMascotBody(bodyId);
  const c: Point = centre ?? [50 + body.faceX, 50 + body.faceY];
  const points = outlinePoints(body.path);
  // the head's top across the face's middle, so a hat sits between ears
  // rather than balanced on one (columns past a narrow top are skipped)
  const tops = [-10, -5, 5, 10].map(dx => edgeAt(points, c[0] + dx, true)).filter(y => y < c[1] - 10);
  const top = Math.max(edgeAt(points, c[0], true), ...tops);
  const [hl, hr] = spanAt(points, top + 12);
  const bottom = edgeAt(points, c[0], false);
  const [nl, nr] = spanAt(points, bottom - 14);
  return {
    centre: c,
    head: { x: c[0], y: top, width: Math.min(hr - hl, 70) },
    sides: spanAt(points, c[1]),
    neck: { x: c[0], y: bottom, width: nr - nl, left: nl, right: nr },
  };
}

/* ----------------------------------------------------------------- drawing */

const INK = "#1E1C22";
const PALETTE = {
  red: "#D94B52", gold: "#F2B824", silver: "#C9CED6",
  blue: "#377FE6", coral: "#E5634E",
  pink: "#D84F8B", teal: "#01A492", orange: "#E78531", cream: "#F6EBD9",
};

function hex(c: string): number[] {
  return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
}
function distance(x: string, y: string): number {
  const a = hex(x), b = hex(y);
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** The accessory's own colour, unless it would melt into the body: then the
 * fallback, then gold, blue or ink, whichever stands out first. */
function against(body: string, colour: string, fallback: string): string {
  return [colour, fallback, PALETTE.gold, PALETTE.blue, INK].find(c => distance(body, c) >= 90) ?? INK;
}

/** The shade a piece uses for its band, knot or brim. */
function deepen(colour: string): string {
  return "#" + hex(colour).map(v => Math.round(v * 0.8).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const r = (n: number) => Math.round(n * 100) / 100;

interface Ctx { a: AccessoryAnchors; body: string; ink: "#000000" | "#FFFFFF" }

/** Head pieces are authored 40 wide with the origin at their bottom centre. */
function hat(ctx: Ctx, inner: string, { sink = 4, rotate = -8, widthScale = 1, dx = 0 } = {}): string {
  const { x, y, width } = ctx.a.head;
  const s = Math.max(0.55, Math.min(1.25, (width * 0.78 * widthScale) / 40));
  return `<g transform="translate(${r(x + dx * width)} ${r(y + sink)}) rotate(${rotate}) scale(${r(s)})">${inner}</g>`;
}

/** Eye and mouth pieces ride the glyph face: centred on it and tilted with it. */
function face(ctx: Ctx, dy: number, inner: string): string {
  const [cx, cy] = ctx.a.centre;
  return `<g transform="rotate(${GLYPH_TILT_DEG} ${r(cx)} ${r(cy)}) translate(${r(cx)} ${r(cy + dy)})">${inner}</g>`;
}

const EYE_X = GLYPH_LAYOUT.eyeX * 80;
const EYE_Y = GLYPH_LAYOUT.eyeY * 80;

const DRAW: Record<MascotAccessoryId, (ctx: Ctx) => string> = {
  "top-hat": ctx => hat(ctx,
    `<rect x="-24" y="-5" width="48" height="7" rx="3" fill="${INK}"/>` +
    `<rect x="-15" y="-33" width="30" height="30" rx="3" fill="${INK}"/>` +
    `<rect x="-15" y="-12" width="30" height="6" fill="${against(ctx.body, PALETTE.red, PALETTE.gold)}"/>`, { rotate: -10, sink: 5 }),
  cap: ctx => {
    const c = against(ctx.body, PALETTE.blue, PALETTE.red), deep = deepen(c);
    return hat(ctx,
      `<path d="M 10 -2 C 22 -4 34 -2 37 1 C 38 3 36 4 33 4 L 10 4 Z" fill="${deep}"/>` +
      `<path d="M -21 3 C -22 -24 22 -24 21 3 Z" fill="${c}"/>` +
      `<circle cx="0" cy="-18" r="3" fill="${deep}"/>`, { rotate: -6, sink: 6 });
  },
  beanie: ctx => {
    const c = against(ctx.body, PALETTE.coral, PALETTE.teal), deep = deepen(c);
    return hat(ctx,
      `<circle cx="0" cy="-26" r="6" fill="${PALETTE.cream}"/>` +
      `<path d="M -21 0 C -22 -30 22 -30 21 0 Z" fill="${c}"/>` +
      `<rect x="-23" y="-7" width="46" height="11" rx="5" fill="${deep}"/>`, { rotate: -6, sink: 6 });
  },
  crown: ctx => {
    const c = against(ctx.body, PALETTE.gold, PALETTE.silver), jewel = against(ctx.body, PALETTE.red, PALETTE.blue);
    return hat(ctx,
      `<path d="M -20 3 L -21 -19 L -10 -8 L 0 -24 L 10 -8 L 21 -19 L 20 3 Z" fill="${c}" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>` +
      `<rect x="-20" y="-3" width="40" height="6" fill="${deepen(c)}"/>` +
      `<circle cx="0" cy="-10" r="3" fill="${jewel}"/>`, { rotate: -8, sink: 4, widthScale: 0.85 });
  },
  "party-hat": ctx => {
    const c = against(ctx.body, PALETTE.pink, PALETTE.blue);
    return hat(ctx,
      `<path d="M -15 2 L 0 -34 L 15 2 Z" fill="${c}" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>` +
      `<circle cx="-5" cy="-7" r="2.6" fill="${PALETTE.gold}"/><circle cx="5" cy="-16" r="2.3" fill="${PALETTE.gold}"/><circle cx="-1" cy="-24" r="1.9" fill="${PALETTE.gold}"/>` +
      `<circle cx="0" cy="-36" r="4.5" fill="${PALETTE.gold}"/>`, { rotate: 14, sink: 4, widthScale: 0.8 });
  },
  bow: ctx => {
    const c = against(ctx.body, PALETTE.red, PALETTE.pink), deep = deepen(c);
    return hat(ctx,
      `<path d="M 0 -6 C -5 -18 -21 -20 -21 -8 C -21 4 -6 2 0 -6 Z" fill="${c}"/>` +
      `<path d="M 0 -6 C 5 -18 21 -20 21 -8 C 21 4 6 2 0 -6 Z" fill="${c}"/>` +
      `<circle cx="0" cy="-6" r="4.5" fill="${deep}"/>`, { rotate: 18, sink: 7, widthScale: 0.7, dx: 0.22 });
  },
  headphones: ctx => {
    const { head, sides, centre } = ctx.a;
    const cup = against(ctx.body, PALETTE.orange, PALETTE.blue);
    const left = sides[0] + 2, right = sides[1] - 2, y = centre[1] - 2, top = head.y - 5;
    return `<g>` +
      `<path d="M ${r(left)} ${r(y)} C ${r(left)} ${r(top - 10)} ${r(right)} ${r(top - 10)} ${r(right)} ${r(y)}" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` +
      `<rect x="${r(left - 6)}" y="${r(y - 11)}" width="12" height="22" rx="6" fill="${cup}"/>` +
      `<rect x="${r(right - 6)}" y="${r(y - 11)}" width="12" height="22" rx="6" fill="${cup}"/>` +
      `</g>`;
  },
  "round-glasses": ctx => face(ctx, EYE_Y,
    `<g fill="none" stroke="${ctx.ink === "#FFFFFF" ? "#F4F1EC" : INK}" stroke-width="3" stroke-linecap="round">` +
    `<circle cx="${-EYE_X}" cy="0" r="12.5" fill="#F4F1EC" fill-opacity="0.16"/>` +
    `<circle cx="${EYE_X}" cy="0" r="12.5" fill="#F4F1EC" fill-opacity="0.16"/>` +
    `<path d="M ${r(-EYE_X + 12.5)} -1 C -2 -5 2 -5 ${r(EYE_X - 12.5)} -1"/>` +
    `<path d="M ${r(-EYE_X - 12.5)} -2 L ${r(-EYE_X - 19)} -5"/><path d="M ${r(EYE_X + 12.5)} -2 L ${r(EYE_X + 19)} -5"/></g>`),
  sunglasses: ctx => face(ctx, EYE_Y,
    `<g fill="${INK}"${ctx.ink === "#FFFFFF" ? ` stroke="#F4F1EC" stroke-width="1.5"` : ""}>` +
    `<path d="M ${r(-EYE_X - 13)} -9 L ${r(-EYE_X + 13)} -9 C ${r(-EYE_X + 13)} 5 ${r(-EYE_X + 8)} 11 ${-EYE_X} 11 C ${r(-EYE_X - 8)} 11 ${r(-EYE_X - 13)} 5 ${r(-EYE_X - 13)} -9 Z"/>` +
    `<path d="M ${r(EYE_X - 13)} -9 L ${r(EYE_X + 13)} -9 C ${r(EYE_X + 13)} 5 ${r(EYE_X + 8)} 11 ${EYE_X} 11 C ${r(EYE_X - 8)} 11 ${r(EYE_X - 13)} 5 ${r(EYE_X - 13)} -9 Z"/>` +
    `<rect x="${r(-EYE_X + 11)}" y="-9" width="${r(2 * EYE_X - 22)}" height="4"/></g>` +
    `<path d="M ${r(-EYE_X - 8)} -5 L ${r(-EYE_X - 3)} -5 M ${r(EYE_X - 8)} -5 L ${r(EYE_X - 3)} -5" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="2" stroke-linecap="round"/>`),
  mustache: ctx => face(ctx, 17,
    `<path transform="scale(0.85)" d="M 0 -2 C -4 -7 -12 -8 -17 -3 C -20 0 -24 -1 -25 -5 C -26 3 -19 8 -11 5 C -6 3 -3 1 0 1 C 3 1 6 3 11 5 C 19 8 26 3 25 -5 C 24 -1 20 0 17 -3 C 12 -8 4 -7 0 -2 Z" fill="${ctx.ink === "#FFFFFF" ? "#EFE7DD" : "#3A2618"}"/>`),
  "bow-tie": ctx => {
    const { x, y } = ctx.a.neck;
    const c = against(ctx.body, PALETTE.red, PALETTE.gold), deep = deepen(c);
    return `<g transform="translate(${r(x)} ${r(y - 2)}) rotate(-4) scale(0.85)">` +
      `<path d="M 0 0 L -15 -9 C -18 -10 -20 -8 -20 -5 L -20 5 C -20 8 -18 10 -15 9 Z" fill="${c}"/>` +
      `<path d="M 0 0 L 15 -9 C 18 -10 20 -8 20 -5 L 20 5 C 20 8 18 10 15 9 Z" fill="${c}"/>` +
      `<rect x="-5" y="-5" width="10" height="10" rx="3" fill="${deep}"/></g>`;
  },
  scarf: ctx => {
    const { y, width, left, right } = ctx.a.neck;
    const c = against(ctx.body, PALETTE.teal, PALETTE.red), deep = deepen(c);
    // centred on the body, not the face: a scarf wraps the whole width
    const x = (left + right) / 2, w = width + 6, band = y - 15;
    return `<g>` +
      `<rect x="${r(x - w / 2)}" y="${r(band)}" width="${r(w)}" height="10" rx="5" fill="${c}"/>` +
      `<rect x="${r(x + w * 0.12)}" y="${r(band + 4)}" width="9" height="22" rx="3" fill="${deep}" transform="rotate(-8 ${r(x + w * 0.12)} ${r(band + 4)})"/>` +
      `<path d="M ${r(x + w * 0.12 + 1)} ${r(band + 14)} l 7.5 0 M ${r(x + w * 0.12 + 1.6)} ${r(band + 19)} l 7.5 0" stroke="${c}" stroke-width="2" transform="rotate(-8 ${r(x + w * 0.12)} ${r(band + 4)})"/>` +
      `</g>`;
  },
};

/** Paint order: what sits behind the face first, what covers it last. */
const ORDER: MascotAccessorySlot[] = ["neck", "mouth", "eyes", "head"];

/** SVG markup for everything `accessories` puts on this body, in the body's
 * 100-unit box; "" when it wears nothing. Ids are catalog-checked, so the
 * string carries only our own numbers and colours. */
export function mascotAccessoryMarkup({ accessories, bodyId, color, centre }: {
  accessories: unknown;
  bodyId: unknown;
  color: string | null | undefined;
  centre?: Point;
}): string {
  const worn = botMascotAccessories(accessories);
  if (!worn) return "";
  const body = resolveMausColor(color);
  const ctx: Ctx = { a: accessoryAnchors(bodyId, centre), body, ink: glyphInk(body) };
  return ORDER.map(slot => {
    const id = worn[slot];
    return id ? `<g data-accessory="${id}">${DRAW[id](ctx)}</g>` : "";
  }).join("");
}
