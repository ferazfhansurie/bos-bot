// The video tab: a timeline editor the person and bos cut together. Loaded
// lazily (see register.tsx). Layout: bin | preview | inspector over the
// timeline when wide; drawers over the preview when narrow.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp, ChevronLeft, Download, Loader2, Pause, Play, Redo2, Repeat, SkipBack, SkipForward, SlidersHorizontal, FolderOpen, Undo2, X,
} from "lucide-react";
import {
  clipEnd, clipsAt, emptyTimeline, findClip, fmtTime, timelineDuration, VIDEO_LIMITS,
  type VideoEditOp, type VideoMedia, type VideoRender, type VideoTimeline,
} from "../../../shared/video";
import { cn } from "@/lib/cn";
import { useVideoDoc, editMessage, type VideoDoc } from "./use-video-doc";
import { PlaybackEngine, type PlaybackState } from "./video-playback";
import { videoApi } from "./video-api";
import { EPS, fmtTimecode, overlaps, snapToFrame } from "./timeline-math";
import { Preview } from "./Preview";
import { Timeline, type TimelineCommands } from "./Timeline";
import { Inspector } from "./Inspector";
import { MediaBin, type UploadItem } from "./MediaBin";
import { VideoList } from "./VideoList";
import { IconButton, aspectName, useElementSize } from "./ui";
import "./videos.css";

interface Props {
  botId: string;
  threadId: string;
  videoId?: string;
  active: boolean;
  onVideo: (id: string, title: string) => void;
  onList: () => void;
  onAsk: (text: string, threadId: string) => void;
}

export function VideoEditor(props: Props) {
  if (!props.videoId) return <VideoList botId={props.botId} threadId={props.threadId} onOpen={props.onVideo} />;
  return <Editor key={`${props.botId}/${props.videoId}`} {...props} videoId={props.videoId} />;
}

const WIDE = 860;
const ACCEPT = "video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac";
const round = (v: number) => Math.round(v * 1000) / 1000;
const stored = (key: string, fallback: number) => { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : fallback; };

