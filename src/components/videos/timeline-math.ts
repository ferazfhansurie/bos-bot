// Pure timeline geometry for the editor: snapping, free spots, trimming,
// ruler steps, filmstrip tiles and the three-way merge used when bos and the
// person edit the same timeline at once. No DOM, so it is unit tested.
import { clipEnd, clipSpeed, type VideoClip, type VideoMedia, type VideoTimeline, type VideoTrack, type VideoTrackKind } from "../../../shared/video";

export const EPS = 0.001;

/** mm:ss.ff, ff being the frame inside the second. */
export function fmtTimecode(t: number, fps: number): string {
  const sign = t < 0 ? "-" : "";
  const frames = Math.round(Math.abs(t) * fps);
  const f = Math.max(1, Math.round(fps));
  const totalSec = Math.floor(frames / f);
  const ff = frames - totalSec * f;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${sign}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}

export const snapToFrame = (t: number, fps: number) => Math.round(t * fps) / fps;
export const minClipLength = (fps: number) => Math.max(0.04, 1 / fps);

/** Top to bottom on screen: overlays (higher index first), then the base
 * video track, then audio tracks in order. tracks[0] stays the lowest
 * visual layer, as the renderer draws it. */
export function displayOrder(tracks: VideoTrack[]): VideoTrack[] {
  const visual = tracks.filter(t => t.kind !== "audio").reverse();
  const audio = tracks.filter(t => t.kind === "audio");
  return [...visual, ...audio];
}

export type ClipNature = "text" | VideoMedia["kind"];
export function clipNature(clip: VideoClip, media: VideoMedia[]): ClipNature {
  if (clip.text !== undefined || !clip.mediaId) return "text";
  return media.find(m => m.id === clip.mediaId)?.kind ?? "video";
}
/** Which tracks a clip (or a media file being dropped) may sit on. */
export function fitsTrack(kind: VideoTrackKind, nature: ClipNature): boolean {
  if (kind === "text") return nature === "text";
  if (kind === "video") return nature === "video" || nature === "image";
  return nature === "audio" || nature === "video";
}

export function overlaps(clips: VideoClip[], start: number, duration: number, exclude: ReadonlySet<string> = new Set()): boolean {
  const end = start + duration;
  return clips.some(c => !exclude.has(c.id) && start < clipEnd(c) - EPS && end > c.start + EPS);
}

/** The start nearest `start` where a clip of `duration` fits on the track
 * without overlapping, or null when nothing fits within `maxShift`. */
export function freeStart(clips: VideoClip[], start: number, duration: number, exclude: ReadonlySet<string> = new Set(), maxShift = Infinity): number | null {
  start = Math.max(0, start);
  if (!overlaps(clips, start, duration, exclude)) return start;
  const others = clips.filter(c => !exclude.has(c.id));
  const candidates = [0, ...others.map(clipEnd), ...others.map(c => c.start - duration)].filter(c => c >= 0);
  let best: number | null = null;
  for (const c of candidates) {
    if (Math.abs(c - start) > maxShift || overlaps(clips, c, duration, exclude)) continue;
    if (best === null || Math.abs(c - start) < Math.abs(best - start)) best = c;
  }
  return best;
}

/** Edges a moving time may stick to. */
export function snapPoints(timeline: VideoTimeline, exclude: ReadonlySet<string>, playhead: number): number[] {
  const points = [0, playhead];
  for (const track of timeline.tracks) for (const c of track.clips) if (!exclude.has(c.id)) points.push(c.start, clipEnd(c));
  return points;
}

/** Snaps whichever of `edges` (offsets from t) lands closest to a point within threshold. */
export function snap(t: number, points: number[], threshold: number, edges: number[] = [0]): { t: number; at: number | null } {
  let best: { delta: number; at: number } | null = null;
  for (const edge of edges) {
    for (const p of points) {
      const delta = p - (t + edge);
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: p };
    }
  }
  return best ? { t: t + best.delta, at: best.at } : { t, at: null };
}

/** Neighbouring edges on the clip's own track, which a trim may not cross. */
export function neighbours(track: VideoTrack, clipId: string): { prevEnd: number; nextStart: number } {
  const self = track.clips.find(c => c.id === clipId);
  let prevEnd = 0, nextStart = Infinity;
  if (!self) return { prevEnd, nextStart };
  for (const c of track.clips) {
    if (c.id === clipId) continue;
    if (clipEnd(c) <= self.start + EPS) prevEnd = Math.max(prevEnd, clipEnd(c));
    else if (c.start >= clipEnd(self) - EPS) nextStart = Math.min(nextStart, c.start);
  }
  return { prevEnd, nextStart };
}

