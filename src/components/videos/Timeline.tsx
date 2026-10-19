// The timeline: a ruler, tracks stacked the way they draw (overlays on top,
// the base video track under them, audio last), clips with filmstrips and
// waveforms, and the pointer work of moving, trimming and scrubbing. Edits
// leave as VideoEditOps; the playhead moves by refs, never by re-render.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AudioLines, Copy, Eye, EyeOff, Film, Magnet, Maximize2, Plus, Scissors, Trash2, Type, Volume2, VolumeX, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { clipEnd, timelineDuration, type VideoClip, type VideoEditOp, type VideoMedia, type VideoTimeline, type VideoTrack, type VideoTrackKind } from "../../../shared/video";
import { cn } from "@/lib/cn";
import {
  clampZoom, clipNature, displayOrder, EPS, filmstripSlots, fitsTrack, fitZoom, freeStart, minClipLength, neighbours, overlaps,
  peaksForClip, rulerLabel, rulerSteps, sliderToZoom, snap, snapPoints, snapToFrame, trimClip, zoomToSlider, type ClipNature,
} from "./timeline-math";
import type { PlaybackEngine } from "./video-playback";
import { loadPeaks, videoApi } from "./video-api";
import { IconButton, Slider, useElementSize } from "./ui";
import { mediaDrag } from "./MediaBin";
import type { Pulse } from "./use-video-doc";

const RULER = 26;
const PAD = 12;
const SNAP_PX = 8;

export interface TimelineCommands {
  split: () => void;
  remove: (ripple: boolean) => void;
  duplicate: () => void;
  addText: () => void;
}

type Drag =
  | { kind: "move"; ids: string[]; anchor: string; origin: Map<string, { start: number; trackId: string; duration: number }>; x0: number; moved: boolean; dt: number; trackId: string; refused: boolean; snapAt: number | null; wasSelected: boolean; shift: boolean }
  | { kind: "trim"; id: string; trackId: string; edge: "left" | "right"; x0: number; moved: boolean; next: { start: number; duration: number; in?: number }; snapAt: number | null }
  | { kind: "scrub" };

interface DropHint { trackId: string; start: number; duration: number; ok: boolean }

