// The frame: aspect-correct on black, media layers owned by the playback
// engine, text drawn as HTML at the renderer's sizes. Text can be dragged
// to a new spot; nothing here re-renders per frame.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Film, Upload } from "lucide-react";
import { findClip, TEXT_STYLE_DEFAULTS, type VideoClip, type VideoTimeline } from "../../../shared/video";
import { cn } from "@/lib/cn";
import type { PlaybackEngine } from "./video-playback";
import { useElementSize } from "./ui";

export function Preview({ engine, timeline, selected, onSelect, onTextMove, empty, onDropFiles, onPickFiles, compact }: {
  engine: PlaybackEngine;
  timeline: VideoTimeline;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onTextMove: (clipId: string, x: number, y: number) => void;
  empty: boolean;
  onDropFiles: (files: File[]) => void;
  onPickFiles: () => void;
  compact?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(boxRef);
  const [textIds, setTextIds] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);

  const pad = compact ? 8 : 16;
  const scale = Math.max(0, Math.min((box.width - pad * 2) / timeline.width, (box.height - pad * 2) / timeline.height));
  const frameW = Math.floor(timeline.width * scale), frameH = Math.floor(timeline.height * scale);

  useEffect(() => { engine.attach(stageRef.current, audioRef.current); }, [engine]);
  useEffect(() => engine.onText(setTextIds), [engine]);

  const texts = useMemo(() => textIds.map(id => findClip(timeline, id)).filter(Boolean).map(f => ({ clip: f!.clip, layer: timeline.tracks.indexOf(f!.track) })), [textIds, timeline]);

  const filesOf = (e: React.DragEvent) => [...e.dataTransfer.files].filter(f => /^(video|audio|image)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|gif|webp|heic)$/i.test(f.name));

  return (
    <div ref={boxRef} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black"
      onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={e => { setDropping(false); const files = filesOf(e); if (files.length) { e.preventDefault(); onDropFiles(files); } }}
      onPointerDown={e => { if (e.target === e.currentTarget) onSelect([]); }}>
      <div className="relative overflow-hidden" style={{ width: frameW, height: frameH, background: timeline.background, visibility: frameW > 0 ? "visible" : "hidden" }}
        onPointerDown={e => { if (e.target === e.currentTarget || e.target === stageRef.current) onSelect([]); }}>
        <div ref={stageRef} className="absolute inset-0 isolate" />
        <div className="absolute inset-0 z-[1000]" style={{ pointerEvents: "none" }}>
          {texts.map(({ clip, layer }) => (
            <TextOverlay key={clip.id} clip={clip} layer={layer} frameW={frameW} frameH={frameH} scale={scale} engine={engine}
              selected={selected.includes(clip.id)} onSelect={() => onSelect([clip.id])} onMove={(x, y) => onTextMove(clip.id, x, y)} />
          ))}
        </div>
        {empty && (
          <div className="absolute inset-0 z-[1001] flex flex-col items-center justify-center gap-3 p-4 text-center text-white/70">
            <Film size={compact ? 22 : 28} strokeWidth={1.5} className="text-white/40" />
            <p className={cn("max-w-[260px] leading-snug", compact ? "text-[12px]" : "text-[13px]")}>Drop clips here, or ask bos to make one</p>
            <button type="button" onClick={onPickFiles} onMouseDown={e => e.preventDefault()}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-[12px] text-white/85 transition-colors hover:bg-white/[.16]">
              <Upload size={13} strokeWidth={1.75} />Add media
            </button>
          </div>
        )}
      </div>
      <div ref={audioRef} hidden />
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-[1002] flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 text-[13px] text-white">
          Drop to add to the video
        </div>
      )}
    </div>
  );
}

function TextOverlay({ clip, layer, frameW, frameH, scale, engine, selected, onSelect, onMove }: {
  clip: VideoClip; layer: number; frameW: number; frameH: number; scale: number; engine: PlaybackEngine;
  selected: boolean; onSelect: () => void; onMove: (x: number, y: number) => void;
}) {
  const s = { ...TEXT_STYLE_DEFAULTS, ...clip.style };
  const px = Math.max(8, Math.round(s.size * frameH / scale)) * scale;
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x0: number; y0: number; sx: number; sy: number; moved: boolean } | null>(null);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect();
    drag.current = { x0: e.clientX, y0: e.clientY, sx: s.x, sy: s.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !ref.current) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    const x = clamp01(d.sx + dx / frameW), y = clamp01(d.sy + dy / frameH);
    ref.current.style.left = `${x * 100}%`;
    ref.current.style.top = `${y * 100}%`;
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    const snapCentre = (v: number) => (Math.abs(v - 0.5) < 0.015 ? 0.5 : v);
    onMove(round3(snapCentre(clamp01(d.sx + (e.clientX - d.x0) / frameW))), round3(clamp01(d.sy + (e.clientY - d.y0) / frameH)));
  };

  return (
    <div ref={el => { ref.current = el; engine.registerText(clip.id, el); }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; }}
      className={cn("absolute w-max cursor-move select-none whitespace-pre-wrap break-words", selected && "outline outline-1 outline-offset-2 outline-accent")}
      style={{
        pointerEvents: "auto", left: `${s.x * 100}%`, top: `${s.y * 100}%`, transform: "translate(-50%, -50%)", zIndex: layer,
        maxWidth: frameW * 0.9, fontFamily: "Arial, Helvetica, sans-serif", fontSize: px, lineHeight: 1.2,
        fontWeight: s.weight === 400 ? 400 : s.weight === 600 ? 700 : 900, color: s.color, textAlign: s.align,
        background: s.background || undefined, padding: s.background ? `${px * 0.25}px ${px * 0.45}px` : undefined,
      }}>
      {clip.text}
    </div>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;
