// A bot at the notch: its flat body in its own colour and the glyph eyes
// every other bos surface draws. Nothing here runs on a loop: a blink is a
// shared timer flipping one class, and a face change is the eyes' own squash.
import { memo, useEffect, useState } from "react";
import { GlyphAccent, GlyphEyes } from "@/components/GlyphFace";
import { glyphFaceParts } from "@/lib/glyph-face";
import type { ActivityState } from "@/lib/activity-feed";
import { flatMascotBody } from "../../shared/flat-mascot-bodies";
import { resolveMausColor, type GlyphFaceState } from "../../shared/glyph-faces";
import type { MascotBodyId } from "../../shared/mascot-bodies";

/** A body too dark to see on the black notch gets a faint rim. */
function rimFor(hex: string): string | undefined {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return undefined;
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance < 0.06 ? "rgba(255,255,255,0.32)" : undefined;
}

/** One working face: a live turn flips between thinking and tools several
 * times a second, and the notch is no place to show that churn. */
export function faceFor(state: ActivityState): GlyphFaceState {
  switch (state) {
    case "waiting": return "waiting";
    case "tool":
    case "typing":
    case "thinking": return "working";
    case "failed": return "failed";
    default: return "idle";
  }
}

// One blink at a time across the whole notch, every several seconds: a
// blink is about a dozen frames, so a heartbeat per head would keep the
// folded notch drawing most of the time.
const blinkers = new Set<(shut: boolean) => void>();
let blinkTimer = 0;
function scheduleBlink() {
  window.clearTimeout(blinkTimer);
  if (!blinkers.size) return;
  blinkTimer = window.setTimeout(() => {
    const all = [...blinkers];
    const pick = all[Math.floor(Math.random() * all.length)];
    pick(true);
    window.setTimeout(() => {
      pick(false);
      scheduleBlink();
    }, 200);
  }, 6000 + Math.random() * 6000);
}

function useBlink(enabled: boolean): boolean {
  const [shut, setShut] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    blinkers.add(setShut);
    if (blinkers.size === 1) scheduleBlink();
    return () => {
      blinkers.delete(setShut);
      setShut(false);
      if (!blinkers.size) window.clearTimeout(blinkTimer);
    };
  }, [enabled]);
  return enabled && shut;
}

export const NotchMascot = memo(function NotchMascot({ color, body, face, size, pixels = size, look = 0, blink = true, animated = true }: {
  color: string;
  body: MascotBodyId | null;
  face: GlyphFaceState;
  /** drawn size, px */
  size: number;
  /** the size the face is laid out for: under 24 the accent stays off */
  pixels?: number;
  /** -1 (left) to 1 (right): where the eyes turn */
  look?: number;
  blink?: boolean;
  animated?: boolean;
}) {
  const shape = flatMascotBody(body ?? "circle");
  const fill = resolveMausColor(color);
  const parts = glyphFaceParts({
    state: face,
    color: fill,
    centre: [50 + shape.faceX, 50 + shape.faceY],
    diameter: 80,
    pixels,
    accentFallback: "#FFFFFF",
  });
  const shut = useBlink(blink && animated && face !== "failed" && face !== "finished");
  const lookX = Math.max(-1, Math.min(1, look)) * 7;
  return (
    <svg className="notch-mascot" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path d={shape.path} fill={fill} stroke={rimFor(fill)} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
      <g className="notch-look" style={{ transform: `translateX(${lookX}px)` }}>
        <GlyphEyes parts={parts} animated={animated} blinkClass={shut ? "bos-avatar-blink" : undefined} />
      </g>
      <GlyphAccent parts={parts} animated={animated} />
    </svg>
  );
});
