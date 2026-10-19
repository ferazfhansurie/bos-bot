// Video storage: one folder per video under the bot folder, which sits
// outside the bot-writable workspace so a bot changes a video only through
// its video tools. Each folder holds project.json (timeline, media bin,
// versions, renders), media/ (imported files and playable proxies), thumbs/
// (filmstrip sprites and waveform peaks) and renders/ (finished mp4s).
// Deleting the bot deletes its folder and with it every video.
//
// Revisions count timeline/media changes only. Derived files arriving in the
// background (thumbs, peaks, proxies) and render progress update the record
// and broadcast with the SAME revision, so they never turn an editor's
// in-flight save into a conflict.
import { constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import { writeFileAtomic } from "./atomic.ts";
import { botFolder } from "./bot-folder.ts";
import { makeFilmstrip, makePeaks, makeProxy, probeMedia, proxyNeeded, type MediaProbe } from "./video-probe.ts";
import { buildRenderGraph, renderSnapshot, runRender, textEngine, type RenderRun, type TextEngine } from "./video-render.ts";
import {
  MEDIA_ID_RE, VIDEO_ID_RE, VIDEO_LIMITS, VIDEO_SIZES, applyVideoEdits, emptyTimeline, newMediaId, newVideoId,
  validateTimeline, videoSummary,
  type VideoAuthor, type VideoEditOp, type VideoMedia, type VideoRecord, type VideoRender, type VideoSizePreset, type VideoSummary,
} from "../shared/video.ts";

const fail = (status: number, message: string, extra: Record<string, unknown> = {}): never => {
  throw Object.assign(new Error(message), { status, ...extra });
};
/** Saves by the same person within this gap share one checkpoint. */
const CHECKPOINT_GAP_MS = 10 * 60_000;
const TRASH_DAYS = 30;
const KEEP_RENDERS = 10;
const VERSIONS_BYTES = 8_000_000;
const PROGRESS_EVERY_MS = 500;

export interface VideoChange { botId: string; videoId: string; revision: number; by: VideoAuthor; deleted?: boolean; render?: VideoRender }

export const MEDIA_MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", mkv: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
export const mimeOf = (file: string) => MEDIA_MIME[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

function cleanTitle(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") fail(400, "title must be text");
  const title = (raw as string).replace(/\s+/g, " ").trim();
  if (title.length > VIDEO_LIMITS.titleChars) fail(400, `title must be at most ${VIDEO_LIMITS.titleChars} characters`);
  return title;
}

/** Extensions kept on stored media. ffmpeg picks some demuxers by extension
 * alone (".ans" reads any text file as a picture), so anything else is stored
 * as ".bin" and probed by content. */
const MEDIA_EXTENSIONS = new Set([...Object.keys(MEDIA_MIME), "heic", "heif", "avi", "aif", "aiff", "caf", "ts", "mts", "m2ts", "3gp", "bmp", "tif", "tiff"]);

function extensionOf(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  return ext && MEDIA_EXTENSIONS.has(ext) ? ext : "bin";
}

export function cleanMediaName(name: string): string {
  return basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "media";
}

/** Creates a bot-writable export folder and refuses it when it, or the folder
 * above it, is a link the bot planted to aim server writes elsewhere. */
async function exportFolder(dir: string): Promise<void> {
  const check = async (missingOk: boolean) => {
    for (const path of [dirname(dir), dir]) {
      const info = await lstat(path).catch(() => null);
      if (!info && missingOk) continue;
      if (!info || info.isSymbolicLink() || !info.isDirectory()) fail(409, `${path} must be a plain folder, not a link`);
    }
  };
  await check(true); // before mkdir, so it never creates folders through a link
  await mkdir(dir, { recursive: true });
  await check(false);
}

/** Leftovers from a render, proxy or snapshot the app was stopped in the middle of. */
const SCRATCH_RE = /(\.part\.mp4|\.work|\.proxy-part\.[a-z0-9]+)$/;

type Active = { renderId: string; run?: RenderRun; cancelled?: boolean };

export class VideoStore {
  private cache = new Map<string, Map<string, VideoRecord>>();
  private readonly root: (botId: string) => string;
  private readonly now: () => number;
  private readonly onChange: (change: VideoChange) => void;
  private readonly text: () => Promise<TextEngine | null>;
  private readonly active = new Map<string, Active>();
  private jobs: Promise<void> = Promise.resolve();
  private jobControllers = new Map<string, AbortController>();
  private lastProgress = new Map<string, number>();

  constructor(options: { root?: (botId: string) => string; now?: () => number; onChange?: (change: VideoChange) => void; text?: () => Promise<TextEngine | null> } = {}) {
    this.root = options.root ?? (botId => join(botFolder(botId), "videos"));
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
    this.text = options.text ?? textEngine;
  }

  // ---------- paths and loading ----------

  private dir(botId: string) {
    if (!/^[\w-]+$/.test(botId)) fail(400, "bad bot id");
    return this.root(botId);
  }

  projectDir(botId: string, videoId: string) {
    if (!VIDEO_ID_RE.test(videoId)) fail(404, "no such video");
    return join(this.dir(botId), videoId);
  }

  private videos(botId: string): Map<string, VideoRecord> {
    let videos = this.cache.get(botId);
    if (videos) return videos;
    videos = new Map();
    const dir = this.dir(botId);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!VIDEO_ID_RE.test(name)) continue;
        try {
          const video = JSON.parse(readFileSync(join(dir, name, "project.json"), "utf8")) as VideoRecord;
          if (video?.id !== name || !video.timeline || !Array.isArray(video.media)) continue;
          // A render that was running when the app stopped will never finish.
          for (const r of video.renders ?? []) if (r.status === "running" || r.status === "queued") Object.assign(r, { status: "failed", error: "interrupted when the app stopped", finishedAt: r.finishedAt ?? video.updatedAt });
          video.renders ??= [];
          video.versions ??= [];
          videos.set(video.id, video);
          this.sweepScratch(join(dir, name));
        } catch { /* a damaged project stays on disk for recovery and is skipped */ }
      }
    }
    this.cache.set(botId, videos);
    return videos;
  }

  private sweepScratch(projectDir: string) {
    for (const sub of ["", "media", "renders"]) {
      const dir = join(projectDir, sub);
      try {
        for (const name of readdirSync(dir)) if (SCRATCH_RE.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
      } catch { /* folder not made yet */ }
    }
  }

  /** Drop the cached copy after the bot (and its folder) is deleted. */
  forget(botId: string) {
    for (const [key, active] of this.active) if (key.startsWith(`${botId}/`)) { active.cancelled = true; active.run?.cancel(); }
    for (const [key, controller] of this.jobControllers) if (key.startsWith(`${botId}/`)) { controller.abort(); this.jobControllers.delete(key); }
    this.cache.delete(botId);
  }

  private persist(botId: string, video: VideoRecord) {
    if (Buffer.byteLength(JSON.stringify({ ...video, versions: [] })) > VIDEO_LIMITS.projectJsonBytes) fail(413, "this video's project is too large to save; split it into smaller videos");
    while (video.versions.length && Buffer.byteLength(JSON.stringify(video.versions)) > VERSIONS_BYTES) video.versions.shift();
    const dir = this.projectDir(botId, video.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, "project.json"), JSON.stringify(video), { mode: 0o600 });
    this.videos(botId).set(video.id, video);
  }

  private commit(botId: string, video: VideoRecord, author: VideoAuthor) {
    video.revision += 1;
    video.updatedAt = this.now();
    video.updatedBy = author;
    this.persist(botId, video);
    this.onChange({ botId, videoId: video.id, revision: video.revision, by: author });
    return structuredClone(video);
  }

  /** Persist a change that is not an edit (derived files, renders) and tell clients. */
  private touch(botId: string, video: VideoRecord, by: VideoAuthor, render?: VideoRender) {
    this.persist(botId, video);
    this.onChange({ botId, videoId: video.id, revision: video.revision, by, ...(render ? { render: { ...render } } : {}) });
  }

  /** The live cached record (mutable) — internal use only. */
  private live(botId: string, videoId: string): VideoRecord {
    if (!VIDEO_ID_RE.test(videoId)) fail(404, "no such video");
    return this.videos(botId).get(videoId) ?? fail(404, "no such video");
  }

  // ---------- documents ----------

  list(botId: string, options: { trash?: boolean; query?: string } = {}): VideoSummary[] {
    const videos = this.videos(botId);
    const cutoff = this.now() - TRASH_DAYS * 86_400_000;
    for (const video of [...videos.values()]) if (video.trashedAt && video.trashedAt < cutoff) this.destroy(botId, video.id, video.updatedBy);
    const query = options.query?.trim().toLowerCase();
    return [...videos.values()]
      .filter(video => Boolean(video.trashedAt) === Boolean(options.trash))
      .filter(video => !query || video.title.toLowerCase().includes(query) || video.media.some(m => m.name.toLowerCase().includes(query)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(videoSummary);
  }

  get(botId: string, videoId: string): VideoRecord {
    return structuredClone(this.live(botId, videoId));
  }

  create(botId: string, input: { title?: unknown; size?: unknown; threadId?: string }, author: VideoAuthor): VideoRecord {
    if (this.videos(botId).size >= VIDEO_LIMITS.videosPerBot) fail(409, `a bot holds at most ${VIDEO_LIMITS.videosPerBot} videos; delete some first`);
    const size = input.size === undefined ? "portrait" : String(input.size);
    if (!(size in VIDEO_SIZES)) fail(400, `size must be one of ${Object.keys(VIDEO_SIZES).join(", ")}`);
    const at = this.now();
    const video: VideoRecord = {
      id: newVideoId(), title: cleanTitle(input.title), ...(input.threadId ? { threadId: input.threadId } : {}),
      revision: 0, createdAt: at, updatedAt: at, createdBy: author, updatedBy: author,
      media: [], timeline: emptyTimeline(size as VideoSizePreset), renders: [], versions: [],
    };
    return this.commit(botId, video, author);
  }

  private checkpoint(video: VideoRecord) {
    const last = video.versions.at(-1);
    if (last && (last.revision === video.revision || JSON.stringify(last.timeline) === JSON.stringify(video.timeline))) return;
    video.versions.push({ id: `r${video.revision}`, revision: video.revision, at: video.updatedAt, by: video.updatedBy, timeline: structuredClone(video.timeline) });
    if (video.versions.length > VIDEO_LIMITS.versions) video.versions.splice(0, video.versions.length - VIDEO_LIMITS.versions);
  }

  /** Before a timeline change: keep the old state for every bot edit, when
   * another author takes over, or when the last checkpoint is old. A person
   * dragging clips for ten minutes leaves one checkpoint, not hundreds. */
  private beforeTimelineChange(video: VideoRecord, author: VideoAuthor) {
    const last = video.versions.at(-1);
    const handover = video.updatedBy.id !== author.id || video.updatedBy.kind !== author.kind;
    if (author.kind === "bot" || handover || !last || this.now() - last.at > CHECKPOINT_GAP_MS) this.checkpoint(video);
  }

  /** An editor save of the whole timeline. Stale revisions are refused with
   * the current record (`video` on the error) so the client can merge. */
  save(botId: string, videoId: string, input: { baseRevision?: unknown; timeline?: unknown; title?: unknown }, author: VideoAuthor): VideoRecord {
    const video = this.live(botId, videoId);
    if (video.trashedAt) fail(409, "this video is in the trash; restore it first");
    if (input.baseRevision !== video.revision) fail(409, "the video changed since you opened it", { video: structuredClone(video) });
    const timeline = input.timeline === undefined ? undefined : validateTimeline(input.timeline, video.media);
    const title = input.title === undefined ? undefined : cleanTitle(input.title);
    const timelineChanged = timeline !== undefined && JSON.stringify(timeline) !== JSON.stringify(video.timeline);
    const titleChanged = title !== undefined && title !== video.title;
    if (!timelineChanged && !titleChanged) return structuredClone(video);
    const next = structuredClone(video);
    if (timelineChanged) { this.beforeTimelineChange(next, author); next.timeline = timeline!; }
    if (titleChanged) next.title = title!;
    return this.commit(botId, next, author);
  }

  /** Edit ops (the bot's tool and the editor's commands). */
  edit(botId: string, videoId: string, ops: VideoEditOp[], author: VideoAuthor, baseRevision?: number): { video: VideoRecord; created: string[] } {
    const video = this.live(botId, videoId);
    if (video.trashedAt) fail(409, "this video is in the trash");
    if (baseRevision !== undefined && baseRevision !== video.revision) fail(409, "the video changed since you read it; read it again and use its revision", { video: structuredClone(video) });
    const { timeline, created } = applyVideoEdits(video.timeline, video.media, ops);
    return { video: this.save(botId, videoId, { baseRevision: video.revision, timeline }, author), created };
  }

  setTitle(botId: string, videoId: string, title: unknown, author: VideoAuthor): VideoRecord {
    const video = this.live(botId, videoId);
    return this.save(botId, videoId, { baseRevision: video.revision, title }, author);
  }

  setTrashed(botId: string, videoId: string, trashed: boolean, author: VideoAuthor): VideoRecord {
    const video = this.live(botId, videoId);
    if (Boolean(video.trashedAt) === trashed) return structuredClone(video);
    if (trashed) { video.trashedAt = this.now(); this.cancelActive(botId, videoId); } else delete video.trashedAt;
    this.touch(botId, video, author);
    return structuredClone(video);
  }

  destroy(botId: string, videoId: string, author: VideoAuthor) {
    const video = this.live(botId, videoId);
    this.cancelActive(botId, videoId);
    this.jobControllers.get(`${botId}/${videoId}`)?.abort();
    this.jobControllers.delete(`${botId}/${videoId}`);
    rmSync(this.projectDir(botId, videoId), { recursive: true, force: true });
    this.videos(botId).delete(video.id);
    this.onChange({ botId, videoId, revision: video.revision, by: author, deleted: true });
  }

  restoreVersion(botId: string, videoId: string, versionId: string, author: VideoAuthor): VideoRecord {
    const video = structuredClone(this.live(botId, videoId));
    if (video.trashedAt) fail(409, "this video is in the trash; restore it first");
    const version = video.versions.find(v => v.id === versionId) ?? fail(404, "no such version");
    // Media removed since the version was taken cannot come back; validate against today's bin.
    const timeline = validateTimeline(version.timeline, video.media);
    this.checkpoint(video);
    video.timeline = timeline;
    return this.commit(botId, video, author);
  }

  // ---------- media ----------

  private mediaDir(botId: string, videoId: string) { return join(this.projectDir(botId, videoId), "media"); }
  private thumbsDir(botId: string, videoId: string) { return join(this.projectDir(botId, videoId), "thumbs"); }
  rendersDir(botId: string, videoId: string) { return join(this.projectDir(botId, videoId), "renders"); }

  private beforeImport(botId: string, videoId: string) {
    const video = this.live(botId, videoId);
    if (video.trashedAt) fail(409, "this video is in the trash");
    if (video.media.length >= VIDEO_LIMITS.media) fail(409, `a video holds at most ${VIDEO_LIMITS.media} media files`);
    mkdirSync(this.mediaDir(botId, videoId), { recursive: true, mode: 0o700 });
  }

  /** A bot's file (or any server-side path the caller already authorised).
   * APFS/btrfs clone the file instantly; elsewhere it is a plain copy. */
  async addMediaFromFile(botId: string, videoId: string, source: string, author: VideoAuthor, displayName?: string): Promise<{ video: VideoRecord; media: VideoMedia }> {
    this.beforeImport(botId, videoId);
    const info = await stat(source).catch(() => fail(404, `no file at ${source}`));
    if (!info.isFile()) fail(400, `${source} is not a file`);
    if (info.size > VIDEO_LIMITS.mediaBytes) fail(413, "media files must be under 8 GB");
    if (!info.size) fail(400, "the file is empty");
    const id = newMediaId();
    const name = cleanMediaName(displayName ?? source);
    const file = `${id}.${extensionOf(name)}`;
    const target = join(this.mediaDir(botId, videoId), file);
    await copyFile(source, target, constants.COPYFILE_FICLONE);
    return this.finishImport(botId, videoId, { id, name, file, target }, author);
  }

  /** An owner upload: the request body streamed straight to disk. */
  async addMediaFromStream(botId: string, videoId: string, rawName: string, body: AsyncIterable<Buffer> | NodeJS.ReadableStream, author: VideoAuthor, options: { afterBody?: () => void } = {}): Promise<{ video: VideoRecord; media: VideoMedia }> {
    this.beforeImport(botId, videoId);
    const id = newMediaId();
    const name = cleanMediaName(rawName);
    const file = `${id}.${extensionOf(name)}`;
    const target = join(this.mediaDir(botId, videoId), file);
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (bytes > VIDEO_LIMITS.mediaBytes) return done(Object.assign(new Error("media files must be under 8 GB"), { status: 413 }));
        done(null, chunk);
      },
    });
    try {
      await pipeline(body as AsyncIterable<Buffer>, limit, createWriteStream(target, { mode: 0o600 }));
      if (!bytes) fail(400, "the upload was empty");
      options.afterBody?.();
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return this.finishImport(botId, videoId, { id, name, file, target }, author);
  }

  private async finishImport(botId: string, videoId: string, item: { id: string; name: string; file: string; target: string }, author: VideoAuthor): Promise<{ video: VideoRecord; media: VideoMedia }> {
    let probe: MediaProbe;
    try { probe = await probeMedia(item.target); }
    catch (error) { await rm(item.target, { force: true }); throw error; }
    const bytes = statSync(item.target).size;
    let video: VideoRecord;
    try { video = structuredClone(this.live(botId, videoId)); }
    catch (error) { await rm(item.target, { force: true }); throw error; }
    const media: VideoMedia = {
      id: item.id, name: item.name, kind: probe.kind, file: item.file, duration: probe.duration,
      ...(probe.width ? { width: probe.width, height: probe.height } : {}),
      ...(probe.fps ? { fps: probe.fps } : {}),
      ...(probe.kind !== "image" ? { hasAudio: probe.hasAudio } : {}),
      bytes, addedAt: this.now(), addedBy: author,
    };
    video.media.push(media);
    const saved = this.commit(botId, video, author);
    this.derive(botId, videoId, media, probe, item.target);
    return { video: saved, media };
  }

  /** Thumbs, peaks and a proxy, one ffmpeg at a time across the app. */
  private derive(botId: string, videoId: string, media: VideoMedia, probe: MediaProbe, source: string) {
    const key = `${botId}/${videoId}`;
    const controller = this.jobControllers.get(key) ?? new AbortController();
    this.jobControllers.set(key, controller);
    const update = (patch: Partial<VideoMedia>) => {
      if (controller.signal.aborted) return;
      let video: VideoRecord;
      try { video = this.live(botId, videoId); } catch { return; }
      const item = video.media.find(m => m.id === media.id);
      if (!item) return;
      Object.assign(item, patch);
      this.touch(botId, video, media.addedBy);
    };
    const step = (run: () => Promise<void>) => {
      this.jobs = this.jobs.then(async () => {
        if (controller.signal.aborted || !existsSync(source)) return;
        try { await run(); } catch { /* a missing filmstrip or waveform leaves the clip usable */ }
      });
    };
    const thumbs = this.thumbsDir(botId, videoId);
    if (probe.kind !== "audio") step(async () => {
      await mkdir(thumbs, { recursive: true, mode: 0o700 });
      const file = `${media.id}.jpg`;
      const strip = await makeFilmstrip(source, join(thumbs, file), probe, controller.signal);
      update({ thumbs: { file, every: strip.every, count: strip.count, width: strip.width, height: strip.height } });
    });
    if (probe.hasAudio) step(async () => {
      await mkdir(thumbs, { recursive: true, mode: 0o700 });
      const file = `${media.id}.peaks.json`;
      const peaks = await makePeaks(source, join(thumbs, file), controller.signal);
      update({ peaks: { file, perSecond: peaks.perSecond } });
    });
    const proxy = proxyNeeded(probe);
    if (proxy) step(async () => {
      const file = `${media.id}.proxy.${proxy}`;
      const part = join(this.mediaDir(botId, videoId), `${media.id}.proxy-part.${proxy}`);
      await makeProxy(source, part, proxy, controller.signal);
      await rename(part, join(this.mediaDir(botId, videoId), file));
      update({ proxy: file });
    });
  }

  /** Resolves when background thumbs/peaks/proxies queued so far are done. */
  idle(): Promise<void> {
    const current = this.jobs;
    return current.then(() => (current === this.jobs ? undefined : this.idle()));
  }

  removeMedia(botId: string, videoId: string, mediaId: string, author: VideoAuthor): VideoRecord {
    const video = structuredClone(this.live(botId, videoId));
    const media = video.media.find(m => m.id === mediaId) ?? fail(404, "no such media");
    if (video.timeline.tracks.some(t => t.clips.some(c => c.mediaId === mediaId))) fail(409, `${media.name} is used on the timeline; remove its clips first`);
    video.media = video.media.filter(m => m.id !== mediaId);
    const saved = this.commit(botId, video, author);
    for (const path of [
      join(this.mediaDir(botId, videoId), media.file),
      ...(media.proxy ? [join(this.mediaDir(botId, videoId), media.proxy)] : []),
      ...(media.thumbs ? [join(this.thumbsDir(botId, videoId), media.thumbs.file)] : []),
      ...(media.peaks ? [join(this.thumbsDir(botId, videoId), media.peaks.file)] : []),
    ]) rmSync(path, { force: true });
    return saved;
  }

  /** A file the routes serve. `which` picks the original, its proxy (falls
   * back to the original when none is needed), its filmstrip or its peaks. */
  mediaFile(botId: string, videoId: string, mediaId: string, which: "source" | "proxy" | "thumbs" | "peaks"): { path: string; mime: string } {
    if (!MEDIA_ID_RE.test(mediaId)) fail(404, "no such media");
    const media = this.live(botId, videoId).media.find(m => m.id === mediaId) ?? fail(404, "no such media");
    const [dir, file] = which === "source" ? [this.mediaDir(botId, videoId), media.file]
      : which === "proxy" ? [this.mediaDir(botId, videoId), media.proxy ?? media.file]
        : which === "thumbs" ? [this.thumbsDir(botId, videoId), media.thumbs?.file ?? fail(404, "the filmstrip is not ready yet")]
          : [this.thumbsDir(botId, videoId), media.peaks?.file ?? fail(404, "the waveform is not ready yet")];
    const path = join(dir, file);
    if (!existsSync(path)) fail(404, "the file is missing");
    return { path, mime: which === "peaks" ? "application/json" : which === "thumbs" ? "image/jpeg" : mimeOf(file) };
  }

  sourcePath(botId: string, videoId: string, media: VideoMedia) {
    return join(this.mediaDir(botId, videoId), media.file);
  }

  // ---------- renders ----------

  activeRender(botId: string, videoId: string): string | undefined {
    return this.active.get(`${botId}/${videoId}`)?.renderId;
  }

  private cancelActive(botId: string, videoId: string) {
    const active = this.active.get(`${botId}/${videoId}`);
    if (active) { active.cancelled = true; active.run?.cancel(); }
  }

  /** Starts rendering the current revision. One render per video at a time. */
  startRender(botId: string, videoId: string, author: VideoAuthor): VideoRender {
    const key = `${botId}/${videoId}`;
    const video = this.live(botId, videoId);
    if (video.trashedAt) fail(409, "this video is in the trash");
    const running = this.active.get(key);
    if (running) fail(409, "a render of this video is already running", { render: video.renders.find(r => r.id === running.renderId) });
    if (!video.timeline.tracks.some(t => t.clips.length)) fail(400, "the timeline is empty; add clips before rendering");
    const render: VideoRender = { id: `r-${newVideoId().slice(2)}`, status: "queued", progress: 0, revision: video.revision, startedAt: this.now() };
    video.renders.push(render);
    for (const old of video.renders.splice(0, Math.max(0, video.renders.length - KEEP_RENDERS))) {
      if (old.file) rmSync(join(this.rendersDir(botId, videoId), old.file), { force: true });
    }
    const active: Active = { renderId: render.id };
    this.active.set(key, active);
    this.touch(botId, video, author, render);
    const snapshot = structuredClone(video);
    void this.runRenderJob(botId, videoId, snapshot, render.id, active, author);
    return { ...render };
  }

  private async runRenderJob(botId: string, videoId: string, video: VideoRecord, renderId: string, active: Active, author: VideoAuthor) {
    const key = `${botId}/${videoId}`;
    const dir = this.rendersDir(botId, videoId);
    const file = `${renderId}.mp4`;
    const part = join(dir, `${renderId}.part.mp4`);
    const work = join(dir, `${renderId}.work`);
    const patch = (fields: Partial<VideoRender>, force = false) => {
      let live: VideoRecord;
      try { live = this.live(botId, videoId); } catch { return; }
      const render = live.renders.find(r => r.id === renderId);
      if (!render) return;
      Object.assign(render, fields);
      const now = Date.now();
      if (!force && now - (this.lastProgress.get(key) ?? 0) < PROGRESS_EVERY_MS) return;
      this.lastProgress.set(key, now);
      if (force) this.touch(botId, live, author, render);
      else this.onChange({ botId, videoId, revision: live.revision, by: author, render: { ...render } });
    };
    try {
      await mkdir(work, { recursive: true, mode: 0o700 });
      const graph = await buildRenderGraph(video.timeline, video.media, {
        mediaPath: m => this.sourcePath(botId, videoId, m), workDir: work, audio: true, text: await this.text(),
      });
      if (active.cancelled) fail(499, "cancelled");
      patch({ status: "running" }, true);
      active.run = runRender(graph, part, progress => patch({ progress }), { fps: video.timeline.fps });
      if (active.cancelled) active.run.cancel();
      await active.run.done;
      await rename(part, join(dir, file));
      const bytes = (await stat(join(dir, file))).size;
      patch({ status: "done", progress: 1, file, bytes, finishedAt: this.now() }, true);
    } catch (error) {
      const e = error as Error & { status?: number };
      await rm(part, { force: true });
      if (active.cancelled || e.status === 499) patch({ status: "cancelled", finishedAt: this.now() }, true);
      else patch({ status: "failed", error: e.message.slice(0, 500), finishedAt: this.now() }, true);
    } finally {
      await rm(work, { recursive: true, force: true });
      if (this.active.get(key) === active) this.active.delete(key);
      this.lastProgress.delete(key);
    }
  }

  cancelRender(botId: string, videoId: string, renderId: string): VideoRender {
    const video = this.live(botId, videoId);
    const render = video.renders.find(r => r.id === renderId) ?? fail(404, "no such render");
    const active = this.active.get(`${botId}/${videoId}`);
    if (active?.renderId === renderId) { active.cancelled = true; active.run?.cancel(); }
    return { ...render };
  }

  render(botId: string, videoId: string, renderId: string): VideoRender {
    const render = this.live(botId, videoId).renders.find(r => r.id === renderId) ?? fail(404, "no such render");
    return { ...render };
  }

  renderFile(botId: string, videoId: string, renderId: string): string {
    const render = this.render(botId, videoId, renderId);
    if (render.status !== "done" || !render.file) fail(409, `the render is ${render.status}`);
    const path = join(this.rendersDir(botId, videoId), render.file!);
    if (!existsSync(path)) fail(404, "the rendered file is missing");
    return path;
  }

  /** A copy of a finished render in a folder the bot can share from. */
  async exportRender(botId: string, videoId: string, renderId: string, dir: string): Promise<string> {
    const source = this.renderFile(botId, videoId, renderId);
    const video = this.live(botId, videoId);
    const stem = (video.title || "video").replace(/[^\w .-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "video";
    const out = join(dir, `${stem}-${renderId.slice(2, 8)}.mp4`);
    await exportFolder(dir);
    const existing = await lstat(out).catch(() => null);
    if (existing?.isFile()) return out;
    if (existing) fail(409, `${out} already exists and is not a render`);
    // EXCL: the folder is bot-writable, so never write through a link planted there.
    await copyFile(source, out, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    return out;
  }

  /** A snapshot jpg as bytes, plus a copy in `exportDir` (bot-writable, so
   * written under a fresh name that refuses links) when one is given. */
  async snapshotTo(botId: string, videoId: string, t: number, exportDir: string | undefined, maxSide = 960): Promise<{ path: string; data: Buffer }> {
    const own = join(this.projectDir(botId, videoId), "snapshots");
    await mkdir(own, { recursive: true, mode: 0o700 });
    const name = `${videoId}-${Math.round(t * 1000)}ms-${newMediaId().slice(2, 8)}.jpg`;
    const file = join(own, name);
    await this.snapshot(botId, videoId, t, file, maxSide);
    const data = await readFile(file);
    if (!exportDir) return { path: file, data };
    await exportFolder(exportDir);
    const out = join(exportDir, name);
    await copyFile(file, out, constants.COPYFILE_EXCL);
    await rm(file, { force: true });
    return { path: out, data };
  }

  /** One frame of the current timeline at `t` seconds, written to `out` (jpg). */
  async snapshot(botId: string, videoId: string, t: number, out: string, maxSide = 960): Promise<void> {
    const video = this.get(botId, videoId);
    const work = join(this.projectDir(botId, videoId), `snap-${newMediaId().slice(2)}.work`);
    try {
      await renderSnapshot(video.timeline, video.media, t, out, {
        mediaPath: m => this.sourcePath(botId, videoId, m), workDir: work, text: await this.text(), maxSide,
      });
    } finally { await rm(work, { recursive: true, force: true }); }
  }
}
