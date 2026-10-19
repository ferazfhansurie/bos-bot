// The working copy of one video: the timeline being edited, undo/redo, a
// serialized debounced save, and folding in what bos (or another window)
// changed. Every edit goes through applyVideoEdits, the same function the
// bot's tools use, so the editor can never write a timeline the server
// would refuse for shape reasons.
import { useCallback, useEffect, useRef, useState } from "react";
import { applyVideoEdits, validateTimeline, type VideoEditOp, type VideoRecord, type VideoRender, type VideoTimeline } from "../../../shared/video";
import { videoApi, VideoApiError, VIDEO_CHANGED_EVENT, type VideoChangedDetail } from "./video-api";
import { changedClipIds, mergeTimelines } from "./timeline-math";

export type SaveState = "saved" | "pending" | "saving" | "error";
export interface Notice { text: string; tone: "error" | "info"; at: number }
export interface Pulse { ids: Set<string>; at: number }

const SAVE_DELAY = 600;
const HISTORY = 200;

/** "edit 2 (move_clip): track 1: clips … overlap" reads as the last part. */
export function editMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^edit \d+ \([a-z_]+\): /, "").replace(/^track \d+(?: clip \d+)?:? /, "");
}

const sameTimeline = (a: VideoTimeline, b: VideoTimeline) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function useVideoDoc(botId: string, videoId: string | undefined) {
  const [video, setVideoState] = useState<VideoRecord | null>(null);
  const [timeline, setTimelineState] = useState<VideoTimeline | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });

  const idRef = useRef(videoId);
  const videoRef = useRef<VideoRecord | null>(null);
  const timelineRef = useRef<VideoTimeline | null>(null);
  /** The server's timeline at the last sync: the merge base. */
  const baseRef = useRef<VideoTimeline | null>(null);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const titleRef = useRef<string | null>(null);
  const past = useRef<VideoTimeline[]>([]);
  const future = useRef<VideoTimeline[]>([]);
  const coalesceRef = useRef<{ key: string; at: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const setVideo = (v: VideoRecord | null) => { videoRef.current = v; setVideoState(v); };
  const setTimeline = (t: VideoTimeline | null) => { timelineRef.current = t; setTimelineState(t); };
  const syncHistory = () => setHistory({ undo: past.current.length, redo: future.current.length });
  const flash = useCallback((text: string, tone: Notice["tone"] = "error") => setNotice({ text, tone, at: Date.now() }), []);

  // ---------- saving ----------

  const saveNow = useCallback(async () => {
    const v = videoRef.current;
    const id = idRef.current;
    if (!v || v.id !== id || (!dirtyRef.current && titleRef.current === null)) return;
    const sending = timelineRef.current!;
    const sendTimeline = dirtyRef.current;
    const title = titleRef.current;
    dirtyRef.current = false;
    titleRef.current = null;
    setSaveState("saving");
    try {
      const saved = await videoApi.save(botId, v.id, { baseRevision: revisionRef.current, ...(sendTimeline ? { timeline: sending } : {}), ...(title !== null ? { title } : {}) });
      if (idRef.current !== saved.id) return;
      revisionRef.current = saved.revision;
      baseRef.current = saved.timeline;
      // keep the local object when nothing changed meanwhile: the server's
      // copy is the same document, maybe re-sorted
      setVideo({ ...saved, title: titleRef.current ?? saved.title });
      setSaveState(dirtyRef.current || titleRef.current !== null ? "pending" : "saved");
    } catch (error) {
      if (idRef.current !== id) return;
      if (sendTimeline) dirtyRef.current = true;
      if (title !== null && titleRef.current === null) titleRef.current = title;
      if (error instanceof VideoApiError && error.status === 409 && error.video) {
        absorb(error.video, "conflict");
        if (dirtyRef.current || titleRef.current !== null) { setSaveState("pending"); timer.current = setTimeout(flush, 50); }
        return;
      }
      setSaveState("error");
      flash(`not saved: ${editMessage(error)}`);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 4000);
    }
  }, [botId, flash]);

  function flush(): Promise<void> {
    clearTimeout(timer.current);
    chain.current = chain.current.then(saveNow, saveNow);
    return chain.current;
  }

  function schedule() {
    setSaveState("pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY);
  }

  // ---------- folding in the server's copy ----------

  /** Takes a newer server record: merges the person's unsaved changes over
   * it, pulses clips someone else changed and keeps the pre-change timeline
   * on the undo stack so cmd+Z reverts what bos did. */
  function absorb(server: VideoRecord, by: "human" | "bot" | "conflict") {
    if (server.id !== idRef.current) return;
    if (server.revision < revisionRef.current) return;
    const base = baseRef.current ?? server.timeline;
    const mine = timelineRef.current ?? server.timeline;
    const theirs = server.timeline;
    let next = theirs;
    if (dirtyRef.current) {
      try { next = validateTimeline(mergeTimelines(base, mine, theirs), server.media); }
      catch {
        next = theirs;
        dirtyRef.current = false;
        flash("bos changed the same spot; kept bos's version (cmd+Z brings yours back)", "info");
      }
    }
    const changed = changedClipIds(base, theirs);
    revisionRef.current = server.revision;
    baseRef.current = theirs;
    setVideo({ ...server, title: titleRef.current ?? server.title });
    if (!sameTimeline(mine, next)) {
      if (by !== "human") {
        past.current.push(mine);
        if (past.current.length > HISTORY) past.current.shift();
        future.current = [];
        coalesceRef.current = null;
        syncHistory();
      }
      setTimeline(next);
    }
    if (changed.length && by !== "human") setPulse({ ids: new Set(changed), at: Date.now() });
    if (dirtyRef.current) schedule();
    else if (titleRef.current === null) setSaveState("saved");
  }

  /** Runs after any save in flight, so a refresh never races a PUT. */
  const absorbQueued = useCallback((server: VideoRecord, by: "human" | "bot" | "conflict") => {
    chain.current = chain.current.then(() => absorb(server, by), () => absorb(server, by));
    return chain.current;
  }, []);

  // ---------- load ----------

  useEffect(() => {
    idRef.current = videoId;
    clearTimeout(timer.current);
    past.current = []; future.current = []; coalesceRef.current = null;
    dirtyRef.current = false; titleRef.current = null;
    baseRef.current = null; revisionRef.current = 0;
    setVideo(null); setTimeline(null); setLoadError(null); setDeleted(false); setPulse(null); setSaveState("saved"); syncHistory();
    if (!videoId) return;
    let live = true;
    videoApi.get(botId, videoId).then(v => {
      if (!live) return;
      revisionRef.current = v.revision;
      baseRef.current = v.timeline;
      setVideo(v);
      setTimeline(v.timeline);
    }, error => { if (live) setLoadError(editMessage(error)); });
    return () => { live = false; };
  }, [botId, videoId]);

  // save before the tab goes away or the page unloads
  useEffect(() => {
    const leave = () => { if (dirtyRef.current || titleRef.current !== null) void flush(); };
    window.addEventListener("beforeunload", leave);
    return () => { window.removeEventListener("beforeunload", leave); leave(); };
  }, [botId, videoId]);

  // ---------- live updates from the server ----------

  useEffect(() => {
    const onChange = (event: Event) => {
      const d = (event as CustomEvent<VideoChangedDetail>).detail;
      if (!d || d.botId !== botId || d.videoId !== idRef.current) return;
      if (d.deleted) { setDeleted(true); return; }
      if (d.render) upsertRender(d.render);
      if (d.revision <= revisionRef.current) return;
      chain.current = chain.current.catch(() => undefined).then(async () => {
        if (d.revision <= revisionRef.current || d.videoId !== idRef.current) return;
        const fresh = await videoApi.get(botId, d.videoId).catch(() => null);
        if (fresh) absorb(fresh, d.byKind);
      });
    };
    window.addEventListener(VIDEO_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(VIDEO_CHANGED_EVENT, onChange);
  }, [botId]);

  // Render progress normally arrives as server frames; poll too, so a dropped
  // socket (a phone on a slow line) never leaves the export stuck at 0%.
  const activeRender = video?.renders.find(r => r.status === "queued" || r.status === "running")?.id;
  useEffect(() => {
    const id = idRef.current;
    if (!activeRender || !id) return;
    const timer = window.setInterval(() => {
      videoApi.renderStatus(botId, id, activeRender).then(render => { if (idRef.current === id) upsertRender(render); }, () => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [botId, activeRender]);

  function upsertRender(render: VideoRender) {
    const v = videoRef.current;
    if (!v) return;
    const renders = v.renders.some(r => r.id === render.id) ? v.renders.map(r => (r.id === render.id ? render : r)) : [...v.renders, render];
    setVideo({ ...v, renders });
  }

  // ---------- editing ----------

  /** Applies ops as one undo step. `coalesce` folds a burst of edits with
   * the same key (a slider drag, typing) into the step before it. Returns
   * the ids the ops created, or null when the edit was refused. */
  const apply = useCallback((ops: VideoEditOp[], options: { coalesce?: string; quiet?: boolean } = {}): string[] | null => {
    const current = timelineRef.current, v = videoRef.current;
    if (!current || !v || !ops.length) return null;
    let result: { timeline: VideoTimeline; created: string[] };
    try { result = applyVideoEdits(current, v.media, ops); }
    catch (error) { if (!options.quiet) flash(editMessage(error)); return null; }
    const now = Date.now();
    const last = coalesceRef.current;
    const fold = options.coalesce && last && last.key === options.coalesce && now - last.at < 2000;
    if (!fold) {
      past.current.push(current);
      if (past.current.length > HISTORY) past.current.shift();
    }
    coalesceRef.current = options.coalesce ? { key: options.coalesce, at: now } : null;
    future.current = [];
    dirtyRef.current = true;
    setTimeline(result.timeline);
    syncHistory();
    schedule();
    return result.created;
  }, [flash]);

  const undo = useCallback(() => {
    const current = timelineRef.current;
    const prev = past.current.pop();
    if (!current || !prev) return;
    future.current.push(current);
    coalesceRef.current = null;
    dirtyRef.current = true;
    setTimeline(prev);
    syncHistory();
    schedule();
  }, []);

  const redo = useCallback(() => {
    const current = timelineRef.current;
    const next = future.current.pop();
    if (!current || !next) return;
    past.current.push(current);
    coalesceRef.current = null;
    dirtyRef.current = true;
    setTimeline(next);
    syncHistory();
    schedule();
  }, []);

  const setTitle = useCallback((title: string) => {
    const v = videoRef.current;
    const clean = title.trim() || "Untitled video";
    if (!v || clean === v.title) return;
    titleRef.current = clean;
    setVideo({ ...v, title: clean });
    schedule();
  }, []);

  return {
    video, timeline, loadError, deleted, saveState, history, notice, pulse,
    apply, undo, redo, setTitle, flash, absorb: absorbQueued, upsertRender,
    /** Saves now (before asking bos, rendering or leaving). */
    flush: useCallback(() => flush(), []),
    clearNotice: useCallback(() => setNotice(null), []),
    current: () => ({ video: videoRef.current, timeline: timelineRef.current }),
  };
}

export type VideoDoc = ReturnType<typeof useVideoDoc>;
