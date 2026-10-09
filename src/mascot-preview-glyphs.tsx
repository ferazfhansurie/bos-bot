// Review only: the glyph faces (shared/glyph-faces.ts) as the app draws them,
// all eight states on a light and a dark page, a free colour, the 16px sidebar
// size, and a live turn walking idle -> thinking -> working -> finished.
import { useEffect, useState, type CSSProperties } from "react";
import { MausAvatar } from "./components/Avatar";
import { ActivityMascot } from "./components/ActivityMascot";
import type { MausColor } from "./lib/mascot";
import { GLYPH_FACES, GLYPH_FACE_STATES, type GlyphFaceState } from "../shared/glyph-faces";
import type { MascotGesture } from "../shared/mascot-choreography";

const PAGES = {
  light: { background: "#f5f1eb", color: "#1a1a1a", "--color-ink": "#1a1a1a" },
  dark: { background: "#070707", color: "#fcfcfc", "--color-ink": "#fcfcfc" },
} as const;
const WALK: MascotGesture[] = ["idle", "thinking", "working", "finished"];
const glyphText = (state: GlyphFaceState) => {
  const f = GLYPH_FACES[state];
  return `${f.left} ${f.right}${f.accent ? ` · ${f.accent}` : ""}`;
};

function Row({ label, color, page, size }: { label: string; color: MausColor; page: keyof typeof PAGES; size: number }) {
  return (
    <div className="glyph-row" style={PAGES[page] as CSSProperties} data-glyph-row={`${label}-${page}-${size}`}>
      <span className="glyph-label">{label}<br />{page} · {size}px</span>
      {GLYPH_FACE_STATES.map(state => (
        <span key={state} className="glyph-cell" style={{ width: Math.max(size * 1.75, 24) }}>
          <MausAvatar color={color} face={state} size={size} trackPointer={false} label={`${label} ${state}`} />
        </span>
      ))}
    </div>
  );
}

export function GlyphPreview() {
  const [custom, setCustom] = useState<MausColor>("#7C3AED");
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep(s => (s + 1) % WALK.length), 2400);
    return () => clearInterval(timer);
  }, []);
  const gesture = WALK[step]!;
  return (
    <section className="glyph-preview" aria-label="glyph faces">
      <p className="eyebrow">bos / glyph faces</p>
      <h1>eyes and expressions.</h1>
      <div className="field-row">
        <label>custom colour <input aria-label="custom mascot color" type="color" value={custom.toLowerCase()}
          onChange={e => setCustom(e.target.value.toUpperCase() as MausColor)} /></label>
        <span className="note">{custom}</span>
      </div>
      <div className="glyph-row glyph-head">
        <span className="glyph-label" />
        {GLYPH_FACE_STATES.map(state => <span key={state} className="glyph-cell" style={{ width: 96 * 1.75 }}>{state}<br /><small>{glyphText(state)}</small></span>)}
      </div>
      <Row label="green" color="green" page="light" size={96} />
      <Row label="white" color="white" page="dark" size={96} />
      <Row label="custom" color={custom} page="dark" size={96} />
      <Row label="custom" color={custom} page="light" size={96} />
      <p className="note">sidebar size: accent hidden under 24px of body</p>
      <Row label="green" color="green" page="dark" size={16} />
      <Row label="white" color="white" page="light" size={16} />
      <Row label="custom" color={custom} page="dark" size={16} />
      <p className="note">live turn: {WALK.join(" → ")} (now {gesture})</p>
      <div className="glyph-row" style={PAGES.dark as CSSProperties} data-glyph-walk={gesture}>
        {[36, 72].map(size => (
          <span key={size} className="glyph-cell" style={{ width: size * 2.2, height: size * 1.8 }}>
            <ActivityMascot bot={{ name: "walk", color: custom, mascotBody: "circle" }} gesture={gesture} size={size} />
          </span>
        ))}
      </div>
    </section>
  );
}
