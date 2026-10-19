// Videos: an editing timeline a bot and its person cut together, the video
// counterpart of pages. The stored model is plain JSON (media bin + tracks
// of clips, every id stable) so the editor, the bot's video tools and the
// ffmpeg renderer all read the same document. Times are seconds (floats);
// the renderer snaps them to frames.

export const VIDEO_LIMITS = {
  videosPerBot: 300,
  media: 200,
  tracks: 12,
  clipsPerTrack: 500,
  textChars: 500,
  titleChars: 200,
  projectJsonBytes: 1_500_000,
  versions: 50,
  /** Longest timeline the renderer accepts, in seconds. */
  maxDuration: 3 * 60 * 60,
  /** One uploaded media file. */
  mediaBytes: 8 * 1024 ** 3,
} as const;

export const VIDEO_ID_RE = /^v-[a-z0-9]{8,24}$/;
export const MEDIA_ID_RE = /^m-[a-z0-9]{6,24}$/;
export const TRACK_ID_RE = /^t-[a-z0-9]{4,24}$/;
export const CLIP_ID_RE = /^c-[a-z0-9]{4,24}$/;

export type VideoMediaKind = "video" | "audio" | "image";
export type VideoTrackKind = "video" | "audio" | "text";
export type VideoAuthor = { kind: "human" | "bot"; id: string; name: string };

export interface VideoMedia {
  id: string;
  /** Original file name, for display. */
  name: string;
  kind: VideoMediaKind;
  /** File name inside the project's media folder (served by the routes). */
  file: string;
  /** Seconds; images get 0 (a clip sets their length). */
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  bytes: number;
  addedAt: number;
  addedBy: VideoAuthor;
  /** Server-made filmstrip sprite (one frame per `thumbEvery` seconds, 160px wide) and waveform peaks. */
  thumbs?: { file: string; every: number; count: number; width: number; height: number };
  peaks?: { file: string; perSecond: number };
  /** Browser-playable stand-in (h264/aac mp4, aac m4a or jpg) the server makes
   * when the source codec or container will not play in the editor. The
   * renderer always reads the original. */
  proxy?: string;
}

export interface VideoTextStyle {
  /** Font size as a fraction of frame height (0.06 ≈ a subtitle). */
  size?: number;
  color?: string;
  /** Box colour behind the text, "" for none. */
  background?: string;
  weight?: 400 | 600 | 800;
  /** Centre position as fractions of the frame, 0..1. */
  x?: number;
  y?: number;
  align?: "left" | "center" | "right";
}

/** What the renderer uses when a text clip leaves a style field out; the
 * editor preview should draw with the same values. */
export const TEXT_STYLE_DEFAULTS: Required<VideoTextStyle> = {
  size: 0.06, color: "#ffffff", background: "", weight: 600, x: 0.5, y: 0.85, align: "center",
};

export interface VideoClip {
  id: string;
  /** Where the clip sits on the timeline. */
  start: number;
  /** Length on the timeline (after speed). */
  duration: number;
  /** Media clips: which file, and the source time the clip starts from. */
  mediaId?: string;
  in?: number;
  /** Playback rate, 0.25..4. Source span = duration * speed. */
  speed?: number;
  /** 0..2, 1 = unchanged. */
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Text clips. */
  text?: string;
  style?: VideoTextStyle;
  /** Video/image framing inside the output frame. */
  fit?: "cover" | "contain";
  /** Optional note the bot or person left on the clip. */
  label?: string;
}

export interface VideoTrack {
  id: string;
  kind: VideoTrackKind;
  name?: string;
  muted?: boolean;
  hidden?: boolean;
  clips: VideoClip[];
}

export interface VideoTimeline {
  width: number;
  height: number;
  fps: number;
  /** Frame colour where no clip covers it. */
  background: string;
  /** Drawn bottom to top: tracks[0] is the base layer. */
  tracks: VideoTrack[];
}