function Editor({ botId, threadId, videoId, active, onVideo, onList, onAsk }: Props & { videoId: string }) {
  const doc = useVideoDoc(botId, videoId);
  const { video, timeline } = doc;
  const rootRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(rootRef);
  const wide = size.width >= WIDE;
  const compact = size.width > 0 && size.width < 620;
  const [selected, setSelected] = useState<string[]>([]);
  const [snapOn, setSnapOnState] = useState(() => localStorage.getItem("bos.video.snap") !== "0");
  const setSnapOn = (on: boolean) => { setSnapOnState(on); localStorage.setItem("bos.video.snap", on ? "1" : "0"); };
  const [drawer, setDrawer] = useState<"bin" | "inspector" | null>(null);
  const [timelineH, setTimelineH] = useState(() => stored("bos.video.timeline", 0));
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickPlace = useRef<{ trackId: string; start: number } | "append" | null>(null);

  // ---------- playback ----------

  const engine = useMemo(() => new PlaybackEngine(emptyTimeline("landscape"), [], m => videoApi.mediaUrl(botId, videoId, m)), [botId, videoId]);
  useEffect(() => () => engine.destroy(), [engine]);
  useEffect(() => { if (timeline && video) engine.setSource(timeline, video.media); }, [engine, timeline, video?.media]); // eslint-disable-line react-hooks/exhaustive-deps
  const [play, setPlay] = useState<PlaybackState>(engine.state);
  useEffect(() => engine.onState(setPlay), [engine]);
  useEffect(() => { if (!active) engine.pause(); }, [active, engine]);

  // keep the selection to clips that still exist (undo, bos deleting one)
  useEffect(() => {
    if (!timeline) return;
    setSelected(sel => { const next = sel.filter(id => findClip(timeline, id)); return next.length === sel.length ? sel : next; });
  }, [timeline]);

  // clear a notice after a moment
  useEffect(() => {
    if (!doc.notice) return;
    const t = setTimeout(doc.clearNotice, doc.notice.tone === "error" ? 4500 : 6000);
    return () => clearTimeout(t);
  }, [doc.notice, doc.clearNotice]);

  // ---------- uploads ----------

  const placeChain = useRef<Promise<unknown>>(Promise.resolve());
  const upload = useCallback((files: File[], place?: { trackId: string; start: number } | "append") => {
    let cursor = place && place !== "append" ? place.start : 0;
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      const drop = () => setUploads(u => u.filter(x => x.key !== key));
      const patch = (p: Partial<UploadItem>) => setUploads(u => u.map(x => (x.key === key ? { ...x, ...p } : x)));
      setUploads(u => [...u, { key, name: file.name, progress: 0, cancel: () => { controller.abort(); drop(); } }]);
      if (file.size > VIDEO_LIMITS.mediaBytes) { patch({ error: "Larger than 8 GB." }); continue; }
      const sent = videoApi.upload(botId, videoId, file, progress => patch({ progress }), controller.signal);
      // clips land in the order the files were dropped, one after another
      placeChain.current = placeChain.current.then(() => sent).then(async ({ video: v, media }) => {
        drop();
        await doc.absorb(v, "human");
        if (!place) return;
        if (place === "append") { appendMedia(media); return; }
        const placed = placeMedia(media, place.trackId, cursor);
        if (placed) cursor = placed;
      }, error => { if (!controller.signal.aborted) patch({ error: editMessage(error) }); });
    }
  }, [botId, videoId, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Puts media on a track at a time (or the next free spot); returns where it ends. */
  function placeMedia(media: VideoMedia, trackId: string, start: number): number | null {
    const { timeline: tl } = doc.current();
    const track = tl?.tracks.find(t => t.id === trackId);
    if (!tl || !track) return null;
    const length = media.kind === "image" || !(media.duration > 0) ? 3 : media.duration;
    let at = start;
    for (let guard = 0; guard < 600 && overlaps(track.clips, at, length); guard++) {
      const hit = track.clips.find(c => at < clipEnd(c) - EPS && at + length > c.start + EPS)!;
      at = clipEnd(hit);
    }
    const created = doc.apply([{ op: "add_clip", track_id: trackId, media_id: media.id, start: round(at), ...(media.kind === "image" ? { duration: 3 } : {}) }]);
    if (created) setSelected(created);
    return created ? at + length : null;
  }

  /** Double-click in the bin: to the end of the base track of its kind. */
  function appendMedia(media: VideoMedia) {
    const { timeline: tl } = doc.current();
    if (!tl) return;
    const kind = media.kind === "audio" ? "audio" : "video";
    const track = tl.tracks.find(t => t.kind === kind);
    const key = `append-${Date.now()}`;
    let trackId = track?.id;
    if (!trackId) {
      const made = doc.apply([{ op: "add_track", kind, name: kind === "audio" ? "Audio" : "Video", ...(kind === "video" ? { index: 0 } : {}) }], { coalesce: key });
      trackId = made?.[0];
    }
    if (!trackId) return;
    const created = doc.apply([{ op: "add_clip", track_id: trackId, media_id: media.id, ...(media.kind === "image" ? { duration: 3 } : {}) }], { coalesce: key });
    if (created) setSelected(created);
  }

  const pickFiles = (place: { trackId: string; start: number } | "append" | null = "append") => { pickPlace.current = place; fileInput.current?.click(); };

  // ---------- commands ----------

  const commands: TimelineCommands = {
    split: () => {
      const tl = doc.current().timeline;
      if (!tl) return;
      const t = snapToFrame(engine.currentTime, tl.fps);
      const pick = selected.length ? selected.map(id => findClip(tl, id)).filter(Boolean).map(f => f!.clip) : clipsAt(tl, t).map(x => x.clip);
      const targets = pick.filter(c => t > c.start + 0.02 && t < clipEnd(c) - 0.02);
      if (!targets.length) { doc.flash(selected.length ? "move the playhead inside the selected clip to split it" : "put the playhead over a clip to split it", "info"); return; }
      doc.apply(targets.map((c): VideoEditOp => ({ op: "split", clip_id: c.id, at: round(t) })));
    },
    remove: ripple => {
      const tl = doc.current().timeline;
      if (!tl || !selected.length) return;
      const clips = selected.map(id => findClip(tl, id)).filter(Boolean).map(f => f!.clip).sort((a, b) => b.start - a.start);
      if (doc.apply(clips.map((c): VideoEditOp => ({ op: "delete_clip", clip_id: c.id, ...(ripple ? { ripple: true } : {}) })))) setSelected([]);
    },
    duplicate: () => {
      const tl = doc.current().timeline;
      if (!tl || !selected.length) return;
      const taken = new Map<string, { start: number; end: number }[]>();
      const ops: VideoEditOp[] = [];
      const fades: { fadeIn?: number; fadeOut?: number }[] = [];
      for (const id of selected) {
        const f = findClip(tl, id);
        if (!f) continue;
        const c = f.clip;
        const busy = [...f.track.clips.map(x => ({ start: x.start, end: clipEnd(x) })), ...(taken.get(f.track.id) ?? [])];
        let at = clipEnd(c);
        for (let guard = 0; guard < 600; guard++) {
          const hit = busy.find(b => at < b.end - EPS && at + c.duration > b.start + EPS);
          if (!hit) break;
          at = hit.end;
        }
        taken.set(f.track.id, [...(taken.get(f.track.id) ?? []), { start: at, end: at + c.duration }]);
        ops.push({ op: "add_clip", track_id: f.track.id, start: round(at), duration: c.duration, ...(c.mediaId ? { media_id: c.mediaId, in: c.in ?? 0 } : {}),
          ...(c.text !== undefined ? { text: c.text } : {}), ...(c.style ? { style: c.style } : {}), ...(c.speed ? { speed: c.speed } : {}),
          ...(c.volume !== undefined ? { volume: c.volume } : {}), ...(c.fit ? { fit: c.fit } : {}), ...(c.label ? { label: c.label } : {}) });
        fades.push({ fadeIn: c.fadeIn, fadeOut: c.fadeOut });
      }
      const key = `dup-${Date.now()}`;
      const created = doc.apply(ops, { coalesce: key });
      if (!created) return;
      const fadeOps = created.flatMap((id, i): VideoEditOp[] => (fades[i]?.fadeIn || fades[i]?.fadeOut ? [{ op: "update_clip", clip_id: id, ...(fades[i]!.fadeIn ? { fade_in: fades[i]!.fadeIn } : {}), ...(fades[i]!.fadeOut ? { fade_out: fades[i]!.fadeOut } : {}) }] : []));
      if (fadeOps.length) doc.apply(fadeOps, { coalesce: key });
      setSelected(created);
    },
    addText: () => {
      const tl = doc.current().timeline;
      if (!tl) return;
      const t = snapToFrame(engine.currentTime, tl.fps);
      const key = `text-${Date.now()}`;
      // the topmost text track with room at the playhead, else a new one
      const texts = tl.tracks.filter(x => x.kind === "text").reverse();
      let trackId: string | undefined, length = 3;
      for (const track of texts) {
        const next = track.clips.filter(c => c.start >= t - EPS).reduce((m, c) => Math.min(m, c.start), Infinity);
        const room = Math.min(3, next - t);
        if (room >= 0.5 && !overlaps(track.clips, t, room)) { trackId = track.id; length = room; break; }
      }
      if (!trackId) trackId = doc.apply([{ op: "add_track", kind: "text", name: `Text ${texts.length + 1}` }], { coalesce: key })?.[0];
      if (!trackId) return;
      const created = doc.apply([{ op: "add_clip", track_id: trackId, text: "Text", start: round(t), duration: round(length) }], { coalesce: key });
      if (created) { setSelected(created); if (!wide) setDrawer("inspector"); }
    },
  };

  const selectAll = () => { const tl = doc.current().timeline; if (tl) setSelected(tl.tracks.flatMap(t => t.clips.map(c => c.id))); };

  // ---------- keys ----------

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) {
      if (e.key === "Escape") { (target as HTMLElement).blur(); rootRef.current?.focus({ preventScroll: true }); }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const fps = timeline?.fps ?? 30;
    let handled = true;
    if (key === " ") engine.toggle();
    else if (mod && key === "z") { if (e.shiftKey) doc.redo(); else doc.undo(); }
    else if (mod && key === "y") doc.redo();
    else if (key === "b" && !e.altKey) commands.split();
    else if (mod && key === "d") commands.duplicate();
    else if (mod && key === "a") selectAll();
    else if (key === "backspace" || key === "delete") commands.remove(e.shiftKey);
    else if (!mod && (key === "j" || key === "k" || key === "l")) engine.shuttle(key);
    else if (key === "arrowleft") engine.stepFrames(e.shiftKey ? -Math.round(fps) : -1);
    else if (key === "arrowright") engine.stepFrames(e.shiftKey ? Math.round(fps) : 1);
    else if (key === "home") engine.seek(0);
    else if (key === "end") engine.seek(engine.duration);
    else if (!mod && key === "s") setSnapOn(!snapOn);
    else if (!mod && key === "t") commands.addText();
    else if (key === "escape") { setSelected([]); setExportOpen(false); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const focusRoot = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true], video[controls]")) return;
    if (document.activeElement !== rootRef.current) rootRef.current?.focus({ preventScroll: true });
  };

  // ---------- ask bos ----------

  const ask = async (text: string) => {
    const v = doc.current().video;
    if (!v || !text.trim()) return;
    await doc.flush();
    const clip = selected.length === 1 ? `, clip ${selected[0]}` : "";
    onAsk(`[video request ${v.id} at ${fmtTime(engine.currentTime)}${clip}] ${text.trim()}`, v.threadId ?? threadId);
  };

  // ---------- render ----------

  const lastRender: VideoRender | undefined = video?.renders.at(-1);
  const rendering = lastRender && (lastRender.status === "queued" || lastRender.status === "running");
  const startRender = async () => {
    try {
      await doc.flush();
      const res = await videoApi.render(botId, videoId);
      doc.upsertRender(res.render);
      setExportOpen(true);
    } catch (error) { doc.flash(`could not render: ${editMessage(error)}`); }
  };
  const cancelRender = async () => {
    if (!lastRender) return;
    try { const res = await videoApi.cancelRender(botId, videoId, lastRender.id); if (res.video) void doc.absorb(res.video, "human"); }
    catch (error) { doc.flash(editMessage(error)); }
  };

  // ---------- layout ----------

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = effectiveTimelineH;
    const max = Math.max(160, size.height - 200);
    const move = (ev: PointerEvent) => setTimelineH(Math.round(Math.min(max, Math.max(140, h0 - (ev.clientY - y0)))));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setTimelineH(h => { localStorage.setItem("bos.video.timeline", String(h)); return h; }); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (doc.loadError) return <Message>Could not open this video: {doc.loadError}. <button type="button" className="text-accent-text underline" onClick={onList}>All videos</button></Message>;
  if (doc.deleted) return <Message>This video was deleted. <button type="button" className="text-accent-text underline" onClick={onList}>All videos</button></Message>;
  if (!video || !timeline) return <Message><Loader2 size={14} className="mr-2 inline animate-spin" />Loading video…</Message>;

  const effectiveTimelineH = Math.round(Math.min(Math.max(140, timelineH || size.height * (compact ? 0.42 : 0.38)), Math.max(160, size.height - 200)));
  const empty = timeline.tracks.every(t => t.clips.length === 0);
  const media = video.media;

  const bin = <MediaBin media={media} botId={botId} videoId={videoId} uploads={uploads} onPick={() => pickFiles(null)} onDropFiles={files => upload(files)}
    onAppend={m => { appendMedia(m); if (!wide) setDrawer(null); }} onClose={wide ? undefined : () => setDrawer(null)} />;
  const inspector = <Inspector timeline={timeline} media={media} selected={selected} apply={doc.apply} onClose={wide ? undefined : () => setDrawer(null)} />;

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} onPointerDownCapture={focusRoot}
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app text-ink outline-none">
      <Header doc={doc} wide={wide} compact={compact} onList={onList} onRename={title => { doc.setTitle(title); onVideo(videoId, title.trim() || "Untitled video"); }}
        exportOpen={exportOpen} setExportOpen={setExportOpen} render={lastRender} rendering={!!rendering} onRender={startRender} onCancelRender={cancelRender}
        botId={botId} videoId={videoId} revision={video.revision} duration={timelineDuration(timeline)} timeline={timeline}
        drawer={drawer} setDrawer={setDrawer} onAsk={ask} />

      <div className="relative flex min-h-0 flex-1">
        {wide && <div className="w-[248px] shrink-0 border-r border-ink/[.07]">{bin}</div>}
        <div className="flex min-w-0 flex-1 flex-col">
          <Preview engine={engine} timeline={timeline} selected={selected} onSelect={setSelected} compact={compact}
            onTextMove={(id, x, y) => doc.apply([{ op: "update_clip", clip_id: id, style: { x, y } }])}
            empty={empty} onDropFiles={files => upload(files, "append")} onPickFiles={() => pickFiles("append")} />
          <Transport engine={engine} play={play} fps={timeline.fps} compact={compact} />
        </div>
        {wide && <div className="w-[288px] shrink-0 border-l border-ink/[.07]">{inspector}</div>}
        {!wide && drawer && (
          <>
            <div className="absolute inset-0 z-40 bg-black/30" onPointerDown={() => setDrawer(null)} />
            <div className={cn("absolute inset-y-0 z-50 w-[min(300px,86%)] shadow-[0_8px_28px_rgba(0,0,0,.4)] animate-panel-in", drawer === "bin" ? "left-0 border-r border-ink/10" : "right-0 border-l border-ink/10")}>
              {drawer === "bin" ? bin : inspector}
            </div>
          </>
        )}
      </div>

      <div className="group relative h-[5px] shrink-0 cursor-row-resize bg-ink/[.06] hover:bg-accent/50" onPointerDown={startResize} role="separator" aria-orientation="horizontal" aria-label="Resize timeline" />
      <div className="shrink-0" style={{ height: effectiveTimelineH }}>
        <Timeline timeline={timeline} media={media} botId={botId} videoId={videoId} engine={engine}
          selected={selected} setSelected={setSelected} apply={doc.apply} flash={text => doc.flash(text, "info")} pulse={doc.pulse}
          snapOn={snapOn} setSnapOn={setSnapOn} commands={commands} compact={compact}
          onDropFiles={(files, place) => upload(files, place)} />
      </div>

      {doc.notice && (
        <div role="status" className={cn("pointer-events-auto absolute bottom-4 left-1/2 z-[60] flex max-w-[min(520px,90%)] -translate-x-1/2 items-center gap-2 rounded-xl px-3.5 py-2 text-[12.5px] shadow-[0_8px_28px_rgba(0,0,0,.4)] animate-pop-in",
          doc.notice.tone === "error" ? "bg-danger text-[var(--color-danger-ink)]" : "bg-menu text-ink ring-1 ring-ink/10")} style={{ bottom: effectiveTimelineH + 16 }}>
          <span className="min-w-0 flex-1">{doc.notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={doc.clearNotice} className="shrink-0 opacity-70 hover:opacity-100"><X size={13} /></button>
        </div>
      )}

      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden
        onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) upload(files, pickPlace.current ?? undefined); }} />
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-1 items-center justify-center bg-panel p-6 text-center text-[13px] text-ink-secondary">{children}</div>;
}

