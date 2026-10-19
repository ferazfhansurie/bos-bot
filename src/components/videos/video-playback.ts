// The preview's playback engine. A requestAnimationFrame clock owns the
// playhead; media elements follow it. Only the clips under the playhead
// (plus the next one on each track) have elements, each kept within a frame
// or two of where the clock says it should be. React is told the time at a
// low rate; anything that moves every frame subscribes with onTick and
// writes to the DOM through a ref.
import { clipEnd, clipFit, clipSpeed, sourceTimeAt, timelineDuration, type VideoClip, type VideoTimeline, type VideoTrack } from "../../../shared/video";
import type { PlayableMedia } from "./video-api";
import { shuttle as nextShuttleRate } from "./timeline-math";

// ---------- pure helpers (tested) ----------

/** 0..1 gain from the clip's fades at timeline time t. */
export function fadeGain(clip: VideoClip, t: number): number {
  let g = 1;
  if (clip.fadeIn && clip.fadeIn > 0) g = Math.min(g, (t - clip.start) / clip.fadeIn);
  if (clip.fadeOut && clip.fadeOut > 0) g = Math.min(g, (clipEnd(clip) - t) / clip.fadeOut);
  return Math.max(0, Math.min(1, g));
}

/** Where the source should be at t, kept inside the clip and the file. */
export function expectedSourceTime(clip: VideoClip, media: PlayableMedia | undefined, t: number): number {
  const inPoint = clip.in ?? 0;
  let s = sourceTimeAt(clip, Math.min(Math.max(t, clip.start), clipEnd(clip)));
  s = Math.max(inPoint, s);
  if (media && media.duration > 0) s = Math.min(s, Math.max(0, media.duration - 0.02));
  return s;
}

/** Clips that should have a loaded element at t: everything under the
 * playhead, and on each track the next clip ahead (or behind, rewinding)
 * within `horizon` seconds so the cut lands on a decoded frame. */
export function wantedClips(timeline: VideoTimeline, t: number, horizon: number, direction: 1 | -1 = 1): Set<string> {
  const out = new Set<string>();
  for (const track of timeline.tracks) {
    if (track.kind === "text") continue;
    let nearest: VideoClip | null = null;
    for (const clip of track.clips) {
      if (!clip.mediaId) continue;
      if (t >= clip.start && t < clipEnd(clip)) { out.add(clip.id); continue; }
      const gap = direction > 0 ? clip.start - t : t - clipEnd(clip);
      if (gap >= 0 && gap <= horizon && (!nearest || gap < (direction > 0 ? nearest.start - t : t - clipEnd(nearest)))) nearest = clip;
    }
    if (nearest) out.add(nearest.id);
  }
  return out;
}

/** Whether an element has wandered far enough from the clock to reseek.
 * Faster playback earns more slack; seeking constantly is worse than a
 * small drift. */
export function needsResync(current: number, expected: number, rate = 1, tolerance = 0.08): boolean {
  return Math.abs(current - expected) > tolerance * Math.max(1, Math.abs(rate));
}

/** One frame (or n) from t, clamped to the timeline. */
export function stepTime(t: number, frames: number, fps: number, duration: number): number {
  const next = Math.round(t * fps + frames) / fps;
  return Math.min(Math.max(0, next), Math.max(0, duration));
}

/** Text clips showing at t, bottom track first, hidden tracks skipped. */
export function textClipsAt(timeline: VideoTimeline, t: number): { track: VideoTrack; clip: VideoClip; layer: number }[] {
  const out: { track: VideoTrack; clip: VideoClip; layer: number }[] = [];
  timeline.tracks.forEach((track, layer) => {
    if (track.kind !== "text" || track.hidden) return;
    for (const clip of track.clips) if (t >= clip.start && t < clipEnd(clip)) out.push({ track, clip, layer });
  });
  return out;
}

// ---------- engine ----------

type Layer = {
  clipId: string;
  mediaId: string;
  el: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  pendingSeek: number | null;
};

export interface PlaybackState { playing: boolean; rate: number; time: number; duration: number; loop: boolean }

const isMedia = (el: Layer["el"]): el is HTMLVideoElement | HTMLAudioElement => el instanceof HTMLMediaElement;

export class PlaybackEngine {
  private timeline: VideoTimeline;
  private media = new Map<string, PlayableMedia>();
  private url: (m: PlayableMedia) => string;
  private stage: HTMLElement | null = null;
  private audioHost: HTMLElement | null = null;
  private layers = new Map<string, Layer>();
  private texts = new Map<string, HTMLElement>();
  private time = 0;
  private rate = 0;
  private wall0 = 0;
  private time0 = 0;
  private stalledSince = 0;
  private raf = 0;
  private lastState = 0;
  private textKey = "";
  loop = false;
  private tickListeners = new Set<(t: number) => void>();
  private stateListeners = new Set<(s: PlaybackState) => void>();
  private textListeners = new Set<(ids: string[]) => void>();

  constructor(timeline: VideoTimeline, media: PlayableMedia[], url: (m: PlayableMedia) => string) {
    this.timeline = timeline;
    this.url = url;
    for (const m of media) this.media.set(m.id, m);
  }

