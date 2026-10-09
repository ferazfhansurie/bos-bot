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
  type GlyphFaceState,
  type GlyphId,
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
  eyes: [GlyphMark, GlyphMark];
  accent: GlyphMark | null;
  /** accent stroke colour; a CSS value, so read it as a style, not an attribute */
  accentColor: string;
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
  const eyes: [GlyphMark, GlyphMark] = [
    mark(face.left, cx - L.eyeX * D, cy + L.eyeY * D, eyeBox, GLYPH_STROKE),
    mark(face.right, cx + L.eyeX * D, cy + L.eyeY * D, eyeBox, GLYPH_STROKE),
  ];
  let accent: GlyphMark | null = null;
  if (face.accent && face.anchor && pixels >= L.accentMinSize) {
    const a = L.accent[face.anchor];
    accent = mark(face.accent, cx + a.x * D, cy + a.y * D, a.box * D, a.stroke);
  }
  return {
    state,
    body,
    ink: glyphInk(body),
    tilt: `rotate(${GLYPH_TILT_DEG} ${round(cx)} ${round(cy)})`,
    centre: [cx, cy],
    eyes,
    accent,
    accentColor: glyphAccentColor(body, accentFallback),
  };
}

/** Standalone markup for the eyes and accent, for places that draw SVG as a
 * string (the notification icon). `accentColor` must be a plain colour there:
 * a rasterised SVG has no theme to read. */
export function glyphFaceMarkup(parts: GlyphFaceParts): string {
  const path = (m: GlyphMark, color: string) =>
    `<g transform="${m.transform}"><path d="${m.d}" fill="none" stroke="${color}" stroke-width="${m.width}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  return (
    `<g transform="${parts.tilt}">${path(parts.eyes[0], parts.ink)}${path(parts.eyes[1], parts.ink)}</g>` +
    (parts.accent ? path(parts.accent, parts.accentColor) : "")
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;