/** A trimmed clip's new start/duration/in when one edge moves to time `to`.
 * The left edge moves the source in-point with it; neither edge may run
 * past the source file, a neighbour, or below the minimum length. */
export function trimClip(clip: VideoClip, media: VideoMedia | undefined, edge: "left" | "right", to: number,
  bounds: { prevEnd: number; nextStart: number }, minLength: number): { start: number; duration: number; in?: number } {
  const speed = clipSpeed(clip);
  const end = clipEnd(clip);
  const inPoint = clip.in ?? 0;
  const timed = media && media.kind !== "image" && media.duration > 0;
  if (edge === "left") {
    let start = Math.min(to, end - minLength);
    start = Math.max(start, bounds.prevEnd, 0);
    if (clip.mediaId) {
      // the in-point cannot go below 0: the furthest left is where in hits 0
      start = Math.max(start, clip.start - inPoint / speed);
      const nextIn = inPoint + (start - clip.start) * speed;
      return { start, duration: end - start, in: Math.max(0, nextIn) };
    }
    return { start, duration: end - start };
  }
  let nextEnd = Math.max(to, clip.start + minLength);
  nextEnd = Math.min(nextEnd, bounds.nextStart);
  if (timed) nextEnd = Math.min(nextEnd, clip.start + (media!.duration - inPoint) / speed);
  return { start: clip.start, duration: Math.max(minLength, nextEnd - clip.start), ...(clip.mediaId ? { in: inPoint } : {}) };
}

/** Ruler steps for a zoom (px per second): labelled major ticks at least
 * ~72px apart and minor ticks between. */