export interface VideoRender {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** 0..1 */
  progress: number;
  revision: number;
  startedAt: number;
  finishedAt?: number;
  /** File name in the project's renders folder. */
  file?: string;
  bytes?: number;
  error?: string;
}

export interface VideoVersion {
  id: string;
  revision: number;
  at: number;
  by: VideoAuthor;
  timeline: VideoTimeline;
}

export interface VideoRecord {
  id: string;
  title: string;
  /** Conversation the bot tools for this video belong to. */
  threadId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: VideoAuthor;
  updatedBy: VideoAuthor;
  media: VideoMedia[];
  timeline: VideoTimeline;
  renders: VideoRender[];
  versions: VideoVersion[];
  trashedAt?: number;
}

export interface VideoSummary {
  id: string;
  title: string;
  threadId?: string;
  revision: number;
  updatedAt: number;
  duration: number;
  width: number;
  height: number;
  clipCount: number;
  lastRender?: VideoRender;
  trashedAt?: number;
}

export const VIDEO_SIZES = {
  "landscape": { width: 1920, height: 1080 },
  "portrait": { width: 1080, height: 1920 },
  "square": { width: 1080, height: 1080 },
  "feed": { width: 1080, height: 1350 },
} as const;
export type VideoSizePreset = keyof typeof VIDEO_SIZES;

const rand = (n: number) => {
  let out = "";
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) out += chars[b % chars.length];
  return out;
};
export const newVideoId = () => `v-${rand(12)}`;
export const newMediaId = () => `m-${rand(10)}`;
export const newTrackId = () => `t-${rand(8)}`;
export const newClipId = () => `c-${rand(8)}`;

export function emptyTimeline(preset: VideoSizePreset = "portrait"): VideoTimeline {
  const size = VIDEO_SIZES[preset] ?? VIDEO_SIZES.portrait;
  return {
    ...size, fps: 30, background: "#000000",
    tracks: [
      { id: newTrackId(), kind: "video", name: "Video", clips: [] },
      { id: newTrackId(), kind: "text", name: "Text", clips: [] },
      { id: newTrackId(), kind: "audio", name: "Audio", clips: [] },
    ],
  };
}

// ---------- reading ----------

export const clipEnd = (clip: VideoClip) => clip.start + clip.duration;
export const clipSpeed = (clip: VideoClip) => clip.speed ?? 1;
/** Framing when a clip leaves `fit` out: the whole picture, letterboxed. */
export const clipFit = (clip: VideoClip): "cover" | "contain" => clip.fit ?? "contain";
/** Source time shown at timeline time t inside the clip. */
export const sourceTimeAt = (clip: VideoClip, t: number) => (clip.in ?? 0) + (t - clip.start) * clipSpeed(clip);

export function timelineDuration(timeline: VideoTimeline): number {
  let end = 0;
  for (const track of timeline.tracks) for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  return end;
}

/** Clips covering timeline time t, bottom track first. */
export function clipsAt(timeline: VideoTimeline, t: number): { track: VideoTrack; clip: VideoClip }[] {
  const out: { track: VideoTrack; clip: VideoClip }[] = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) if (t >= clip.start && t < clipEnd(clip)) out.push({ track, clip });
  }
  return out;
}