export function Timeline({ timeline, media, botId, videoId, engine, selected, setSelected, apply, flash, pulse, snapOn, setSnapOn, commands, onDropFiles, compact }: {
  timeline: VideoTimeline;
  media: VideoMedia[];
  botId: string;
  videoId: string;
  engine: PlaybackEngine;
  selected: string[];
  setSelected: (ids: string[]) => void;
  apply: (ops: VideoEditOp[], options?: { coalesce?: string; quiet?: boolean }) => string[] | null;
  flash: (text: string) => void;
  pulse: Pulse | null;
  snapOn: boolean;
  setSnapOn: (on: boolean) => void;
  commands: TimelineCommands;
  onDropFiles: (files: File[], place: { trackId: string; start: number }) => void;
  compact: boolean;
}) {
  const HEAD = compact ? 64 : 136;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const view = useElementSize(scrollerRef);
  const [pps, setPps] = useState(40);
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const [scrollX, setScrollX] = useState(0);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const pendingScroll = useRef<number | null>(null);
  const fitted = useRef(false);

  const duration = timelineDuration(timeline);
  const laneW = Math.max(0, view.width - HEAD);
  const contentW = Math.max(laneW, PAD + (Math.max(duration, 10) + Math.max(10, laneW / pps / 2)) * pps);
  const tracks = useMemo(() => displayOrder(timeline.tracks), [timeline.tracks]);
  const mediaById = useMemo(() => new Map(media.map(m => [m.id, m])), [media]);
  const fps = timeline.fps;

  // first fit once the timeline has a width and something on it
  useEffect(() => {
    if (fitted.current || laneW <= 0) return;
    fitted.current = true;
    setPps(fitZoom(duration, laneW));
  }, [laneW, duration]);
  useEffect(() => { fitted.current = false; }, [videoId]);

  const timeAt = useCallback((clientX: number) => {
    const el = scrollerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEAD + el.scrollLeft - PAD) / ppsRef.current);
  }, [HEAD]);

  const trackAtY = (clientY: number): VideoTrack | null => {
    for (const t of timeline.tracks) {
      const el = rowRefs.current.get(t.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return t;
    }
    return null;
  };

  // ---------- playhead (refs only) ----------

  const placePlayhead = useCallback((t: number) => {
    const el = playheadRef.current;
    if (el) el.style.transform = `translateX(${HEAD + PAD + t * ppsRef.current}px)`;
    const sc = scrollerRef.current;
    if (sc && engine.playing && !dragRef.current) {
      const x = PAD + t * ppsRef.current;
      const visible = sc.clientWidth - HEAD;
      if (x > sc.scrollLeft + visible - 24 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 24);
    }
  }, [engine, HEAD]);
  useEffect(() => engine.onTick(placePlayhead), [engine, placePlayhead]);
  useEffect(() => { placePlayhead(engine.currentTime); }, [pps, placePlayhead, engine]);

  // ---------- scrolling and zoom ----------

  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    if (sc && pendingScroll.current !== null) { sc.scrollLeft = Math.max(0, pendingScroll.current); pendingScroll.current = null; setScrollX(sc.scrollLeft); }
  }, [pps]);

  const zoomTo = useCallback((next: number, anchorClientX?: number) => {
    const sc = scrollerRef.current;
    next = clampZoom(next);
    if (!sc) { setPps(next); return; }
    const rect = sc.getBoundingClientRect();
    const offset = anchorClientX === undefined ? Math.min(sc.clientWidth - HEAD, Math.max(0, PAD + engine.currentTime * ppsRef.current - sc.scrollLeft)) : anchorClientX - rect.left - HEAD;
    const t = (sc.scrollLeft + offset - PAD) / ppsRef.current;
    pendingScroll.current = PAD + t * next - offset;
    setPps(next);
  }, [HEAD, engine]);

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomTo(ppsRef.current * Math.exp(-e.deltaY * 0.01), e.clientX);
    };
    let frame = 0;
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setScrollX(sc.scrollLeft)); };
    sc.addEventListener("wheel", onWheel, { passive: false });
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => { sc.removeEventListener("wheel", onWheel); sc.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [zoomTo]);

  const fit = () => { pendingScroll.current = 0; setPps(fitZoom(duration, laneW)); };

  // ---------- ruler ----------

  useEffect(() => {
    const canvas = rulerRef.current;
    if (!canvas || laneW <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(laneW * dpr);
    canvas.height = Math.round(RULER * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, laneW, RULER);
    const css = getComputedStyle(canvas);
    const ink = css.getPropertyValue("--color-ink").trim() || "#fcfcfc";
    const { major, minor } = rulerSteps(pps, fps);
    const from = Math.max(0, (scrollX - PAD) / pps);
    const to = (scrollX + laneW) / pps;
    ctx.font = "10px Inter, -apple-system, sans-serif";
    ctx.textBaseline = "top";
    for (let i = Math.floor(from / minor); i * minor <= to + minor; i++) {
      const t = i * minor;
      const x = Math.round(PAD + t * pps - scrollX) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.globalAlpha = isMajor ? 0.45 : 0.2;
      ctx.fillStyle = ink;
      ctx.fillRect(x - 0.5, isMajor ? RULER - 10 : RULER - 5, 1, isMajor ? 10 : 5);
      if (isMajor) {
        ctx.globalAlpha = 0.55;
        ctx.fillText(rulerLabel(t, major, fps), x + 4, 5);
      }
    }
    ctx.globalAlpha = 1;
  }, [pps, scrollX, laneW, fps]);

  // ---------- pointer work ----------

  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  const listen = (onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void) => {
    const move = (e: PointerEvent) => onMove(e);
    const up = (e: PointerEvent) => { stop(); onUp(e); };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      endDrag.current = null;
    };
    const cancel = () => { stop(); setDrag(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    endDrag.current = stop;
  };

  const startScrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const wasPlaying = engine.playing;
    engine.seek(timeAt(e.clientX));
    setDrag({ kind: "scrub" });
    listen(ev => engine.seek(timeAt(ev.clientX)), () => { setDrag(null); if (wasPlaying) engine.play(1); });
  };

  const natureOf = (clip: VideoClip): ClipNature => clipNature(clip, media);
  const trackOf = (id: string) => timeline.tracks.find(t => t.clips.some(c => c.id === id));

  const startClip = (e: ReactPointerEvent, clip: VideoClip, track: VideoTrack, part: "body" | "left" | "right") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const wasSelected = selected.includes(clip.id);
    let ids = selected;
    if (e.shiftKey) ids = wasSelected ? selected.filter(x => x !== clip.id) : [...selected, clip.id];
    else if (!wasSelected || part !== "body") ids = [clip.id];
    setSelected(ids);
    if (e.shiftKey && wasSelected) return;

    if (part !== "body") {
      const d: Drag = { kind: "trim", id: clip.id, trackId: track.id, edge: part, x0: e.clientX, moved: false, next: { start: clip.start, duration: clip.duration, in: clip.in }, snapAt: null };
      setDrag(d);
      const bounds = neighbours(track, clip.id);
      const m = clip.mediaId ? mediaById.get(clip.mediaId) : undefined;
      const points = snapPoints(timeline, new Set([clip.id]), engine.currentTime);
      listen(ev => {
        const cur = dragRef.current;
        if (!cur || cur.kind !== "trim") return;
        if (!cur.moved && Math.abs(ev.clientX - cur.x0) < 2) return;
        let to = (part === "left" ? clip.start : clipEnd(clip)) + (ev.clientX - cur.x0) / ppsRef.current;
        let snapAt: number | null = null;
        if (snapOn && !ev.altKey) { const r = snap(to, points, SNAP_PX / ppsRef.current); to = r.t; snapAt = r.at; }
        if (snapAt === null) to = snapToFrame(to, fps);
        setDrag({ ...cur, moved: true, next: trimClip(clip, m, part, to, bounds, minClipLength(fps)), snapAt });
      }, () => {
        const cur = dragRef.current;
        setDrag(null);
        if (!cur || cur.kind !== "trim" || !cur.moved) return;
        const n = cur.next;
        if (Math.abs(n.start - clip.start) < EPS && Math.abs(n.duration - clip.duration) < EPS) return;
        apply([{ op: "update_clip", clip_id: clip.id, start: round(n.start), duration: round(n.duration), ...(n.in !== undefined ? { in: round(n.in) } : {}) }]);
      });
      return;
    }

    const moving = ids.includes(clip.id) ? ids : [clip.id];
    const origin = new Map<string, { start: number; trackId: string; duration: number }>();
    for (const id of moving) {
      const t = trackOf(id);
      const c = t?.clips.find(x => x.id === id);
      if (t && c) origin.set(id, { start: c.start, trackId: t.id, duration: c.duration });
    }
    const exclude = new Set(origin.keys());
    const points = snapPoints(timeline, exclude, engine.currentTime);
    const single = origin.size === 1;
    const nature = natureOf(clip);
    const d: Drag = { kind: "move", ids: [...origin.keys()], anchor: clip.id, origin, x0: e.clientX, moved: false, dt: 0, trackId: track.id, refused: false, snapAt: null, wasSelected, shift: e.shiftKey };
    setDrag(d);
    listen(ev => {
      const cur = dragRef.current;
      if (!cur || cur.kind !== "move") return;
      if (!cur.moved && Math.abs(ev.clientX - cur.x0) < 3 && !(single && trackAtY(ev.clientY)?.id !== track.id)) return;
      const a = origin.get(clip.id)!;
      let start = Math.max(0, a.start + (ev.clientX - cur.x0) / ppsRef.current);
      let trackId = a.trackId;
      if (single) {
        const over = trackAtY(ev.clientY);
        if (over && fitsTrack(over.kind, nature)) trackId = over.id;
      }
      let snapAt: number | null = null;
      if (snapOn && !ev.altKey) { const r = snap(start, points, SNAP_PX / ppsRef.current, [0, a.duration]); start = Math.max(0, r.t); snapAt = r.at; }
      if (snapAt === null) start = snapToFrame(start, fps);
      let dt = start - a.start;
      const lowest = Math.min(...[...origin.values()].map(o => o.start));
      if (lowest + dt < 0) dt = -lowest;
      let refused = false;
      if (single) {
        const target = timeline.tracks.find(t => t.id === trackId)!;
        const free = freeStart(target.clips, a.start + dt, a.duration, exclude, Math.max(0.25, 24 / ppsRef.current));
        if (free === null) refused = true;
        else if (Math.abs(free - (a.start + dt)) > EPS) { dt = free - a.start; snapAt = null; }
      } else {
        for (const [, o] of origin) {
          const t = timeline.tracks.find(x => x.id === o.trackId)!;
          if (overlaps(t.clips, o.start + dt, o.duration, exclude)) { refused = true; break; }
        }
      }
      setDrag({ ...cur, moved: true, dt, trackId, refused, snapAt });
    }, () => {
      const cur = dragRef.current;
      setDrag(null);
      if (!cur || cur.kind !== "move") return;
      if (!cur.moved) {
        if (cur.wasSelected && !cur.shift && ids.length > 1) setSelected([clip.id]);
        return;
      }
      if (cur.refused) { flash("no room there; the clip went back"); return; }
      const a = origin.get(clip.id)!;
      if (Math.abs(cur.dt) < EPS && cur.trackId === a.trackId) return;
      apply([...origin].map(([id, o]): VideoEditOp => ({
        op: "move_clip", clip_id: id, start: round(Math.max(0, o.start + cur.dt)),
        ...(single && cur.trackId !== o.trackId ? { track_id: cur.trackId } : {}),
      })));
    });
  };

  const laneDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    setSelected([]);
    startScrub(e);
  };

  // ---------- drops from the media bin and Finder ----------

  const dropPlace = (e: React.DragEvent, track: VideoTrack): DropHint | null => {
    const m = mediaDrag.current;
    const files = !m && e.dataTransfer.types.includes("Files");
    if (!m && !files) return null;
    if (m && !fitsTrack(track.kind, m.kind)) return { trackId: track.id, start: timeAt(e.clientX), duration: m.kind === "image" ? 3 : m.duration, ok: false };
    if (files && track.kind === "text") return { trackId: track.id, start: timeAt(e.clientX), duration: 3, ok: false };
    const length = m ? (m.kind === "image" || !(m.duration > 0) ? 3 : m.duration) : 3;
    let start = snapToFrame(timeAt(e.clientX), fps);
    if (snapOn) start = snap(start, snapPoints(timeline, new Set(), engine.currentTime), SNAP_PX / pps, [0, length]).t;
    const free = freeStart(track.clips, start, length, new Set(), Infinity);
    return { trackId: track.id, start: free ?? start, duration: length, ok: free !== null };
  };

  const laneDragOver = (e: React.DragEvent, track: VideoTrack) => {
    const hint = dropPlace(e, track);
    if (!hint) return;
    if (hint.ok) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
    setDropHint(h => (h && h.trackId === hint.trackId && Math.abs(h.start - hint.start) < EPS && h.ok === hint.ok ? h : hint));
  };

  const laneDrop = (e: React.DragEvent, track: VideoTrack) => {
    const hint = dropPlace(e, track);
    setDropHint(null);
    if (!hint?.ok) return;
    e.preventDefault();
    e.stopPropagation();
    const m = mediaDrag.current;
    mediaDrag.current = null;
    if (m) {
      const created = apply([{ op: "add_clip", track_id: track.id, media_id: m.id, start: round(hint.start), ...(m.kind === "image" ? { duration: 3 } : {}) }]);
      if (created?.length) setSelected(created);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length) onDropFiles(files, { trackId: track.id, start: hint.start });
  };

  // ---------- rendering ----------

  const pulsing = pulse && Date.now() - pulse.at < 4000 ? pulse : null;
  const visibleFrom = scrollX - 200, visibleTo = scrollX + laneW + 200;
  const hasSelection = selected.length > 0;
  const fadedTracks = (t: VideoTrack) => t.hidden || (t.kind === "audio" && t.muted);

  const placed = (track: VideoTrack): { clip: VideoClip; start: number; duration: number; inPoint?: number; moving: boolean; refused: boolean }[] => {
    const out: ReturnType<typeof placed> = [];
    const d = drag;
    const all = d?.kind === "move" && d.moved ? timeline.tracks.flatMap(t => t.clips.map(c => ({ c, t }))) : track.clips.map(c => ({ c, t: track }));
    for (const { c, t } of all) {
      if (d?.kind === "move" && d.moved && d.origin.has(c.id)) {
        const o = d.origin.get(c.id)!;
        const onTrack = d.ids.length === 1 ? d.trackId : o.trackId;
        if (onTrack !== track.id) continue;
        out.push({ clip: c, start: Math.max(0, o.start + d.dt), duration: c.duration, moving: true, refused: d.refused });
        continue;
      }
      if (t.id !== track.id) continue;
      if (d?.kind === "trim" && d.id === c.id && d.moved) { out.push({ clip: c, start: d.next.start, duration: d.next.duration, inPoint: d.next.in, moving: true, refused: false }); continue; }
      out.push({ clip: c, start: c.start, duration: c.duration, moving: false, refused: false });
    }
    return out;
  };

  const snapLine = drag && (drag.kind === "move" || drag.kind === "trim") ? drag.snapAt : null;
  const zoomSlider = zoomToSlider(pps);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-ink/[.07] px-2">
        <IconButton icon={Scissors} label="Split at playhead" shortcut="B" onClick={commands.split} />
        <IconButton icon={Trash2} label="Delete" shortcut="⌫" onClick={() => commands.remove(false)} disabled={!hasSelection} />
        {!compact && <IconButton icon={Copy} label="Duplicate" shortcut="⌘D" onClick={commands.duplicate} disabled={!hasSelection} />}
        <span className="mx-1 h-4 w-px bg-ink/10" />
        <IconButton icon={Type} label="Add text" shortcut="T" onClick={commands.addText} />
        <div className="relative">
          <IconButton icon={Plus} label="Add track" onClick={() => setAddMenu(v => !v)} active={addMenu}>{!compact && <span>Track</span>}</IconButton>
          {addMenu && (
            <>
              <div className="fixed inset-0 z-40" onPointerDown={() => setAddMenu(false)} />
              <div className="absolute left-0 top-8 z-50 w-40 rounded-xl bg-menu p-1 shadow-[0_8px_28px_rgba(0,0,0,.35)] ring-1 ring-ink/10">
                {([["video", "Video track", Film], ["text", "Text track", Type], ["audio", "Audio track", AudioLines]] as const).map(([kind, label, Glyph]) => (
                  <button key={kind} type="button" onMouseDown={e => e.preventDefault()}
                    onClick={() => { setAddMenu(false); addTrack(kind); }}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-ink/85 hover:bg-ink/[.078]">
                    <Glyph size={14} strokeWidth={1.75} />{label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex-1" />
        <IconButton icon={Magnet} label={snapOn ? "Snapping on" : "Snapping off"} shortcut="S" active={snapOn} onClick={() => setSnapOn(!snapOn)} />
        <span className="mx-1 h-4 w-px bg-ink/10" />
        <IconButton icon={ZoomOut} label="Zoom out" shortcut="-" onClick={() => zoomTo(pps / 1.5)} />
        {!compact && <div className="w-24"><Slider label="Zoom" min={0} max={1} step={0.001} value={zoomSlider} onChange={v => zoomTo(sliderToZoom(v))} /></div>}
        <IconButton icon={ZoomIn} label="Zoom in" shortcut="=" onClick={() => zoomTo(pps * 1.5)} />
        <IconButton icon={Maximize2} label="Fit timeline" onClick={fit} size={14} />
      </div>

      <div ref={scrollerRef} className={cn("video-scroll relative min-h-0 flex-1 overflow-auto overscroll-contain", drag?.kind === "scrub" && "cursor-ew-resize")}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(null); }}>
        <div className="relative" style={{ width: HEAD + contentW, minHeight: "100%" }}>
          <div className="sticky top-0 z-30 flex bg-panel" style={{ height: RULER }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-ink/[.07] bg-panel" style={{ width: HEAD }} />
            <canvas ref={rulerRef} className="sticky cursor-pointer border-b border-ink/[.07]" style={{ left: HEAD, width: laneW, height: RULER }}
              onPointerDown={startScrub} />
          </div>

          {tracks.map(track => {
            const h = trackHeight(track.kind, compact);
            const hint = dropHint?.trackId === track.id ? dropHint : null;
            return (
              <div key={track.id} className="flex border-b border-ink/[.05]" style={{ height: h }}
                ref={el => { if (el) rowRefs.current.set(track.id, el); else rowRefs.current.delete(track.id); }}>
                <TrackHeader track={track} width={HEAD} compact={compact} apply={apply} canDelete={timeline.tracks.length > 1} />
                <div className={cn("relative flex-1", fadedTracks(track) && "opacity-45")}
                  onPointerDown={laneDown}
                  onDragOver={e => laneDragOver(e, track)} onDrop={e => laneDrop(e, track)}>
                  {placed(track).map(p => {
                    const x = PAD + p.start * pps, w = Math.max(2, p.duration * pps);
                    if (x + w < visibleFrom || x > visibleTo) return null;
                    const m = p.clip.mediaId ? mediaById.get(p.clip.mediaId) : undefined;
                    const clip = p.inPoint !== undefined || p.duration !== p.clip.duration || p.start !== p.clip.start
                      ? { ...p.clip, start: p.start, duration: p.duration, ...(p.inPoint !== undefined ? { in: p.inPoint } : {}) } : p.clip;
                    return (
                      <ClipView key={pulsing?.ids.has(p.clip.id) ? `${p.clip.id}:${pulsing.at}` : p.clip.id} clip={clip} track={track} media={m} x={x} width={w} height={h} pps={pps}
                        window={{ from: Math.max(0, scrollX - x), to: scrollX + laneW - x }}
                        botId={botId} videoId={videoId}
                        selected={selected.includes(p.clip.id)} moving={p.moving} refused={p.refused}
                        pulseKey={pulsing?.ids.has(p.clip.id) ? pulsing.at : 0}
                        onPointerDown={(e, part) => startClip(e, p.clip, track, part)} />
                    );
                  })}
                  {hint && (
                    <div className={cn("pointer-events-none absolute inset-y-1 rounded-md border-2 border-dashed", hint.ok ? "border-accent bg-accent/15" : "border-danger bg-danger/10")}
                      style={{ left: PAD + hint.start * pps, width: Math.max(4, hint.duration * pps) }} />
                  )}
                </div>
              </div>
            );
          })}
          <div className="pointer-events-none flex min-h-6 items-center" style={{ paddingLeft: HEAD + PAD }} />

          {snapLine !== null && (
            <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-warning" style={{ left: HEAD + PAD + snapLine * pps }} />
          )}
          <div ref={playheadRef} className="pointer-events-none absolute bottom-0 left-0 top-0 z-[25] w-0" style={{ transform: `translateX(${HEAD + PAD}px)` }}>
            <div className="absolute bottom-0 top-0 -left-px w-[2px] bg-ink" />
            <div className="pointer-events-auto absolute -left-[6px] top-[2px] h-[14px] w-3 cursor-ew-resize rounded-[3px] bg-ink" style={{ clipPath: "polygon(0 0,100% 0,100% 62%,50% 100%,0 62%)" }}
              onPointerDown={startScrub} />
          </div>
        </div>
      </div>
    </div>
  );

  function addTrack(kind: VideoTrackKind) {
    // a new overlay goes just above the topmost track of its kind; audio at the end
    const lastOfKind = timeline.tracks.map(t => t.kind).lastIndexOf(kind);
    const index = kind === "audio" ? timeline.tracks.length : lastOfKind >= 0 ? lastOfKind + 1 : timeline.tracks.length;
    const count = timeline.tracks.filter(t => t.kind === kind).length;
    const name = `${kind === "video" ? "Video" : kind === "text" ? "Text" : "Audio"} ${count + 1}`;
    apply([{ op: "add_track", kind, name, index }]);
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function trackHeight(kind: VideoTrackKind, compact: boolean): number {
  if (kind === "video") return compact ? 50 : 60;
  if (kind === "audio") return compact ? 40 : 48;
  return compact ? 30 : 34;
}

function TrackHeader({ track, width, compact, apply, canDelete }: {
  track: VideoTrack; width: number; compact: boolean; canDelete: boolean;
  apply: (ops: VideoEditOp[]) => string[] | null;
}) {
  const Glyph = track.kind === "video" ? Film : track.kind === "text" ? Type : AudioLines;
  const visual = track.kind !== "audio";
  const toggle = (patch: { muted?: boolean; hidden?: boolean }) => apply([{ op: "update_track", track_id: track.id, ...patch }]);
  return (
    <div className="group sticky left-0 z-20 flex shrink-0 items-center gap-0.5 border-r border-ink/[.07] bg-panel pl-2 pr-1" style={{ width }}>
      <Glyph size={13} strokeWidth={1.75} className="shrink-0 text-ink/45" />
      {!compact && <span className="ml-1 min-w-0 flex-1 truncate text-[11.5px] text-ink/70" title={track.name}>{track.name ?? (track.kind === "video" ? "Video" : track.kind === "text" ? "Text" : "Audio")}</span>}
      {compact && <span className="flex-1" />}
      {track.kind !== "text" && (!compact || !visual) && (
        <IconButton icon={track.muted ? VolumeX : Volume2} size={13} label={track.muted ? "Unmute track" : "Mute track"} active={track.muted}
          className={cn("h-6 min-w-6", track.muted && "text-danger")} onClick={() => toggle({ muted: !track.muted })} />
      )}
      {visual && (
        <IconButton icon={track.hidden ? EyeOff : Eye} size={13} label={track.hidden ? "Show track" : "Hide track"} active={track.hidden}
          className={cn("h-6 min-w-6", track.hidden && "text-danger")} onClick={() => toggle({ hidden: !track.hidden })} />
      )}
      {!compact && canDelete && (
        <IconButton icon={X} size={13} label="Delete track" className="hidden h-6 min-w-6 group-hover:inline-flex"
          onClick={() => apply([{ op: "delete_track", track_id: track.id }])} />
      )}
    </div>
  );
}

function ClipView({ clip, track, media, x, width, height, pps, window, botId, videoId, selected, moving, refused, pulseKey, onPointerDown }: {
  clip: VideoClip; track: VideoTrack; media: VideoMedia | undefined; x: number; width: number; height: number; pps: number;
  window: { from: number; to: number }; botId: string; videoId: string;
  selected: boolean; moving: boolean; refused: boolean; pulseKey: number;
  onPointerDown: (e: ReactPointerEvent, part: "body" | "left" | "right") => void;
}) {
  const isText = track.kind === "text";
  const isAudio = track.kind === "audio";
  const tone = isText ? "border-usage-3/60 bg-usage-3/25" : isAudio ? "border-success/45 bg-success/15" : "border-accent/50 bg-accent/20";
  const inner = height - 8;
  const label = isText ? (clip.text || "Text") : media?.name ?? "Missing media";
  const handle = width > 18 ? 6 : 3;
  return (
    <div
      className={cn("group/clip absolute top-1 overflow-hidden rounded-md border", tone,
        selected && "border-ink outline outline-1 outline-ink", moving && "z-10 shadow-[0_6px_18px_rgba(0,0,0,.45)]", refused && "video-refuse opacity-70",
        pulseKey > 0 && "video-pulse")}
      style={{ left: x, width, height: inner, cursor: moving ? "grabbing" : "grab" }}
      onPointerDown={e => onPointerDown(e, "body")}
      title={clip.label ? `${label}\n${clip.label}` : label}>
      {!isText && !isAudio && media?.thumbs && <Filmstrip clip={clip} media={media} height={inner - 2} pps={pps} window={window} url={videoApi.thumbsUrl(botId, videoId, media.id)} />}
      {isAudio && media?.peaks && <Waveform clip={clip} media={media} height={inner - 2} pps={pps} window={window} url={videoApi.peaksUrl(botId, videoId, media.id)} />}
      <div className={cn("pointer-events-none relative flex h-full min-w-0 items-start gap-1 px-1.5", isText ? "items-center" : "pt-[3px]")}>
        <span className={cn("truncate text-[11px] leading-4", isText ? "text-ink/90" : "rounded bg-black/45 px-1 text-white/90")}>
          {width > 30 ? label : ""}
        </span>
        {width > 90 && !isText && <span className="ml-auto shrink-0 rounded bg-black/45 px-1 text-[10px] leading-4 tabular-nums text-white/75">{clip.duration.toFixed(1)}s</span>}
      </div>
      {(clip.fadeIn ?? 0) > 0 && <div className="pointer-events-none absolute left-0 top-0 h-full bg-black/25" style={{ width: Math.min(width, (clip.fadeIn ?? 0) * pps), clipPath: "polygon(0 0,100% 0,0 100%)" }} />}
      {(clip.fadeOut ?? 0) > 0 && <div className="pointer-events-none absolute right-0 top-0 h-full bg-black/25" style={{ width: Math.min(width, (clip.fadeOut ?? 0) * pps), clipPath: "polygon(0 0,100% 0,100% 100%)" }} />}
      <div className={cn("absolute inset-y-0 left-0 cursor-ew-resize", selected ? "bg-ink/70" : "group-hover/clip:bg-ink/40")} style={{ width: handle }}
        onPointerDown={e => onPointerDown(e, "left")} />
      <div className={cn("absolute inset-y-0 right-0 cursor-ew-resize", selected ? "bg-ink/70" : "group-hover/clip:bg-ink/40")} style={{ width: handle }}
        onPointerDown={e => onPointerDown(e, "right")} />
    </div>
  );
}

function Filmstrip({ clip, media, height, pps, window, url }: { clip: VideoClip; media: VideoMedia; height: number; pps: number; window: { from: number; to: number }; url: string }) {
  const thumbs = media.thumbs!;
  const tileW = Math.max(8, height * (thumbs.width / thumbs.height));
  const columns = Math.min(10, Math.max(1, thumbs.count));
  const rows = Math.ceil(thumbs.count / columns);
  const slots = filmstripSlots(clip, thumbs, pps, tileW, window);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-90">
      {slots.map(s => (
        <div key={s.x} className="absolute top-0" style={{
          left: s.x, width: tileW, height, backgroundImage: `url("${url}")`, backgroundRepeat: "no-repeat",
          backgroundSize: `${columns * tileW}px ${rows * height}px`,
          backgroundPosition: `${-(s.index % columns) * tileW}px ${-Math.floor(s.index / columns) * height}px`,
        }} />
      ))}
    </div>
  );
}

function Waveform({ clip, media, height, pps, window, url }: { clip: VideoClip; media: VideoMedia; height: number; pps: number; window: { from: number; to: number }; url: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = clip.duration * pps;
  const from = Math.max(0, Math.floor(window.from));
  const to = Math.min(width, Math.ceil(window.to));
  const span = Math.max(0, to - from);
  const perSecond = media.peaks!.perSecond;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || span <= 0) return;
    let live = true;
    void loadPeaks(url).then(peaks => {
      if (!live) return;
      const dpr = globalThis.window.devicePixelRatio || 1;
      canvas.width = Math.round(span * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, span, height);
      const columns = Math.max(1, Math.floor(span / 2));
      const speed = clip.speed ?? 1;
      const sub: VideoClip = { ...clip, start: 0, duration: span / pps, in: (clip.in ?? 0) + (from / pps) * speed };
      const bars = peaksForClip(peaks, perSecond, sub, columns);
      ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--color-success").trim() || "#38d591";
      ctx.globalAlpha = 0.8;
      const mid = height / 2 + 6;
      const amp = height / 2 - 8;
      bars.forEach((b, i) => { const h = Math.max(1, b * amp * 2 * (clip.volume ?? 1) ** 0.5); ctx.fillRect(i * 2, mid - h / 2, 1.2, h); });
    });
    return () => { live = false; };
  }, [url, span, from, height, pps, perSecond, clip]);
  if (span <= 0) return null;
  return <canvas ref={ref} className="pointer-events-none absolute top-0" style={{ left: from, width: span, height }} />;
}