export function rulerSteps(pxPerSec: number, fps = 30): { major: number; minor: number } {
  const frame = 1 / fps;
  const steps = [frame, frame * 2, frame * 5, frame * 10, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  const major = steps.find(s => s * pxPerSec >= 72) ?? 3600;
  if (major < 1) return { major, minor: major / Math.min(5, Math.max(1, Math.round(major * fps))) };
  const parts: Record<number, number> = { 1: 5, 2: 4, 5: 5, 10: 5, 15: 3, 30: 6, 60: 6, 120: 4, 300: 5, 600: 5, 1200: 4, 1800: 6, 3600: 6 };
  return { major, minor: major / (parts[major] ?? 5) };
}

/** A ruler label: seconds at coarse zoom, frames once ticks fall inside a second. */
export function rulerLabel(t: number, major: number, fps: number): string {
  const m = Math.floor(t / 60 + EPS);
  const s = Math.floor(t - m * 60 + EPS);
  if (major < 1) {
    const f = Math.round((t - Math.floor(t + EPS)) * fps);
    if (f > 0 && f < fps) return `${f}f`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const ZOOM_MIN = 2;
export const ZOOM_MAX = 600;
export const clampZoom = (pps: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pps));
/** Zoom that shows the whole timeline (or 10s for an empty one) in `width` px. */
export function fitZoom(duration: number, width: number): number {
  return clampZoom((Math.max(1, width) - 24) / Math.max(duration, 10) * 0.96);
}
/** Slider position 0..1 <-> px per second, logarithmic so both ends are usable. */
export const zoomToSlider = (pps: number) => Math.log(clampZoom(pps) / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN);
export const sliderToZoom = (v: number) => clampZoom(ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, Math.min(1, Math.max(0, v))));

/** Filmstrip tiles across a clip: each slot's x (px from the clip's left)
 * and the sprite tile showing the source frame at that slot's middle. */
export function filmstripSlots(clip: VideoClip, thumbs: { every: number; count: number }, pxPerSec: number, slotWidth: number,
  window: { from: number; to: number } = { from: 0, to: Infinity }): { x: number; index: number }[] {
  const width = clip.duration * pxPerSec;
  const out: { x: number; index: number }[] = [];
  if (thumbs.count <= 0 || slotWidth <= 0) return out;
  const first = Math.max(0, Math.floor(window.from / slotWidth));
  const last = Math.min(Math.ceil(width / slotWidth), Math.ceil(window.to / slotWidth), first + 400);
  for (let i = first; i < last; i++) {
    const x = i * slotWidth;
    const mid = Math.min(width, x + slotWidth / 2) / pxPerSec;
    const source = (clip.in ?? 0) + mid * clipSpeed(clip);
    out.push({ x, index: thumbs.every > 0 ? Math.min(thumbs.count - 1, Math.max(0, Math.floor(source / thumbs.every))) : 0 });
  }
  return out;
}

/** Waveform peaks for a clip's visible span, resampled to `columns` bars. */
export function peaksForClip(peaks: number[], perSecond: number, clip: VideoClip, columns: number): number[] {
  const out: number[] = Array.from({ length: Math.max(0, columns) }, () => 0);
  if (!peaks.length || columns <= 0) return out;
  const speed = clipSpeed(clip);
  const from = (clip.in ?? 0) * perSecond;
  const span = clip.duration * speed * perSecond;
  for (let i = 0; i < columns; i++) {
    const a = Math.floor(from + (i / columns) * span);
    const b = Math.max(a + 1, Math.floor(from + ((i + 1) / columns) * span));
    let max = 0;
    for (let j = a; j < b && j < peaks.length; j++) max = Math.max(max, peaks[j] ?? 0);
    out[i] = max;
  }
  return out;
}

/** J/K/L shuttle: L speeds forward 1x→2x→4x, J backward the same, K stops. */
export function shuttle(rate: number, key: "j" | "k" | "l"): number {
  if (key === "k") return 0;
  if (key === "l") return rate <= 0 ? 1 : Math.min(4, rate * 2);
  return rate >= 0 ? -1 : Math.max(-4, rate * 2);
}

// ---------- collaboration ----------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Located = { trackId: string; clip: VideoClip };
function locate(timeline: VideoTimeline): Map<string, Located> {
  const map = new Map<string, Located>();
  for (const track of timeline.tracks) for (const clip of track.clips) map.set(clip.id, { trackId: track.id, clip });
  return map;
}

/** Clips that differ between two timelines (added, moved, restyled). */
export function changedClipIds(before: VideoTimeline, after: VideoTimeline): string[] {
  const old = locate(before);
  const out: string[] = [];
  for (const [id, now] of locate(after)) { const was = old.get(id); if (!was || !same(was, now)) out.push(id); }
  return out;
}

/** Three-way merge at clip level: the person's changes since `base` laid
 * over the server's copy. Where both changed the same clip, the server
 * (usually bos) wins. The caller validates; an overlap means fall back. */
export function mergeTimelines(base: VideoTimeline, mine: VideoTimeline, theirs: VideoTimeline): VideoTimeline {
  const out: VideoTimeline = JSON.parse(JSON.stringify(theirs));
  for (const key of ["width", "height", "fps", "background"] as const) {
    if (mine[key] !== base[key]) (out as unknown as Record<string, unknown>)[key] = mine[key];
  }
  const baseTracks = new Map(base.tracks.map(t => [t.id, t]));
  const mineTracks = new Map(mine.tracks.map(t => [t.id, t]));
  mine.tracks.forEach((t, i) => {
    if (!baseTracks.has(t.id) && !out.tracks.some(x => x.id === t.id)) out.tracks.splice(Math.min(i, out.tracks.length), 0, { ...t, clips: [] });
  });
  out.tracks = out.tracks.filter(t => {
    const b = baseTracks.get(t.id);
    if (!b || mineTracks.has(t.id)) return true;
    return !same(b.clips, t.clips); // deleted here; keep it only if they changed it
  });
  for (const t of out.tracks) {
    const b = baseTracks.get(t.id), m = mineTracks.get(t.id);
    if (!b || !m) continue;
    for (const key of ["name", "muted", "hidden"] as const) {
      if (m[key] !== b[key]) { if (m[key] === undefined) delete t[key]; else (t as unknown as Record<string, unknown>)[key] = m[key]; }
    }
  }
  const B = locate(base), M = locate(mine);
  const T = locate(out);
  const trackOf = (id: string) => out.tracks.find(t => t.id === id);
  const remove = (id: string) => { const at = T.get(id); if (!at) return; const tr = trackOf(at.trackId); if (tr) tr.clips = tr.clips.filter(c => c.id !== id); T.delete(id); };
  const put = (loc: Located) => { const tr = trackOf(loc.trackId); if (!tr) return false; tr.clips.push(JSON.parse(JSON.stringify(loc.clip))); T.set(loc.clip.id, loc); return true; };
  for (const [id, m] of M) {
    const b = B.get(id);
    if (!b) { if (!T.has(id)) put(m); continue; }
    if (same(m, b)) continue;
    const t = T.get(id);
    if (!t || !same(t, b)) continue; // they deleted or changed it too: theirs wins
    remove(id);
    if (!put(m)) put(t);
  }
  for (const [id, b] of B) {
    if (M.has(id)) continue;
    const t = T.get(id);
    if (t && same(t, b)) remove(id);
  }
  for (const t of out.tracks) t.clips.sort((a, b) => a.start - b.start);
  return out;
}
