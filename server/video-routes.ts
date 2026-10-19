// HTTP for videos. Owner routes serve the editor (the timeline document,
// streamed uploads, Range-served media for <video>, filmstrips, waveforms and
// renders). Internal routes are the bot's video tools: they reach only the
// calling bot's videos from the conversation that made them and are refused
// in rooms, exactly like pages.
import { createReadStream, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

import { DATA_DIR } from "./config.ts";
import { messageFileDisposition } from "./message-file.ts";
import { TASK_WORKSPACES_DIR, workspaceDir } from "./workspace.ts";
import type { VideoStore } from "./videos.ts";
import {
  VIDEO_LIMITS, videoForBot, videoSummary,
  type VideoAuthor, type VideoEditOp, type VideoRecord,
} from "../shared/video.ts";

export interface VideoHttp {
  readBody: (limit: number) => Promise<any>;
  json: (status: number, body: unknown) => void;
  send: (status: number, headers: Record<string, string>, body: Buffer | string) => void;
  /** Writes the head, then pipes `body` (none for HEAD or empty files). */
  sendStream: (status: number, headers: Record<string, string>, body: Readable | null) => void;
}

export interface OwnerVideoDeps extends VideoHttp {
  videos: VideoStore;
  /** Throws unless the request is the owner on a live, non-peer session. */
  assertOwner: () => void;
  /** Runs the request's private checks (origin, session) once the body is read. */
  afterBody: () => void;
  owner: () => VideoAuthor;
  botExists: (botId: string) => boolean;
  /** The bot owning a direct (non-room) conversation, or null. */
  directBotOf: (threadId: string) => string | null;
  /** The raw request body, never buffered. Return must not destroy the socket. */
  requestBody: () => AsyncIterable<Buffer>;
  /** Drain a body we refuse, so the client still reads our 4xx. */
  discardBody: () => void;
  header: (name: string) => string | undefined;
}

const MAX_SAVE_BYTES = VIDEO_LIMITS.projectJsonBytes + 100_000;

async function guarded(http: VideoHttp, run: () => Promise<void> | void): Promise<true> {
  try { await run(); }
  catch (error) {
    const e = error as Error & { status?: number; video?: VideoRecord };
    http.json(e.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message, ...(e.video ? { video: e.video } : {}) });
  }
  return true;
}

/** One `bytes=` range of a file, or null for the whole file, or "bad". */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.includes(",") ? null : "bad"; // several ranges: send it all
  const [, a, b] = m;
  if (!a && !b) return "bad";
  let start: number, end: number;
  if (!a) { const n = Number(b); if (!n) return "bad"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(a); end = b ? Math.min(Number(b), size - 1) : size - 1; }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

