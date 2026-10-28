// The glyph face's SVG: two tilted eyes and the floating accent, from
// glyphFaceParts. Drawn inside a mascot's own <svg> by MausAvatar (resting
// faces) and CursorAvatar (live turns), so both share one look. Each face's
// sheet motion (glyph-motion.css) plays when `animated`; reduced motion holds still.
import type { CSSProperties, Ref } from "react";
import type { GlyphFaceParts, GlyphMark } from "@/lib/glyph-face";
import "./glyph-motion.css";

function Mark({ mark, color }: { mark: GlyphMark; color: string }) {
  return (
    <g transform={mark.transform}>
      <path d={mark.d} fill="none" style={{ stroke: color }} strokeWidth={mark.width}
        strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** `--g` carries one sheet px into the motion keyframes. */
const unitStyle = (parts: GlyphFaceParts) => ({ "--g": `${parts.unit}px` }) as CSSProperties;

/** Class and style for the caller's body group, so the body hops, squishes or
 * taps with the face. Empty when the face has no body motion or isn't animated. */
export function glyphBodyMotion(parts: GlyphFaceParts | null | undefined, animated: boolean): { className?: string; style?: CSSProperties } {
  if (!parts?.motion.body || !animated) return {};
  return { className: `bos-gm bos-gm-b-${parts.motion.body}`, style: unitStyle(parts) };
}

/** True when the face's own eye motion already closes the eyes, so the
 * random blink should leave them be. */
export const glyphSkipsBlink = (parts: GlyphFaceParts | null | undefined) => parts?.motion.eyes === "slow";

/** The eye pair. `blinkRef` lets a frame loop squash the eyes (a blink);
 * `animated` plays the 120ms squash when the face changes and the face's motion. */
export function GlyphEyes({ parts, animated, blinkRef, blinkClass }: {
  parts: GlyphFaceParts;
  animated: boolean;
  blinkRef?: Ref<SVGGElement>;
  /** a one-shot CSS blink, for callers without a frame loop */
  blinkClass?: string;
}) {
  const [cx, cy] = parts.centre;
  const origin = `${cx}px ${cy}px`;
  const eyeMotion = animated && parts.motion.eyes ? `bos-gm bos-gm-e-${parts.motion.eyes}` : undefined;
  const shapes = parts.eyeParts.map((eye) => eye.map((m) => m.id).join("+")).join("-");
  return (
    // the sheet moves the eyes in screen space, then tilts them; gaze sits inside the tilt
    <g className={eyeMotion} style={{ ...unitStyle(parts), transformOrigin: `${cx}px ${parts.eyeCentres[0][1]}px` }}
      data-glyph-face={parts.state} data-glyph-motion={parts.motion.eyes}>
      <g transform={parts.tilt}>
        <g ref={blinkRef} className={blinkClass} style={{ transformOrigin: origin }}>
          {/* keyed by the eye shapes, so a face change remounts and squashes in */}
          <g key={shapes} className={animated ? "bos-glyph-swap" : undefined} style={{ transformOrigin: origin }}>
            <g transform={parts.gaze[0] || parts.gaze[1] ? `translate(${parts.gaze[0]} ${parts.gaze[1]})` : undefined}>
              {parts.eyeParts.map((eye, i) => (
                <g key={i} className="bos-gm-eye">
                  {eye.map((m, k) => <Mark key={k} mark={m} color={parts.ink} />)}
                </g>
              ))}
            </g>
          </g>
        </g>
      </g>
    </g>
  );
}

/** The accent glyph off the body; pops in when it appears, then plays its motion. */
export function GlyphAccent({ parts, animated }: { parts: GlyphFaceParts; animated: boolean }) {
  if (!parts.accent) return null;
  const [cx, cy] = parts.centre;
  const motion = animated && parts.motion.accent ? `bos-gm bos-gm-a-${parts.motion.accent}` : undefined;
  return (
    <g key={`${parts.state}-${parts.accent.id}`} data-glyph-accent={parts.accent.id}
      className={animated ? "bos-glyph-accent" : undefined} style={{ transformOrigin: `${cx}px ${cy}px` }}>
      <g className={motion} style={unitStyle(parts)} data-glyph-accent-motion={parts.motion.accent}>
        <Mark mark={parts.accent} color={parts.accentColor} />
      </g>
    </g>
  );
}
