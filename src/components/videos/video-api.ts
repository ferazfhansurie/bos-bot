// The editor's side of /api/videos. Cookies carry the owner session, so
// <video>, <img> and download links point straight at these routes.
import type { VideoMedia, VideoRecord, VideoRender, VideoSizePreset, VideoSummary, VideoTimeline } from "../../../shared/video";

export class VideoApiError extends Error {
  constructor(message: string, readonly status: number, readonly video?: VideoRecord) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body.video);
  return body as T;
}

const base = (botId: string) => `/api/videos/${encodeURIComponent(botId)}`;
const one = (botId: string, videoId: string) => `${base(botId)}/${encodeURIComponent(videoId)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** Media as the editor plays it (the server may attach a browser-playable proxy). */
export type PlayableMedia = VideoMedia;

export const videoApi = {
  list: (botId: string, options: { trash?: boolean; query?: string } = {}) => {
    const q = new URLSearchParams();
    if (options.trash) q.set("trash", "1");
    if (options.query?.trim()) q.set("q", options.query.trim());
    return call<{ videos: VideoSummary[] }>(`${base(botId)}${q.size ? `?${q}` : ""}`).then(r => r.videos);
  },
  create: (botId: string, input: { title?: string; size?: VideoSizePreset; threadId?: string }) =>
    call<{ video: VideoRecord }>(base(botId), json("POST", input)).then(r => r.video),
  get: (botId: string, videoId: string) => call<{ video: VideoRecord }>(one(botId, videoId)).then(r => r.video),
  save: (botId: string, videoId: string, input: { baseRevision: number; timeline?: VideoTimeline; title?: string }) =>
    call<{ video: VideoRecord }>(one(botId, videoId), json("PUT", input)).then(r => r.video),
  patch: (botId: string, videoId: string, input: { trashed?: boolean }) =>
    call<{ video: VideoRecord }>(one(botId, videoId), json("PATCH", input)).then(r => r.video),
  destroy: (botId: string, videoId: string) => call<{ ok: true }>(one(botId, videoId), { method: "DELETE" }),
  render: (botId: string, videoId: string) =>
    call<{ video: VideoRecord; render: VideoRender }>(`${one(botId, videoId)}/renders`, json("POST", {})),
  renderStatus: (botId: string, videoId: string, renderId: string) =>
    call<{ render: VideoRender }>(`${one(botId, videoId)}/renders/${renderId}?status=1`).then(r => r.render),
  cancelRender: (botId: string, videoId: string, renderId: string) =>
    call<{ video?: VideoRecord }>(`${one(botId, videoId)}/renders/${renderId}/cancel`, json("POST", {})),
  restore: (botId: string, videoId: string, versionId: string) =>
    call<{ video: VideoRecord }>(`${one(botId, videoId)}/versions/${versionId}/restore`, json("POST", {})).then(r => r.video),

  /** Streams the file as the request body; progress is 0..1 of bytes sent. */
  upload: (botId: string, videoId: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal) =>
    new Promise<{ video: VideoRecord; media: VideoMedia }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${one(botId, videoId)}/media?name=${encodeURIComponent(file.name)}`);
      if (file.type) xhr.setRequestHeader("content-type", file.type);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        let body: { error?: string; video?: VideoRecord; media?: VideoMedia } = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
        if (xhr.status >= 200 && xhr.status < 300 && body.video && body.media) resolve({ video: body.video, media: body.media });
        else reject(new VideoApiError(body.error ?? `upload failed (${xhr.status})`, xhr.status, body.video));
      };
      xhr.onerror = () => reject(new VideoApiError("upload failed: network error", 0));
      xhr.onabort = () => reject(new VideoApiError("upload cancelled", 0));
      signal?.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(file);
    }),

  mediaUrl: (botId: string, videoId: string, media: PlayableMedia, playback = true) =>
    `${one(botId, videoId)}/media/${media.id}${playback && media.proxy ? "/proxy" : ""}`,
  thumbsUrl: (botId: string, videoId: string, mediaId: string) => `${one(botId, videoId)}/thumbs/${mediaId}.jpg`,
  peaksUrl: (botId: string, videoId: string, mediaId: string) => `${one(botId, videoId)}/peaks/${mediaId}.json`,
  renderUrl: (botId: string, videoId: string, renderId: string, download = false) =>
    `${one(botId, videoId)}/renders/${renderId}${download ? "?download=1" : ""}`,
};

const peaksCache = new Map<string, Promise<number[]>>();
/** Waveform peaks (0..1 per sample), fetched once per media file. */
export function loadPeaks(url: string): Promise<number[]> {
  let hit = peaksCache.get(url);
  if (!hit) {
    hit = fetch(url).then(r => (r.ok ? r.json() : [])).then(v => (Array.isArray(v) ? v : Array.isArray(v?.peaks) ? v.peaks : []))
      .catch(() => []);
    peaksCache.set(url, hit);
  }
  return hit;
}

/** Fired by the store when the server says a video changed. */
export interface VideoChangedDetail { botId: string; videoId: string; revision: number; byKind: "human" | "bot"; deleted?: boolean; render?: VideoRender }
export const VIDEO_CHANGED_EVENT = "bos-video-changed";