/** Serves a file with Range support (206 / 416), for <video> seeking. */
export function serveFile(http: VideoHttp, method: string, path: string, headers: Record<string, string>, range: string | undefined) {
  const size = statSync(path).size;
  const common = { "accept-ranges": "bytes", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", ...headers };
  const r = parseRange(range, size);
  if (r === "bad") return http.sendStream(416, { ...common, "content-range": `bytes */${size}`, "content-length": "0" }, null);
  const { start, end } = r ?? { start: 0, end: size - 1 };
  const length = size ? end - start + 1 : 0;
  const head = { ...common, "content-length": String(length), ...(r ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) };
  http.sendStream(r ? 206 : 200, head, method === "HEAD" || !length ? null : createReadStream(path, { start, end }));
}

export async function handleOwnerVideoRoute(method: string, path: string, query: URLSearchParams, deps: OwnerVideoDeps): Promise<boolean> {
  const m = path.match(/^\/api\/videos\/([\w-]+)(?:\/(v-[a-z0-9]+)(?:\/(media|thumbs|peaks|renders|versions)(?:\/([\w.-]+))?(?:\/(proxy|cancel|restore))?)?)?$/);
  if (!m) return false;
  const [, botId, videoId, sub, subId, action] = m;
  const isUpload = sub === "media" && !subId && method === "POST";
  return guarded(deps, async () => {
    try { deps.assertOwner(); if (!deps.botExists(botId!)) throw Object.assign(new Error("no such bot"), { status: 404 }); }
    catch (error) { if (isUpload) deps.discardBody(); throw error; }
    const owner = deps.owner();
    const read = method === "GET" || method === "HEAD";
    const body = async (limit = 64_000) => {
      const value = read || method === "DELETE" ? {} : await deps.readBody(limit);
      deps.assertOwner();
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    };
    const { videos } = deps;
    if (!videoId) {
      if (method === "GET") return deps.json(200, { videos: videos.list(botId!, { trash: query.get("trash") === "1", query: query.get("q") ?? undefined }) });
      if (method === "POST") {
        const input = await body();
        const threadId = typeof input.threadId === "string" && deps.directBotOf(input.threadId) === botId ? input.threadId : undefined;
        return deps.json(200, { video: videos.create(botId!, { title: input.title, size: input.size, threadId }, owner) });
      }
      return deps.json(405, { error: "method not allowed" });
    }
    if (!sub) {
      if (method === "GET") return deps.json(200, { video: videos.get(botId!, videoId) });
      if (method === "PUT") {
        const input = await body(MAX_SAVE_BYTES);
        return deps.json(200, { video: videos.save(botId!, videoId, { baseRevision: input.baseRevision, timeline: input.timeline, title: input.title }, owner) });
      }
      if (method === "PATCH") {
        const input = await body(MAX_SAVE_BYTES);
        let video = videos.get(botId!, videoId);
        let created: string[] | undefined;
        if (Array.isArray(input.ops)) ({ video, created } = videos.edit(botId!, videoId, parseOps(input.ops), owner, typeof input.baseRevision === "number" ? input.baseRevision : undefined));
        if (input.title !== undefined) video = videos.setTitle(botId!, videoId, input.title, owner);
        if (typeof input.trashed === "boolean") video = videos.setTrashed(botId!, videoId, input.trashed, owner);
        return deps.json(200, { video, ...(created ? { created } : {}) });
      }
      if (method === "DELETE") {
        if (!videos.get(botId!, videoId).trashedAt) return deps.json(409, { error: "move the video to the trash first" });
        videos.destroy(botId!, videoId, owner);
        return deps.json(200, { ok: true });
      }
      return deps.json(405, { error: "method not allowed" });
    }
    if (isUpload) {
      const name = query.get("name")?.trim();
      const declared = Number(deps.header("content-length") ?? NaN);
      try {
        if (!name) throw Object.assign(new Error("name is required"), { status: 400 });
        if (declared > VIDEO_LIMITS.mediaBytes) throw Object.assign(new Error("media files must be under 8 GB"), { status: 413 });
        const result = await videos.addMediaFromStream(botId!, videoId, name, deps.requestBody(), owner, { afterBody: () => { deps.afterBody(); deps.assertOwner(); } });
        return deps.json(201, result);
      } catch (error) { deps.discardBody(); throw error; }
    }
    if (sub === "media" && subId && method === "DELETE" && !action) {
      return deps.json(200, { video: videos.removeMedia(botId!, videoId, subId, owner) });
    }
    if (read && (sub === "media" || sub === "thumbs" || sub === "peaks") && subId) {
      const which = sub === "media" ? (action === "proxy" ? "proxy" : action ? null : "source") : action ? null : sub;
      const mediaId = sub === "thumbs" ? subId.replace(/\.jpg$/, "") : sub === "peaks" ? subId.replace(/\.json$/, "") : subId;
      if (!which) return deps.json(404, { error: "not found" });
      const file = videos.mediaFile(botId!, videoId, mediaId, which);
      const name = videos.get(botId!, videoId).media.find(x => x.id === mediaId)?.name ?? "media";
      return serveFile(deps, method, file.path, {
        "content-type": file.mime,
        "content-disposition": query.get("download") === "1" ? messageFileDisposition(name) : "inline",
        "content-security-policy": "default-src 'none'",
        "cross-origin-resource-policy": "same-origin",
      }, deps.header("range"));
    }
    if (sub === "renders" && !subId && method === "POST") {
      await body(1024);
      const render = videos.startRender(botId!, videoId, owner);
      return deps.json(200, { render, video: videos.get(botId!, videoId) });
    }
    if (sub === "renders" && subId && action === "cancel" && method === "POST") {
      await body(1024);
      const render = videos.cancelRender(botId!, videoId, subId);
      return deps.json(200, { render, video: videos.get(botId!, videoId) });
    }
    if (sub === "renders" && subId && !action && read) {
      if (query.get("status") === "1") return deps.json(200, { render: videos.render(botId!, videoId, subId) });
      const file = videos.renderFile(botId!, videoId, subId);
      const video = videos.get(botId!, videoId);
      const name = `${(video.title || "video").replace(/[\\/:*?"<>|]+/g, " ").trim() || "video"}.mp4`;
      return serveFile(deps, method, file, {
        "content-type": "video/mp4",
        "content-disposition": query.get("download") === "1" ? messageFileDisposition(name) : "inline",
        "content-security-policy": "default-src 'none'",
      }, deps.header("range"));
    }
    if (sub === "versions" && subId && action === "restore" && method === "POST") {
      await body(1024);
      return deps.json(200, { video: videos.restoreVersion(botId!, videoId, subId, owner) });
    }
    return deps.json(405, { error: "method not allowed" });
  });
}

// ---------- bot tools ----------

export interface InternalVideoDeps extends VideoHttp {
  videos: VideoStore;
  botId: string;
  threadId: string;
  bot: VideoAuthor;
  inRoom: boolean;
  requireActive: () => void;
  /** Whether this bot may import the (absolute, resolved) file. */
  mediaSource?: (path: string) => string | null;
  /** Where finished renders and snapshots are copied so the bot can send them. */
  exportDir?: string;
}

const OPS = new Set(["add_clip", "update_clip", "move_clip", "split", "delete_clip", "add_track", "update_track", "delete_track", "set_format"]);

export function parseOps(input: unknown): VideoEditOp[] {
  if (!Array.isArray(input) || !input.length || input.length > 200) throw Object.assign(new Error("ops must list 1–200 operations"), { status: 400 });
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !OPS.has(String((raw as { op?: unknown }).op))) {
      throw Object.assign(new Error(`op ${index + 1}: op must be one of ${[...OPS].join(", ")}`), { status: 400 });
    }
    return raw as VideoEditOp;
  });
}