// ---------- header ----------

function Header({ doc, wide, compact, onList, onRename, exportOpen, setExportOpen, render, rendering, onRender, onCancelRender, botId, videoId, revision, duration, timeline, drawer, setDrawer, onAsk }: {
  doc: VideoDoc; wide: boolean; compact: boolean; onList: () => void; onRename: (title: string) => void;
  exportOpen: boolean; setExportOpen: (open: boolean) => void; render: VideoRender | undefined; rendering: boolean; onRender: () => void; onCancelRender: () => void;
  botId: string; videoId: string; revision: number; duration: number; timeline: VideoTimeline;
  drawer: "bin" | "inspector" | null; setDrawer: (d: "bin" | "inspector" | null) => void; onAsk: (text: string) => void;
}) {
  const video = doc.video!;
  const [askText, setAskText] = useState("");
  const status = doc.saveState === "saving" ? "Saving…" : doc.saveState === "pending" ? "Edited" : doc.saveState === "error" ? "Not saved" : "Saved";
  const askBox = (
    <form className={cn("flex h-8 min-w-0 items-center gap-1 rounded-lg bg-ink/[.05] pl-2.5 pr-1 focus-within:bg-ink/[.07] focus-within:ring-1 focus-within:ring-ink/15", wide ? "w-[min(360px,32%)]" : "flex-1")}
      onSubmit={e => { e.preventDefault(); if (!askText.trim()) return; onAsk(askText); setAskText(""); }}>
      <input value={askText} onChange={e => setAskText(e.target.value)} placeholder="Ask bos to edit…" aria-label="Ask bos to edit this video"
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink/40" />
      <button type="submit" aria-label="Send to bos" disabled={!askText.trim()} onMouseDown={e => e.preventDefault()}
        className="flex size-6 shrink-0 items-center justify-center rounded-md bg-ink text-app transition-opacity disabled:opacity-25"><ArrowUp size={13} strokeWidth={2.25} /></button>
    </form>
  );
  return (
    <div className="shrink-0 border-b border-ink/[.07] bg-panel">
      <div className="flex h-11 items-center gap-1.5 px-2">
        <IconButton icon={ChevronLeft} label="All videos" onClick={onList} />
        <TitleInput title={video.title} onRename={onRename} />
        {!compact && (
          <span className="shrink-0 rounded-md bg-ink/[.06] px-1.5 py-0.5 text-[10.5px] tabular-nums text-ink-secondary" title={`${timeline.width}×${timeline.height} · ${timeline.fps}fps`}>
            {aspectName(timeline.width, timeline.height)} · {timeline.height >= timeline.width ? timeline.width : timeline.height}p
          </span>
        )}
        <span className={cn("shrink-0 text-[11px]", doc.saveState === "error" ? "text-danger" : "text-ink-secondary")}>{compact && doc.saveState === "saved" ? "" : status}</span>
        <div className="flex-1" />
        <IconButton icon={Undo2} label="Undo" shortcut="⌘Z" onClick={doc.undo} disabled={!doc.history.undo} />
        <IconButton icon={Redo2} label="Redo" shortcut="⇧⌘Z" onClick={doc.redo} disabled={!doc.history.redo} />
        {!wide && (
          <>
            <IconButton icon={FolderOpen} label="Media" active={drawer === "bin"} onClick={() => setDrawer(drawer === "bin" ? null : "bin")} />
            <IconButton icon={SlidersHorizontal} label="Inspector" active={drawer === "inspector"} onClick={() => setDrawer(drawer === "inspector" ? null : "inspector")} />
          </>
        )}
        {wide && askBox}
        <div className="relative">
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => setExportOpen(!exportOpen)}
            className={cn("relative flex h-8 items-center gap-1.5 overflow-hidden rounded-lg px-3 text-[12.5px] font-medium transition-colors",
              rendering ? "bg-ink/[.08] text-ink" : "bg-accent text-[var(--color-accent-ink)] hover:opacity-90")}>
            {rendering && <span className="absolute inset-y-0 left-0 bg-accent/35 transition-[width] duration-300" style={{ width: `${(render?.progress ?? 0) * 100}%` }} />}
            <span className="relative flex items-center gap-1.5">
              {rendering ? <><Loader2 size={13} className="animate-spin" />{Math.round((render?.progress ?? 0) * 100)}%</> : <><Download size={13} strokeWidth={2} />{compact ? "" : "Export"}</>}
            </span>
          </button>
          {exportOpen && <ExportPanel render={render} rendering={rendering} onRender={onRender} onCancel={onCancelRender} onClose={() => setExportOpen(false)}
            botId={botId} videoId={videoId} revision={revision} duration={duration} timeline={timeline} />}
        </div>
      </div>
      {!wide && <div className="flex px-2 pb-2">{askBox}</div>}
    </div>
  );
}

