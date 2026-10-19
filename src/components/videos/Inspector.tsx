// Properties of the selected clip, or of the whole video when nothing is
// selected. Sliders fold into one undo step per drag.
import { useEffect, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, AudioLines, Film, Image as ImageIcon, Type, X } from "lucide-react";
import {
  clipSpeed, fmtTime, TEXT_STYLE_DEFAULTS, VIDEO_SIZES, findClip,
  type VideoClip, type VideoEditOp, type VideoMedia, type VideoSizePreset, type VideoTextStyle, type VideoTimeline,
} from "../../../shared/video";
import { cn } from "@/lib/cn";
import { neighbours } from "./timeline-math";
import { AspectGlyph, Field, IconButton, SecondsInput, Segmented, Slider, Swatches, aspectName } from "./ui";

const TEXT_COLORS = ["#ffffff", "#000000", "#ffd60a", "#ff5667", "#1084fe", "#38d591"];
const BOX_COLORS = ["#000000", "#00000099", "#ffffff", "#ffd60a", "#1084fe"];
const BACKGROUNDS = ["#000000", "#ffffff", "#111827", "#1084fe", "#38d591", "#ff5667"];
const PRESET_NAMES: Record<VideoSizePreset, string> = { landscape: "Landscape", portrait: "Portrait", square: "Square", feed: "Feed" };
const POSITIONS = [{ value: "top", label: "Top", y: 0.12 }, { value: "middle", label: "Middle", y: 0.5 }, { value: "bottom", label: "Bottom", y: 0.85 }] as const;

type Apply = (ops: VideoEditOp[], options?: { coalesce?: string; quiet?: boolean }) => string[] | null;

export function Inspector({ timeline, media, selected, apply, onClose }: {
  timeline: VideoTimeline; media: VideoMedia[]; selected: string[]; apply: Apply; onClose?: () => void;
}) {
  const found = selected.length === 1 ? findClip(timeline, selected[0]!) : null;
  const title = found ? (found.track.kind === "text" ? "Text" : found.track.kind === "audio" ? "Audio" : "Clip") : selected.length > 1 ? `${selected.length} clips` : "Video";
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span className="flex-1 text-[12.5px] font-medium text-ink/85">{title}</span>
        {onClose && <IconButton icon={X} label="Close inspector" onClick={onClose} />}
      </div>
      <div className="video-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {found ? <ClipInspector key={found.clip.id} clip={found.clip} timeline={timeline} media={media} apply={apply} />
          : selected.length > 1 ? <p className="pt-1 text-[12px] leading-relaxed text-ink-secondary">Drag to move them together. ⌫ deletes, ⌘D duplicates.</p>
            : <ProjectInspector timeline={timeline} apply={apply} />}
      </div>
    </div>
  );
}