/** Home folders that usually hold the owner's footage and music. */
export const MEDIA_HOME_DIRS = ["Movies", "Music", "Pictures", "Desktop", "Downloads"];

/** Where a bot may import media from: its own workspace and conversation
 * folders, chat attachments, and the owner's usual media folders. Anything
 * else (app data, keys, documents, other bots) is refused, and the probe then
 * accepts only real media formats. Returns the resolved path to copy from, so
 * a symlink swapped in after the check cannot redirect the copy; null when refused. */
export function videoMediaSource(path: string, botId: string, roots = { home: homedir(), allowed: [workspaceDir(botId), join(TASK_WORKSPACES_DIR, botId), join(DATA_DIR, "attachments")] }): string | null {
  let real: string;
  try { real = realpathSync.native(path); } catch { throw Object.assign(new Error(`no file at ${path}`), { status: 404 }); }
  const resolve = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
  const inside = (dir: string) => { const rel = relative(resolve(dir), real); return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel)); };
  const media = MEDIA_HOME_DIRS.map(dir => join(roots.home, dir));
  if (roots.allowed.some(inside)) return real;
  // Inside the media folders, hidden parts (".secret/") stay private too.
  const home = media.find(inside);
  if (home && !relative(resolve(home), real).split(sep).some(part => part.startsWith("."))) return real;
  return null;
}

export const VIDEO_WHERE = "The owner sees this video live in the Videos side tab of this conversation; every edit appears there as you make it.";