function TitleInput({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [value, setValue] = useState(title);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setValue(title); }, [title]);
  return (
    <input value={value} aria-label="Video title" maxLength={200} spellCheck={false}
      onFocus={e => { focused.current = true; e.target.select(); }}
      onChange={e => setValue(e.target.value)}
      onBlur={() => { focused.current = false; if (value.trim() !== title) onRename(value); }}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setValue(title); e.currentTarget.blur(); } }}
      className="h-8 min-w-[60px] max-w-[300px] flex-shrink rounded-md bg-transparent px-1.5 text-[13.5px] font-medium text-ink outline-none hover:bg-ink/[.05] focus:bg-ink/[.06]"
      style={{ width: `${Math.min(300, Math.max(60, value.length * 7.6 + 20))}px` }} />
  );
}

function ExportPanel({ render, rendering, onRender, onCancel, onClose, botId, videoId, revision, duration, timeline }: {
  render: VideoRender | undefined; rendering: boolean; onRender: () => void; onCancel: () => void; onClose: () => void;
  botId: string; videoId: string; revision: number; duration: number; timeline: VideoTimeline;
}) {
  const stale = render?.status === "done" && render.revision !== revision;
  const spec = `${timeline.width}×${timeline.height} · ${timeline.fps}fps · ${fmtTime(duration).replace(/\.\d+$/, "")} · MP4`;
  return (
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div data-popover className="absolute right-0 top-10 z-50 flex w-[300px] flex-col gap-3 rounded-xl bg-menu p-3 shadow-[0_12px_36px_rgba(0,0,0,.45)] ring-1 ring-ink/10 animate-pop-in">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-ink">Export</span>
          <span className="text-[11px] tabular-nums text-ink-secondary">{spec}</span>
        </div>
        {rendering && render && (
          <div className="flex flex-col gap-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-ink/10"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, render.progress * 100)}%` }} /></div>
            <div className="flex items-center justify-between text-[12px] text-ink-secondary">
              <span>{render.status === "queued" ? "Waiting to start…" : `Rendering · ${Math.round(render.progress * 100)}%`}</span>
              <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-ink/80 hover:bg-ink/[.08]">Cancel</button>
            </div>
          </div>
        )}
        {render?.status === "done" && (
          <div className="flex flex-col gap-2">
            <video controls playsInline src={videoApi.renderUrl(botId, videoId, render.id)} className="max-h-[240px] w-full rounded-lg bg-black" />
            <div className="flex items-center gap-2">
              <a href={videoApi.renderUrl(botId, videoId, render.id, true)} download
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent text-[12.5px] font-medium text-[var(--color-accent-ink)] hover:opacity-90">
                <Download size={13} strokeWidth={2} />Download{render.bytes ? ` · ${(render.bytes / 1024 / 1024).toFixed(1)} MB` : ""}
              </a>
            </div>
            {stale && <p className="text-[11.5px] text-ink-secondary">The timeline changed since this render.</p>}
          </div>
        )}
        {render?.status === "failed" && <p className="rounded-lg bg-danger/10 px-2.5 py-2 text-[12px] leading-snug text-danger">{render.error ?? "The render failed."}</p>}
        {render?.status === "cancelled" && <p className="text-[12px] text-ink-secondary">The last render was cancelled.</p>}
        {!rendering && (render?.status !== "done" || stale) && (
          <button type="button" onClick={onRender} disabled={duration <= 0}
            className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-ink/[.08] text-[12.5px] font-medium text-ink hover:bg-ink/[.12] disabled:opacity-40">
            {render ? "Render again" : "Render video"}
          </button>
        )}
        {duration <= 0 && <p className="text-[11.5px] text-ink-secondary">Add a clip first.</p>}
      </div>
    </>
  );
}

// ---------- transport ----------

function Transport({ engine, play, fps, compact }: { engine: PlaybackEngine; play: PlaybackState; fps: number; compact: boolean }) {
  const timeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => engine.onTick(t => { if (timeRef.current) timeRef.current.textContent = fmtTimecode(t, fps); }), [engine, fps]);
  const rate = play.rate;
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-t border-ink/[.07] bg-panel px-2">
      <span ref={timeRef} className="w-[68px] text-[12px] tabular-nums text-ink">{fmtTimecode(play.time, fps)}</span>
      {!compact && <span className="text-[12px] tabular-nums text-ink-secondary">/ {fmtTimecode(play.duration, fps)}</span>}
      <div className="flex flex-1 items-center justify-center gap-0.5">
        <IconButton icon={SkipBack} label="To start" shortcut="Home" onClick={() => engine.seek(0)} size={14} />
        <button type="button" aria-label={play.playing ? "Pause" : "Play"} title={play.playing ? "Pause (space)" : "Play (space)"} onMouseDown={e => e.preventDefault()}
          onClick={() => engine.toggle()} className="mx-1 flex size-8 items-center justify-center rounded-full bg-ink text-app transition-transform active:scale-95">
          {play.playing ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
        </button>
        <IconButton icon={SkipForward} label="To end" shortcut="End" onClick={() => engine.seek(engine.duration)} size={14} />
      </div>
      <span className={cn("w-10 text-right text-[11px] tabular-nums", rate !== 0 && rate !== 1 ? "text-accent-text" : "text-transparent")}>{rate !== 0 && rate !== 1 ? `${rate}×` : ""}</span>
      <IconButton icon={Repeat} label={play.loop ? "Loop on" : "Loop off"} active={play.loop} onClick={() => engine.setLoop(!play.loop)} size={14} />
    </div>
  );
}
