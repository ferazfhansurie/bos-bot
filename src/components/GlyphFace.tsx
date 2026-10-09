// The glyph face's SVG: two tilted eyes and the floating accent, from
// glyphFaceParts. Drawn inside a mascot's own <svg> by MausAvatar (resting
// faces) and CursorAvatar (live turns), so both share one look.
import type { Ref } from "react";
import type { GlyphFaceParts, GlyphMark } from "@/lib/glyph-face";

function Mark({ mark, color }: { mark: GlyphMark; color: string }) {
  return (
    <g transform={mark.transform}>
      <path d={mark.d} fill="none" style={{ stroke: color }} strokeWidth={mark.width}
        strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** The eye pair. `blinkRef` lets a frame loop squash the eyes (a blink);
 * `animated` plays the 120ms squash when the face changes. */
export function GlyphEyes({ parts, animated, blinkRef, blinkClass }: {
  parts: GlyphFaceParts;
  animated: boolean;
  blinkRef?: Ref<SVGGElement>;
  /** a one-shot CSS blink, for callers without a frame loop */
  blinkClass?: string;
}) {
  const [cx, cy] = parts.centre;
  const origin = `${cx}px ${cy}px`;
  return (
    <g transform={parts.tilt} data-glyph-face={parts.state}>
      <g ref={blinkRef} className={blinkClass} style={{ transformOrigin: origin }}>
        {/* keyed by the eye shapes, so a face change remounts and squashes in */}
        <g key={`${parts.eyes[0].id}-${parts.eyes[1].id}`} className={animated ? "bos-glyph-swap" : undefined}
          style={{ transformOrigin: origin }}>
          <Mark mark={parts.eyes[0]} color={parts.ink} />
          <Mark mark={parts.eyes[1]} color={parts.ink} />
        </g>
      </g>
    </g>
  );
}

/** The accent glyph off the body; pops in when it appears. */
export function GlyphAccent({ parts, animated }: { parts: GlyphFaceParts; animated: boolean }) {
  if (!parts.accent) return null;
  const [cx, cy] = parts.centre;
  return (
    <g key={`${parts.state}-${parts.accent.id}`} data-glyph-accent={parts.accent.id}
      className={animated ? "bos-glyph-accent" : undefined} style={{ transformOrigin: `${cx}px ${cy}px` }}>
      <Mark mark={parts.accent} color={parts.accentColor} />
    </g>
  );
}