export async function handleInternalVideoRoute(method: string, path: string, query: URLSearchParams, deps: InternalVideoDeps): Promise<boolean> {
  const m = path.match(/^\/api\/internal\/videos(?:\/(v-[a-z0-9]+)(?:\/(media|edit|render|renders|snapshot)(?:\/(r-[a-z0-9]+))?)?)?$/);
  if (!m) return false;
  const [, videoId, action, renderId] = m;
  return guarded(deps, async () => {
    if (deps.inRoom) return deps.json(403, { error: "videos are private to the owner and are not available in rooms" });
    const { videos, botId, bot } = deps;
    if (videoId && videos.get(botId, videoId).threadId !== deps.threadId) return deps.json(404, { error: "no such video in this conversation" });
    const body = async () => {
      const value = await deps.readBody(MAX_SAVE_BYTES);
      deps.requireActive();
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    };
    const brief = (video: VideoRecord) => ({ ...videoSummary(video), text: videoForBot(video), where: VIDEO_WHERE });
    const exported = async (renderId: string) => {
      const render = videos.render(botId, videoId!, renderId);
      if (render.status !== "done" || !deps.exportDir) return { render };
      return { render, path: await videos.exportRender(botId, videoId!, renderId, deps.exportDir) };
    };
    if (!videoId && method === "GET") {
      return deps.json(200, { videos: videos.list(botId, { query: query.get("q") ?? undefined }).filter(v => v.threadId === deps.threadId).slice(0, 100) });
    }
    if (!videoId && method === "POST") {
      const input = await body();
      return deps.json(200, { video: brief(videos.create(botId, { title: input.title, size: input.size, threadId: deps.threadId }, bot)) });
    }
    if (!action && method === "GET") return deps.json(200, { video: brief(videos.get(botId, videoId!)) });
    if (action === "media" && method === "POST") {
      const input = await body();
      const source = typeof input.path === "string" ? input.path : "";
      if (!source || !isAbsolute(source)) return deps.json(400, { error: "path must be an absolute file path" });
      const real = (deps.mediaSource ?? (p => videoMediaSource(p, botId)))(source);
      if (!real) return deps.json(403, { error: `import from your working folder or the owner's ${MEDIA_HOME_DIRS.join(", ")} folders; copy the file into your working folder first` });
      const { video, media } = await videos.addMediaFromFile(botId, videoId!, real, bot, typeof input.name === "string" ? input.name : basename(source));
      return deps.json(200, { media, video: brief(video) });
    }
    if (action === "edit" && method === "POST") {
      const input = await body();
      if (typeof input.base_revision !== "number") return deps.json(400, { error: "base_revision is required; read the video and use its revision" });
      let video = videos.get(botId, videoId!);
      let created: string[] = [];
      if (input.ops !== undefined) ({ video, created } = videos.edit(botId, videoId!, parseOps(input.ops), bot, input.base_revision));
      else if (input.base_revision !== video.revision) return deps.json(409, { error: "the video changed since you read it; read it again and use its revision" });
      if (input.title !== undefined) video = videos.setTitle(botId, videoId!, input.title, bot);
      return deps.json(200, { video: brief(video), created });
    }
    if (action === "render" && method === "POST") {
      await body();
      const render = videos.startRender(botId, videoId!, bot);
      return deps.json(200, { render });
    }
    if (action === "renders" && renderId && method === "GET") return deps.json(200, await exported(renderId));
    if (action === "snapshot" && method === "POST") {
      const input = await body();
      const t = Number(input.t ?? 0);
      if (!Number.isFinite(t) || t < 0) return deps.json(400, { error: "t must be a time in seconds" });
      const { path: out, data } = await videos.snapshotTo(botId, videoId!, t, deps.exportDir ? join(deps.exportDir, "snapshots") : undefined, Number(input.max_side) > 0 ? Math.min(1920, Number(input.max_side)) : 960);
      return deps.json(200, { path: out, t, mime: "image/jpeg", data: data.toString("base64") });
    }
    return deps.json(405, { error: "method not allowed" });
  });
}