  get currentTime() { return this.time; }
  get playing() { return this.rate !== 0; }
  get duration() { return timelineDuration(this.timeline); }
  get state(): PlaybackState { return { playing: this.rate !== 0, rate: this.rate, time: this.time, duration: this.duration, loop: this.loop }; }

  onTick(fn: (t: number) => void) { this.tickListeners.add(fn); fn(this.time); return () => { this.tickListeners.delete(fn); }; }
  onState(fn: (s: PlaybackState) => void) { this.stateListeners.add(fn); fn(this.state); return () => { this.stateListeners.delete(fn); }; }
  /** The text clips on screen, told only when the set changes. */
  onText(fn: (ids: string[]) => void) { this.textListeners.add(fn); fn(this.textKey ? this.textKey.split(",") : []); return () => { this.textListeners.delete(fn); }; }

  /** The visual stage (the preview frame) and a hidden host for audio. */
  attach(stage: HTMLElement | null, audioHost: HTMLElement | null) {
    if (this.stage === stage && this.audioHost === audioHost) return;
    this.dropAll();
    this.stage = stage;
    this.audioHost = audioHost;
    this.sync(true);
  }

  registerText(clipId: string, el: HTMLElement | null) {
    if (el) this.texts.set(clipId, el); else this.texts.delete(clipId);
    if (el) this.applyText();
  }

  setSource(timeline: VideoTimeline, media: PlayableMedia[]) {
    this.timeline = timeline;
    this.media = new Map(media.map(m => [m.id, m]));
    if (this.time > this.duration && this.rate === 0) this.time = Math.max(0, this.duration);
    this.sync(true);
    this.emitState(true);
  }

  play(rate = 1) {
    if (rate > 0 && this.time >= this.duration - 0.01) this.time = 0;
    if (rate < 0 && this.time <= 0) { this.rate = 0; this.emitState(true); return; }
    this.rate = rate;
    this.time0 = this.time;
    this.wall0 = performance.now();
    this.stalledSince = 0;
    this.sync(true);
    this.emitState(true);
    this.loopFrame();
  }

  pause() {
    if (this.rate === 0) return;
    this.rate = 0;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.sync(true);
    this.emitState(true);
  }

  toggle() { if (this.rate !== 0) this.pause(); else this.play(1); }

  /** J/K/L. Backwards rates step the clock and seek paused elements. */
  shuttle(key: "j" | "k" | "l") {
    const next = nextShuttleRate(this.rate, key);
    if (next === 0) this.pause(); else this.play(next);
  }

  /** Scrubbing and clicks: stops playback and jumps. Element seeks are
   * coalesced (one in flight per element, the latest target wins). */
  seek(t: number, keepPlaying = false) {
    const playing = keepPlaying && this.rate !== 0;
    if (!playing && this.rate !== 0) { this.rate = 0; cancelAnimationFrame(this.raf); this.raf = 0; }
    this.time = Math.min(Math.max(0, t), Math.max(0, this.duration));
    if (playing) { this.time0 = this.time; this.wall0 = performance.now(); }
    this.sync(true);
    this.emitTick();
    this.emitState(true);
  }

  stepFrames(frames: number) { this.seek(stepTime(this.time, frames, this.timeline.fps, this.duration)); }