function ProjectInspector({ timeline, apply }: { timeline: VideoTimeline; apply: Apply }) {
  const presets = Object.entries(VIDEO_SIZES) as [VideoSizePreset, { width: number; height: number }][];
  return (
    <div className="flex flex-col gap-5">
      <Field label="Format" hint={`${timeline.width}×${timeline.height}`}>
        <div className="grid grid-cols-2 gap-1.5">
          {presets.map(([key, size]) => {
            const on = size.width === timeline.width && size.height === timeline.height;
            return (
              <button key={key} type="button" onClick={() => apply([{ op: "set_format", width: size.width, height: size.height }])}
                className={cn("flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors", on ? "bg-ink/[.1] text-ink" : "bg-ink/[.04] text-ink/70 hover:bg-ink/[.078]")}>
                <span className="flex w-5 justify-center"><AspectGlyph width={size.width} height={size.height} size={17} /></span>
                <span className="flex flex-col leading-tight">
                  <span className="text-[12px]">{PRESET_NAMES[key]}</span>
                  <span className="text-[10.5px] text-ink-secondary">{aspectName(size.width, size.height)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Frame rate">
        <Segmented label="Frame rate" value={timeline.fps} onChange={fps => apply([{ op: "set_format", fps }])}
          options={[24, 25, 30, 60].map(v => ({ value: v, label: `${v}` }))} />
      </Field>
      <Field label="Background">
        <Swatches label="Background" value={timeline.background} colors={BACKGROUNDS} onChange={c => c && apply([{ op: "set_format", background: c }], { coalesce: "background" })} />
      </Field>
      <p className="text-[11.5px] leading-relaxed text-ink-secondary">Select a clip to change it. Space plays, J K L shuttle, B splits at the playhead, S toggles snapping.</p>
    </div>
  );
}

function ClipInspector({ clip, timeline, media, apply }: { clip: VideoClip; timeline: VideoTimeline; media: VideoMedia[]; apply: Apply }) {
  const found = findClip(timeline, clip.id)!;
  const track = found.track;
  const m = clip.mediaId ? media.find(x => x.id === clip.mediaId) : undefined;
  const update = (patch: Omit<Extract<VideoEditOp, { op: "update_clip" }>, "op" | "clip_id">, coalesce?: string) =>
    apply([{ op: "update_clip", clip_id: clip.id, ...patch }], coalesce ? { coalesce: `${coalesce}:${clip.id}` } : undefined);
  const { nextStart } = neighbours(track, clip.id);
  const maxByMedia = (inPoint: number, speed: number) => (m && m.kind !== "image" && m.duration > 0 ? (m.duration - inPoint) / speed : Infinity);

  const setSpeed = (speed: number) => {
    const span = clip.duration * clipSpeed(clip);
    const duration = Math.min(span / speed, nextStart - clip.start, maxByMedia(clip.in ?? 0, speed));
    update({ speed, duration: round(duration) }, "speed");
  };
  const setDuration = (duration: number) => update({ duration: round(Math.min(duration, nextStart - clip.start, maxByMedia(clip.in ?? 0, clipSpeed(clip)))) });
  const setIn = (inPoint: number) => update({ in: round(inPoint), duration: round(Math.min(clip.duration, maxByMedia(inPoint, clipSpeed(clip)))) });

  const Glyph = track.kind === "text" ? Type : track.kind === "audio" || m?.kind === "audio" ? AudioLines : m?.kind === "image" ? ImageIcon : Film;
  const fadeMax = Math.max(0.1, Math.min(5, clip.duration / 2));

  return (
    <div className="flex flex-col gap-5">
      {track.kind !== "text" && (
        <div className="flex items-center gap-2 rounded-lg bg-ink/[.04] px-2.5 py-2">
          <Glyph size={14} strokeWidth={1.75} className="shrink-0 text-ink/50" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink/80" title={m?.name}>{m?.name ?? "Missing media"}</span>
          {m && m.kind !== "image" && <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">{fmtTime(m.duration)}</span>}
        </div>
      )}
      {track.kind === "text" && <TextFields clip={clip} update={update} />}
      {track.kind !== "text" && m && (
        <>
          {(m.kind !== "image") && (
            <Field label="Volume" hint={`${Math.round((clip.volume ?? 1) * 100)}%`}>
              <Slider label="Volume" min={0} max={2} step={0.01} value={clip.volume ?? 1} onChange={v => update({ volume: Math.abs(v - 1) < 0.03 ? 1 : round(v) }, "volume")} />
            </Field>
          )}
          {m.kind !== "image" && (
            <Field label="Speed" hint={`${clipSpeed(clip)}×`}>
              <Segmented label="Speed" value={clipSpeed(clip)} onChange={setSpeed}
                options={[0.5, 1, 1.5, 2, 4].map(v => ({ value: v, label: `${v}×` }))} />
              <Slider label="Speed" min={0.25} max={4} step={0.05} value={clipSpeed(clip)} onChange={v => setSpeed(Math.round(v * 20) / 20)} />
            </Field>
          )}
          {track.kind === "video" && (
            <Field label="Framing">
              <Segmented label="Framing" value={clip.fit ?? "contain"} onChange={fit => update({ fit })}
                options={[{ value: "contain", label: "Fit" }, { value: "cover", label: "Fill" }]} />
            </Field>
          )}
        </>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        <Field label="Fade in" hint={`${(clip.fadeIn ?? 0).toFixed(1)}s`}>
          <Slider label="Fade in" min={0} max={fadeMax} step={0.05} value={Math.min(fadeMax, clip.fadeIn ?? 0)} onChange={v => update({ fade_in: round(v) }, "fade-in")} />
        </Field>
        <Field label="Fade out" hint={`${(clip.fadeOut ?? 0).toFixed(1)}s`}>
          <Slider label="Fade out" min={0} max={fadeMax} step={0.05} value={Math.min(fadeMax, clip.fadeOut ?? 0)} onChange={v => update({ fade_out: round(v) }, "fade-out")} />
        </Field>
      </div>
      <Field label="Timing">
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <SecondsInput label="Start" value={clip.start} onCommit={v => apply([{ op: "move_clip", clip_id: clip.id, start: round(v) }])} />
            <SecondsInput label="Length" value={clip.duration} min={0.04} onCommit={setDuration} />
          </div>
          {clip.mediaId && m?.kind !== "image" && <SecondsInput label="Source in" value={clip.in ?? 0} onCommit={setIn} />}
        </div>
      </Field>
      {clip.label && (
        <Field label="Note">
          <p className="rounded-lg bg-ink/[.04] px-2.5 py-2 text-[12px] leading-relaxed text-ink/80">{clip.label}</p>
        </Field>
      )}
    </div>
  );
}

function TextFields({ clip, update }: { clip: VideoClip; update: (patch: { text?: string; style?: VideoTextStyle }, coalesce?: string) => string[] | null }) {
  const s = { ...TEXT_STYLE_DEFAULTS, ...clip.style };
  const [text, setText] = useState(clip.text ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  // follow outside changes (undo, bos) while not typing here
  useEffect(() => { if (document.activeElement !== area.current) setText(clip.text ?? ""); }, [clip.text]);
  useEffect(() => { if ((clip.text ?? "") === "Text" || !clip.text) { area.current?.focus(); area.current?.select(); } }, []);
  const style = (patch: VideoTextStyle, coalesce?: string) => update({ style: patch }, coalesce);
  const position = POSITIONS.find(p => Math.abs(p.y - s.y) < 0.02 && Math.abs(s.x - 0.5) < 0.02)?.value;
  return (
    <>
      <Field label="Text">
        <textarea ref={area} value={text} rows={3} maxLength={500} data-video-text-input
          onChange={e => { setText(e.target.value); update({ text: e.target.value }, "text"); }}
          className="w-full resize-y rounded-lg bg-ink/[.04] px-2.5 py-2 text-[13px] leading-snug text-ink outline-none placeholder:text-ink/35 focus:ring-1 focus:ring-ink/20"
          placeholder="Say something" />
      </Field>
      <Field label="Size" hint={`${Math.round(s.size * 1000) / 10}%`}>
        <Slider label="Text size" min={0.02} max={0.2} step={0.002} value={s.size} onChange={v => style({ size: round(v) }, "size")} />
      </Field>
      <Field label="Colour"><Swatches label="Text colour" value={s.color} colors={TEXT_COLORS} onChange={c => c && style({ color: c }, "color")} /></Field>
      <Field label="Box"><Swatches label="Box colour" value={s.background} colors={BOX_COLORS} allowNone onChange={c => style({ background: c }, "box")} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Weight">
          <Segmented label="Weight" value={s.weight} onChange={weight => style({ weight })}
            options={[{ value: 400, label: "Aa", title: "Regular" }, { value: 600, label: <b>Aa</b>, title: "Bold" }, { value: 800, label: <b className="font-black">Aa</b>, title: "Heavy" }]} />
        </Field>
        <Field label="Align">
          <Segmented label="Align" value={s.align} onChange={align => style({ align })}
            options={[{ value: "left", label: <AlignLeft size={13} />, title: "Left" }, { value: "center", label: <AlignCenter size={13} />, title: "Centre" }, { value: "right", label: <AlignRight size={13} />, title: "Right" }]} />
        </Field>
      </div>
      <Field label="Position" hint={position ? undefined : "custom"}>
        <Segmented label="Position" value={position} onChange={v => style({ x: 0.5, y: POSITIONS.find(p => p.value === v)!.y })}
          options={POSITIONS.map(p => ({ value: p.value, label: p.label }))} />
      </Field>
    </>
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;
