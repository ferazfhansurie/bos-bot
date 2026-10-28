// Desktop geometry for glyph mascot faces (shared/glyph-faces.ts): where the
// two eyes and the accent go on a body, in that body's own SVG units. React
// (MausAvatar, CursorAvatar) and the notification rasteriser both draw from
// these parts, so every desktop surface places the same face the same way.
import {
  GLYPH_FACES,
  GLYPH_LAYOUT,
  GLYPH_PATHS,
  GLYPH_STROKE,
  GLYPH_TILT_DEG,
  glyphInk,
  resolveMausColor,
  type GlyphEyePart,
  type GlyphFaceState,
  type GlyphId,
  type GlyphMotion,
} from "../../shared/glyph-faces";

export interface GlyphMark {
  id: GlyphId;
  d: string;
  /** places the 24-unit path box: translate to its corner, then scale */
  transform: string;
  /** stroke width in the 24-unit box */
  width: number;
}

export interface GlyphFaceParts {
  state: GlyphFaceState;
  /** the body fill, "#RRGGBB" */
  body: string;
  /** eye colour: black on light bodies, white on dark */
  ink: "#000000" | "#FFFFFF";
  /** rotate() for the eye pair, about the face centre */
  tilt: string;
  /** the face centre the tilt and a blink squash pivot on */
  centre: [number, number];
  /** each eye's main mark (its first part) */
  eyes: [GlyphMark, GlyphMark];
  /** every part of each eye, main mark first (a dot plus a brow, a lid) */
  eyeParts: [GlyphMark[], GlyphMark[]];
  /** each eye's centre, for motions that turn an eye about itself */
  eyeCentres: [[number, number], [number, number]];
  /** where the eyes look, in the caller's units, applied inside the tilt */
  gaze: [number, number];
  accent: GlyphMark | null;
  /** accent stroke colour; a CSS value, so read it as a style, not an attribute */
  accentColor: string;
  /** the sheet's motion for this face (shared names; desktop plays them) */
  motion: GlyphMotion;
  /** one sheet px (a 64px body) in the caller's units, for motion distances */
  unit: number;
}

/** The theme's text colour; what an accent falls back to when the body
 * colour would vanish against the page. */
export const ACCENT_FALLBACK = "var(--color-ink, #FCFCFC)";

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The accent floats on the page, not the body, so a near-black or
 * near-white body would lose it on one of the skins. Those take the theme's
 * ink instead (white on the dark skins, dark on the light ones). */
export function glyphAccentColor(body: string, fallback = ACCENT_FALLBACK): string {
  const l = luminance(body);
  const againstBlack = (l + 0.05) / 0.05;
  const againstWhite = 1.05 / (l + 0.05);
  return againstBlack < 1.6 || againstWhite < 1.6 ? fallback : body;
}

/**
 * The face for a body of diameter `diameter` centred on `centre`, both in the
 * caller's SVG units. `pixels` is how wide that diameter is on screen; it
 * hides the accent on small faces and keeps strokes bold at 16px.
 */
export function glyphFaceParts({
  state,
  color,
  centre,
  diameter,
  pixels,
  accentFallback,
}: {
  state: GlyphFaceState;
  color: string | null | undefined;
  centre: [number, number];
  diameter: number;
  pixels: number;
  accentFallback?: string;
}): GlyphFaceParts {
  const body = resolveMausColor(color);
  const face = GLYPH_FACES[state] ?? GLYPH_FACES.idle;
  const [cx, cy] = centre;
  const D = diameter;
  const unitPx = pixels / D;
  const mark = (id: GlyphId, x: number, y: number, box: number, stroke: number): GlyphMark => {
    const scale = box / 24;
    return {
      id,
      d: GLYPH_PATHS[id],
      transform: `translate(${round(x - box / 2)} ${round(y - box / 2)}) scale(${round(scale)})`,
      width: round(Math.max(stroke, GLYPH_LAYOUT.minStrokePx / (scale * unitPx))),
    };
  };
  const L = GLYPH_LAYOUT;
  const eyeBox = L.eyeBox * D;
  const eyeCentres: [[number, number], [number, number]] = [
    [round(cx - L.eyeX * D), round(cy + L.eyeY * D)],
    [round(cx + L.eyeX * D), round(cy + L.eyeY * D)],
  ];
  const eye = (parts: GlyphEyePart[], [x, y]: [number, number]) =>
    parts.map((part) => mark(part.glyph, x, y, eyeBox, GLYPH_STROKE * part.weight));
  const eyeParts: [GlyphMark[], GlyphMark[]] = [eye(face.leftParts, eyeCentres[0]), eye(face.rightParts, eyeCentres[1])];
  let accent: GlyphMark | null = null;
  let accentColor = glyphAccentColor(body, accentFallback);
  if (face.accent && face.anchor && pixels >= L.accentMinSize) {
    const a: { x: number; y: number; box: number; stroke: number; onBodyAlpha?: number } = L.accent[face.anchor];
    accent = mark(face.accent, cx + a.x * D, cy + a.y * D, a.box * D, a.stroke);
    // a cheek accent sits on the body, so it takes the colour opposite the eyes
    if (a.onBodyAlpha !== undefined) accentColor = glyphInk(body) === "#000000" ? `rgba(255,255,255,${a.onBodyAlpha})` : `rgba(0,0,0,${a.onBodyAlpha})`;
  }
  return {
    state,
    body,
    ink: glyphInk(body),
    tilt: `rotate(${GLYPH_TILT_DEG} ${round(cx)} ${round(cy)})`,
    centre: [cx, cy],
    eyes: [eyeParts[0][0], eyeParts[1][0]],
    eyeParts,
    eyeCentres,
    gaze: [round(face.gaze[0] * D), round(face.gaze[1] * D)],
    accent,
    accentColor,
    motion: face.motion,
    unit: round(D / 64),
  };
}

/** Standalone markup for the eyes and accent, for places that draw SVG as a
 * string (the notification icon). `accentColor` must be a plain colour there:
 * a rasterised SVG has no theme to read. */
export function glyphFaceMarkup(parts: GlyphFaceParts): string {
  const path = (m: GlyphMark, color: string) =>
    `<g transform="${m.transform}"><path d="${m.d}" fill="none" stroke="${color}" stroke-width="${m.width}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  const eyes = [...parts.eyeParts[0], ...parts.eyeParts[1]].map((m) => path(m, parts.ink)).join("");
  return (
    `<g transform="${parts.tilt}"><g transform="translate(${parts.gaze[0]} ${parts.gaze[1]})">${eyes}</g></g>` +
    (parts.accent ? path(parts.accent, parts.accentColor) : "")
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;