export function findClip(timeline: VideoTimeline, clipId: string): { track: VideoTrack; clip: VideoClip; index: number } | null {
  for (const track of timeline.tracks) {
    const index = track.clips.findIndex(c => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

export function videoSummary(video: VideoRecord): VideoSummary {
  return {
    id: video.id, title: video.title, threadId: video.threadId, revision: video.revision, updatedAt: video.updatedAt,
    duration: timelineDuration(video.timeline), width: video.timeline.width, height: video.timeline.height,
    clipCount: video.timeline.tracks.reduce((n, t) => n + t.clips.length, 0),
    lastRender: video.renders.at(-1), trashedAt: video.trashedAt,
  };
}

export const fmtTime = (s: number) => {
  const sign = s < 0 ? "-" : "";
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${sign}${m}:${sec.toFixed(2).padStart(5, "0")}`;
};

/** The timeline as text a bot can reason about: every id, every time. */
export function videoForBot(video: VideoRecord): string {
  const t = video.timeline;
  const lines: string[] = [];
  lines.push(`${t.width}x${t.height} @ ${t.fps}fps · length ${fmtTime(timelineDuration(t))} · background ${t.background}`);
  lines.push("", "media:");
  if (!video.media.length) lines.push("  (none — add files with video_add_media)");
  for (const m of video.media) {
    lines.push(`  ${m.id} · ${m.kind} · ${m.name} · ${m.kind === "image" ? "still" : fmtTime(m.duration)}${m.width ? ` · ${m.width}x${m.height}` : ""}${m.kind === "video" && m.hasAudio === false ? " · no audio" : ""}`);
  }
  lines.push("", "tracks (first is the bottom layer):");
  for (const track of t.tracks) {
    lines.push(`  ${track.id} · ${track.kind}${track.name ? ` "${track.name}"` : ""}${track.muted ? " · muted" : ""}${track.hidden ? " · hidden" : ""}`);
    if (!track.clips.length) lines.push("    (empty)");
    for (const c of [...track.clips].sort((a, b) => a.start - b.start)) {
      const parts = [`${c.id}`, `${fmtTime(c.start)}–${fmtTime(clipEnd(c))}`];
      if (c.mediaId) {
        const m = video.media.find(x => x.id === c.mediaId);
        parts.push(`${c.mediaId}${m ? ` (${m.name})` : " (missing)"} from ${fmtTime(c.in ?? 0)}`);
      }
      if (c.text !== undefined) parts.push(JSON.stringify(c.text));
      if (c.speed && c.speed !== 1) parts.push(`speed ${c.speed}`);
      if (c.volume !== undefined && c.volume !== 1) parts.push(`volume ${c.volume}`);
      if (c.fadeIn) parts.push(`fade in ${c.fadeIn}s`);
      if (c.fadeOut) parts.push(`fade out ${c.fadeOut}s`);
      if (c.style && c.text !== undefined) parts.push(`style ${JSON.stringify(c.style)}`);
      if (c.fit) parts.push(`fit ${c.fit}`);
      if (c.label) parts.push(`label ${JSON.stringify(c.label)}`);
      lines.push(`    ${parts.join(" · ")}`);
    }
  }
  const r = video.renders.at(-1);
  if (r) lines.push("", `last render: ${r.status}${r.status === "running" ? ` ${Math.round(r.progress * 100)}%` : ""} (revision ${r.revision})${r.error ? ` · ${r.error}` : ""}`);
  return lines.join("\n");
}

// ---------- validation ----------

const bad = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
const num = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) bad(`${name} must be a number from ${min} to ${max}`);
  return v as number;
};
const optNum = (v: unknown, name: string, min: number, max: number) => (v === undefined ? undefined : num(v, name, min, max));
const COLOR_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function cleanStyle(raw: unknown): VideoTextStyle | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("style must be an object");
  const s = raw as Record<string, unknown>;
  const out: VideoTextStyle = {};
  if (s.size !== undefined) out.size = num(s.size, "style.size", 0.01, 0.5);
  if (s.color !== undefined) { if (typeof s.color !== "string" || !COLOR_RE.test(s.color)) bad("style.color must be #rrggbb"); out.color = s.color as string; }
  if (s.background !== undefined) { if (typeof s.background !== "string" || (s.background !== "" && !COLOR_RE.test(s.background))) bad("style.background must be #rrggbb(aa) or empty"); out.background = s.background as string; }
  if (s.weight !== undefined) { if (![400, 600, 800].includes(s.weight as number)) bad("style.weight must be 400, 600 or 800"); out.weight = s.weight as 400 | 600 | 800; }
  if (s.x !== undefined) out.x = num(s.x, "style.x", 0, 1);
  if (s.y !== undefined) out.y = num(s.y, "style.y", 0, 1);
  if (s.align !== undefined) { if (!["left", "center", "right"].includes(String(s.align))) bad("style.align must be left, center or right"); out.align = s.align as "left"; }
  return out;
}

const snapTime = (seconds: number) => Math.round(seconds * 1e4) / 1e4;

/** Checks a timeline from an untrusted editor or bot and returns a clean copy.
 * Clip media ids must exist in `media`; text tracks hold only text clips. */
export function validateTimeline(raw: unknown, media: VideoMedia[]): VideoTimeline {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("timeline must be an object");
  const t = raw as Record<string, unknown>;
  const width = Math.round(num(t.width, "width", 16, 4096) / 2) * 2;
  const height = Math.round(num(t.height, "height", 16, 4096) / 2) * 2;
  const fps = num(t.fps, "fps", 1, 120);
  const background = typeof t.background === "string" && COLOR_RE.test(t.background) ? t.background : "#000000";
  if (!Array.isArray(t.tracks) || t.tracks.length > VIDEO_LIMITS.tracks) bad(`tracks must be a list of at most ${VIDEO_LIMITS.tracks}`);
  const mediaById = new Map(media.map(m => [m.id, m]));
  const seen = new Set<string>();
  const tracks = (t.tracks as unknown[]).map((rawTrack, ti): VideoTrack => {
    const tr = rawTrack as Record<string, unknown>;
    if (!tr || typeof tr !== "object") bad(`track ${ti + 1} must be an object`);
    const id = typeof tr.id === "string" && TRACK_ID_RE.test(tr.id) && !seen.has(tr.id) ? tr.id : newTrackId();
    seen.add(id);
    if (!["video", "audio", "text"].includes(String(tr.kind))) bad(`track ${ti + 1}: kind must be video, audio or text`);
    const kind = tr.kind as VideoTrackKind;
    if (!Array.isArray(tr.clips) || tr.clips.length > VIDEO_LIMITS.clipsPerTrack) bad(`track ${ti + 1}: clips must be a list of at most ${VIDEO_LIMITS.clipsPerTrack}`);
    const clips = (tr.clips as unknown[]).map((rawClip, ci): VideoClip => {
      const c = rawClip as Record<string, unknown>;
      const where = `track ${ti + 1} clip ${ci + 1}`;
      if (!c || typeof c !== "object") bad(`${where} must be an object`);
      const cid = typeof c.id === "string" && CLIP_ID_RE.test(c.id) && !seen.has(c.id) ? c.id : newClipId();
      seen.add(cid);
      // Times are stored to 0.1 ms so float drift from splits and drags (2.1999999999999993) never lands on disk.
      const clip: VideoClip = { id: cid, start: snapTime(num(c.start, `${where} start`, 0, VIDEO_LIMITS.maxDuration)), duration: snapTime(num(c.duration, `${where} duration`, 0.01, VIDEO_LIMITS.maxDuration)) };
      if (kind === "text") {
        if (typeof c.text !== "string" || c.text.length > VIDEO_LIMITS.textChars) bad(`${where}: text clips need text (at most ${VIDEO_LIMITS.textChars} chars)`);
        clip.text = c.text as string;
        const style = cleanStyle(c.style);
        if (style) clip.style = style;
      } else {
        if (typeof c.mediaId !== "string" || !mediaById.has(c.mediaId)) bad(`${where}: mediaId must name a file in the media bin`);
        const m = mediaById.get(c.mediaId as string)!;
        if (kind === "audio" && m.kind === "image") bad(`${where}: an image cannot sit on an audio track`);
        if (kind === "video" && m.kind === "audio") bad(`${where}: audio goes on an audio track`);
        clip.mediaId = m.id;
        clip.in = snapTime(optNum(c.in, `${where} in`, 0, VIDEO_LIMITS.maxDuration) ?? 0);
        const speed = optNum(c.speed, `${where} speed`, 0.25, 4);
        if (speed !== undefined && speed !== 1) clip.speed = speed;
        if (m.kind !== "image" && m.duration > 0 && clip.in + clip.duration * (speed ?? 1) > m.duration + 0.05) {
          bad(`${where}: runs past the end of ${m.name} (${fmtTime(m.duration)})`);
        }
        const volume = optNum(c.volume, `${where} volume`, 0, 2);
        if (volume !== undefined && volume !== 1) clip.volume = volume;
        if (c.fit === "cover" || c.fit === "contain") clip.fit = c.fit;
      }
      const fadeIn = optNum(c.fadeIn, `${where} fadeIn`, 0, 30);
      const fadeOut = optNum(c.fadeOut, `${where} fadeOut`, 0, 30);
      if (fadeIn) clip.fadeIn = fadeIn;
      if (fadeOut) clip.fadeOut = fadeOut;
      if (typeof c.label === "string" && c.label.trim()) clip.label = c.label.slice(0, 200);
      return clip;
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      if (clips[i]!.start < clipEnd(clips[i - 1]!) - 0.001) bad(`track ${ti + 1}: clips ${clips[i - 1]!.id} and ${clips[i]!.id} overlap; put one on another track`);
    }
    const track: VideoTrack = { id, kind, clips };
    if (typeof tr.name === "string" && tr.name.trim()) track.name = tr.name.slice(0, 60);
    if (tr.muted === true) track.muted = true;
    if (tr.hidden === true) track.hidden = true;
    return track;
  });
  const timeline = { width, height, fps, background, tracks };
  if (timelineDuration(timeline) > VIDEO_LIMITS.maxDuration) bad("timeline is longer than 3 hours");
  return timeline;
}

// ---------- edits (bot tool ops, also used by the editor's commands) ----------

export type VideoEditOp =
  | { op: "add_clip"; track_id: string; media_id?: string; text?: string; start?: number; duration?: number; in?: number; speed?: number; volume?: number; style?: VideoTextStyle; fit?: "cover" | "contain"; label?: string }
  | { op: "update_clip"; clip_id: string; start?: number; duration?: number; in?: number; speed?: number; volume?: number; text?: string; style?: VideoTextStyle; fade_in?: number; fade_out?: number; fit?: "cover" | "contain"; label?: string }
  | { op: "move_clip"; clip_id: string; start: number; track_id?: string }
  | { op: "split"; clip_id: string; at: number }
  | { op: "delete_clip"; clip_id: string; ripple?: boolean }
  | { op: "add_track"; kind: VideoTrackKind; name?: string; index?: number }
  | { op: "update_track"; track_id: string; name?: string; muted?: boolean; hidden?: boolean }
  | { op: "delete_track"; track_id: string }
  | { op: "set_format"; width?: number; height?: number; fps?: number; background?: string };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Applies ops to a copy of the timeline, then validates the result.
 * `add_clip` with no start appends after the track's last clip; with no
 * duration it uses the media's remaining length (3s for images and text). */
export function applyVideoEdits(timeline: VideoTimeline, media: VideoMedia[], ops: VideoEditOp[]): { timeline: VideoTimeline; created: string[] } {
  const t = clone(timeline);
  const created: string[] = [];
  const track = (id: string) => t.tracks.find(x => x.id === id) ?? bad(`no track ${id}`);
  const located = (id: string) => findClip(t, id) ?? bad(`no clip ${id}`);
  ops.forEach((op, i) => {
    const where = `edit ${i + 1} (${op.op})`;
    try {
      switch (op.op) {
        case "add_clip": {
          const tr = track(op.track_id);
          const m = op.media_id ? media.find(x => x.id === op.media_id) ?? bad(`no media ${op.media_id}`) : undefined;
          const start = op.start ?? tr.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0);
          const speed = op.speed ?? 1;
          const inPoint = op.in ?? 0;
          const duration = op.duration ?? (m && m.kind !== "image" ? Math.max(0.1, (m.duration - inPoint) / speed) : 3);
          const clip: VideoClip = { id: newClipId(), start, duration };
          if (m) Object.assign(clip, { mediaId: m.id, in: inPoint, ...(speed !== 1 ? { speed } : {}) });
          if (op.text !== undefined) clip.text = op.text;
          if (op.style) clip.style = op.style;
          if (op.volume !== undefined) clip.volume = op.volume;
          if (op.fit) clip.fit = op.fit;
          if (op.label) clip.label = op.label;
          tr.clips.push(clip);
          created.push(clip.id);
          break;
        }
        case "update_clip": {
          const { clip } = located(op.clip_id);
          if (op.start !== undefined) clip.start = op.start;
          if (op.duration !== undefined) clip.duration = op.duration;
          if (op.in !== undefined) clip.in = op.in;
          if (op.speed !== undefined) clip.speed = op.speed;
          if (op.volume !== undefined) clip.volume = op.volume;
          if (op.text !== undefined) clip.text = op.text;
          if (op.style) clip.style = { ...clip.style, ...op.style };
          if (op.fade_in !== undefined) clip.fadeIn = op.fade_in;
          if (op.fade_out !== undefined) clip.fadeOut = op.fade_out;
          if (op.fit) clip.fit = op.fit;
          if (op.label !== undefined) clip.label = op.label;
          break;
        }
        case "move_clip": {
          const found = located(op.clip_id);
          found.clip.start = op.start;
          if (op.track_id && op.track_id !== found.track.id) {
            const to = track(op.track_id);
            found.track.clips.splice(found.index, 1);
            to.clips.push(found.clip);
          }
          break;
        }
        case "split": {
          const { track: tr, clip } = located(op.clip_id);
          if (op.at <= clip.start + 0.01 || op.at >= clipEnd(clip) - 0.01) bad(`split time must fall inside the clip (${fmtTime(clip.start)}–${fmtTime(clipEnd(clip))})`);
          const right: VideoClip = { ...clone(clip), id: newClipId(), start: op.at, duration: clipEnd(clip) - op.at };
          if (clip.mediaId) right.in = sourceTimeAt(clip, op.at);
          delete right.fadeIn;
          clip.duration = op.at - clip.start;
          delete clip.fadeOut;
          tr.clips.push(right);
          created.push(right.id);
          break;
        }
        case "delete_clip": {
          const { track: tr, clip, index } = located(op.clip_id);
          tr.clips.splice(index, 1);
          if (op.ripple) for (const c of tr.clips) if (c.start >= clipEnd(clip) - 0.001) c.start -= clip.duration;
          break;
        }
        case "add_track": {
          if (t.tracks.length >= VIDEO_LIMITS.tracks) bad(`at most ${VIDEO_LIMITS.tracks} tracks`);
          const tr: VideoTrack = { id: newTrackId(), kind: op.kind, clips: [], ...(op.name ? { name: op.name } : {}) };
          t.tracks.splice(op.index ?? t.tracks.length, 0, tr);
          created.push(tr.id);
          break;
        }
        case "update_track": {
          const tr = track(op.track_id);
          if (op.name !== undefined) tr.name = op.name;
          if (op.muted !== undefined) tr.muted = op.muted;
          if (op.hidden !== undefined) tr.hidden = op.hidden;
          break;
        }
        case "delete_track": {
          const index = t.tracks.findIndex(x => x.id === op.track_id);
          if (index < 0) bad(`no track ${op.track_id}`);
          t.tracks.splice(index, 1);
          break;
        }
        case "set_format": {
          if (op.width !== undefined) t.width = op.width;
          if (op.height !== undefined) t.height = op.height;
          if (op.fps !== undefined) t.fps = op.fps;
          if (op.background !== undefined) t.background = op.background;
          break;
        }
        default: bad(`unknown op ${(op as { op: string }).op}`);
      }
    } catch (error) {
      const e = error as Error & { status?: number };
      throw Object.assign(new Error(`${where}: ${e.message}`), { status: e.status ?? 400 });
    }
  });
  return { timeline: validateTimeline(t, media), created };
}