  setLoop(loop: boolean) { this.loop = loop; this.emitState(true); }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.rate = 0;
    this.dropAll();
    this.tickListeners.clear();
    this.stateListeners.clear();
    this.textListeners.clear();
  }

  // ---------- internals ----------

  private loopFrame = () => {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  };

  private frame = (now: number) => {
    if (this.rate === 0) return;
    // hold the clock while a visible clip is still decoding its first frame,
    // so a cut never shows a frozen frame racing ahead of the playhead
    if (this.rate > 0 && this.waitingOnMedia()) {
      if (!this.stalledSince) this.stalledSince = now;
      if (now - this.stalledSince < 1500) { this.time0 = this.time; this.wall0 = now; this.loopFrame(); return; }
    } else this.stalledSince = 0;
    let t = this.time0 + ((now - this.wall0) / 1000) * this.rate;
    const end = this.duration;
    if (this.rate > 0 && t >= end) {
      if (this.loop && end > 0) { t = 0; this.time0 = 0; this.wall0 = now; }
      else { this.time = end; this.rate = 0; this.sync(true); this.emitTick(); this.emitState(true); return; }
    }
    if (this.rate < 0 && t <= 0) { this.time = 0; this.rate = 0; this.sync(true); this.emitTick(); this.emitState(true); return; }
    this.time = t;
    this.sync(false);
    this.emitTick();
    this.emitState(false);
    this.loopFrame();
  };

  private waitingOnMedia(): boolean {
    for (const layer of this.layers.values()) {
      const el = layer.el;
      if (!(el instanceof HTMLVideoElement) || el.style.visibility === "hidden") continue;
      if (el.readyState < 2) return true;
    }
    return false;
  }

  private emitTick() { for (const fn of this.tickListeners) fn(this.time); }

  private emitState(force: boolean) {
    const now = performance.now();
    if (!force && now - this.lastState < 250) return;
    this.lastState = now;
    const s = this.state;
    for (const fn of this.stateListeners) fn(s);
  }

  private makeLayer(clip: VideoClip, track: VideoTrack, m: PlayableMedia): Layer | null {
    const audioOnly = track.kind === "audio";
    let el: Layer["el"];
    if (audioOnly) {
      if (!this.audioHost) return null;
      el = document.createElement("audio");
      this.audioHost.append(el);
    } else {
      if (!this.stage) return null;
      el = m.kind === "image" ? document.createElement("img") : document.createElement("video");
      el.className = "video-layer";
      el.draggable = false;
      el.style.visibility = "hidden";
      this.stage.append(el);
    }
    const layer: Layer = { clipId: clip.id, mediaId: m.id, el, pendingSeek: null };
    if (isMedia(el)) {
      el.preload = "auto";
      if (el instanceof HTMLVideoElement) { el.playsInline = true; el.disablePictureInPicture = true; }
      const flush = () => {
        if (layer.pendingSeek === null) return;
        const target = layer.pendingSeek;
        layer.pendingSeek = null;
        this.seekLayer(layer, target);
      };
      el.addEventListener("seeked", flush);
      el.addEventListener("loadedmetadata", flush);
    }
    el.src = this.url(m);
    return layer;
  }

  private dropLayer(layer: Layer) {
    const el = layer.el;
    if (isMedia(el)) { el.pause(); el.removeAttribute("src"); el.load(); }
    el.remove();
    this.layers.delete(layer.clipId);
  }

  private dropAll() { for (const layer of [...this.layers.values()]) this.dropLayer(layer); }

  private seekLayer(layer: Layer, target: number) {
    const el = layer.el;
    if (!isMedia(el)) return;
    if (el.readyState === 0 || el.seeking) { layer.pendingSeek = target; return; }
    if (Math.abs(el.currentTime - target) < 0.5 / this.timeline.fps) return;
    el.currentTime = target;
  }

  /** Bring every element in line with the clock. `hard`: a seek or an edit,
   * so paused elements land exactly; otherwise only drift is corrected. */
  private sync(hard: boolean) {
    const t = this.time;
    const wanted = wantedClips(this.timeline, t, 2.5, this.rate < 0 ? -1 : 1);
    const where = new Map<string, { clip: VideoClip; track: VideoTrack; layer: number }>();
    this.timeline.tracks.forEach((track, layer) => { for (const clip of track.clips) if (wanted.has(clip.id)) where.set(clip.id, { clip, track, layer }); });
    for (const layer of [...this.layers.values()]) {
      const w = where.get(layer.clipId);
      const kindChanged = w && ((w.track.kind === "audio") !== (layer.el instanceof HTMLAudioElement));
      if (!w || w.clip.mediaId !== layer.mediaId || kindChanged) this.dropLayer(layer);
    }
    for (const [clipId, { clip, track, layer: z }] of where) {
      const m = clip.mediaId ? this.media.get(clip.mediaId) : undefined;
      if (!m) continue;
      let layer = this.layers.get(clipId);
      if (!layer) {
        const made = this.makeLayer(clip, track, m);
        if (!made) continue;
        layer = made;
        this.layers.set(clipId, layer);
      }
      const active = t >= clip.start && t < clipEnd(clip);
      const gain = active ? fadeGain(clip, t) : 0;
      const el = layer.el;
      if (!(el instanceof HTMLAudioElement)) {
        const show = active && !track.hidden;
        el.style.visibility = show ? "visible" : "hidden";
        el.style.opacity = String(show ? gain : 0);
        el.style.zIndex = String(z + 1);
        el.style.objectFit = clipFit(clip);
      }
      if (!isMedia(el)) continue;
      const expected = expectedSourceTime(clip, m, active ? t : (this.rate < 0 ? clipEnd(clip) : clip.start));
      const speed = clipSpeed(clip);
      el.muted = Boolean(track.muted || track.hidden);
      el.volume = Math.max(0, Math.min(1, (clip.volume ?? 1) * gain));
      if (active && this.rate > 0) {
        const rate = Math.min(16, Math.max(0.0625, speed * this.rate));
        if (el.playbackRate !== rate) el.playbackRate = rate;
        if (el.paused) { this.seekLayer(layer, expected); void el.play().catch(() => undefined); }
        else if (!el.seeking && needsResync(el.currentTime, expected, speed * this.rate)) el.currentTime = expected;
      } else {
        if (!el.paused) el.pause();
        // paused, scrubbing or rewinding: land on the frame the clock shows
        if (hard || active) this.seekLayer(layer, expected);
      }
    }
    this.applyText();
  }

  private applyText() {
    const t = this.time;
    const showing = textClipsAt(this.timeline, t);
    const key = showing.map(s => s.clip.id).join(",");
    if (key !== this.textKey) {
      this.textKey = key;
      const ids = key ? key.split(",") : [];
      for (const fn of this.textListeners) fn(ids);
    }
    for (const s of showing) {
      const el = this.texts.get(s.clip.id);
      if (el) el.style.opacity = String(fadeGain(s.clip, t));
    }
  }
}
