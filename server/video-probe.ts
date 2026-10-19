// ffmpeg/ffprobe helpers for videos: finding the binaries (an app started
// from the Finder has a bare PATH, so the usual install folders are checked
// too), probing an imported file, and the derived files the editor draws
// with — a filmstrip sprite, waveform peaks, and a browser-playable proxy.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { VideoMediaKind } from "../shared/video.ts";
import { augmentedPath } from "./env-path.ts";

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };

const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"];
const found = new Map<string, string | null>();

/** Absolute path of a media tool, or null. BOSBOT_FFMPEG / BOSBOT_FFPROBE
 * override the search (tests and unusual installs). */
export function mediaTool(name: "ffmpeg" | "ffprobe" | "magick"): string | null {
  const override = process.env[`BOSBOT_${name.toUpperCase()}`];
  if (override) return existsSync(override) ? override : null;
  if (found.has(name)) return found.get(name)!;
  // augmentedPath() adds ~/.local/bin and the other user install folders a
  // Finder-launched app never inherits. Misses aren't cached, so installing
  // ffmpeg later works without a restart.
  const dirs = [...augmentedPath().split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const hit = dirs.map(dir => join(dir, exe)).find(path => existsSync(path)) ?? null;
  if (hit) found.set(name, hit);
  return hit;
}

export function requireTool(name: "ffmpeg" | "ffprobe"): string {
  return mediaTool(name) ?? fail(503, `${name} is not installed on this computer; install ffmpeg (for example \`brew install ffmpeg\`) to edit videos`);
}

export interface RunResult { code: number | null; stdout: Buffer; stderr: string }

/** Runs a tool to completion, keeping at most `maxStdout` bytes of output and the stderr tail. */
export function runTool(bin: string, args: string[], options: { maxStdout?: number; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal: options.signal, killSignal: "SIGKILL" });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdout) return options.onStdout(chunk);
      if (outBytes < (options.maxStdout ?? 4_000_000)) { out.push(chunk); outBytes += chunk.length; }
    });
    child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(-8000); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
  });
}

/** The last meaningful ffmpeg error line, for a person to read. */
export function ffmpegError(stderr: string): string {
  const lines = stderr.split("\n").map(l => l.trim()).filter(Boolean);
  return (lines.reverse().find(l => /error|invalid|no such|not found|unable|cannot|failed/i.test(l)) ?? lines[0] ?? "ffmpeg failed").slice(0, 300);
}

export interface MediaProbe {
  kind: VideoMediaKind;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  format: string;
}

const MEDIA_FORMATS = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "avi", "mp3", "wav", "w64", "ogg", "flac", "aac", "aiff", "caf", "mpegts", "mpeg", "image2", "gif", "heif", "webp"]);
const IMAGE_FORMAT_RE = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|heif|gif_pipe|jpegxl_pipe|svg_pipe)(,|$)/;
const STILL_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "tiff", "heif", "hevc_image", "jpegxl", "svg"]);

function rate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [n, d] = value.split("/").map(Number);
  const fps = d ? n! / d : n!;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : undefined;
}

/** Reads streams with ffprobe. Refuses files with no picture or sound. */
export async function probeMedia(path: string): Promise<MediaProbe> {
  const result = await runTool(requireTool("ffprobe"), ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]);
  if (result.code !== 0) fail(415, `not a readable video, audio or image file (${ffmpegError(result.stderr)})`);
  let info: { format?: Record<string, any>; streams?: Record<string, any>[] };
  try { info = JSON.parse(result.stdout.toString("utf8")); } catch { return fail(415, "not a readable video, audio or image file"); }
  const streams = info.streams ?? [];
  const format = String(info.format?.format_name ?? "");
  // Only real media containers: raw, text (tty), playlist and concat demuxers can read other files.
  if (!format.split(",").some(name => MEDIA_FORMATS.has(name) || /^[a-z0-9]+_pipe$/.test(name) && name !== "svg_pipe")) fail(415, `not a video, audio or image file (${format || "unknown format"})`);
  const video = streams.find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find(s => s.codec_type === "audio");
  if (!video && !audio) fail(415, "the file has no video or audio stream");
  const formatDuration = Number(info.format?.duration);
  const streamDuration = Number(video?.duration ?? audio?.duration);
  const duration = Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : 0;
  const frames = Number(video?.nb_frames);
  const still = Boolean(video) && !audio && (IMAGE_FORMAT_RE.test(format) || (STILL_CODECS.has(String(video!.codec_name)) && (!(duration > 0) || frames === 1)));
  const kind: VideoMediaKind = still ? "image" : video ? "video" : "audio";
  let width = Number(video?.width) || undefined;
  let height = Number(video?.height) || undefined;
  const rotation = Number(video?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  if (width && height && Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    kind, duration: kind === "image" ? 0 : Math.round(duration * 1000) / 1000, width, height,
    fps: kind === "video" ? rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate) : undefined,
    hasAudio: Boolean(audio), videoCodec: video?.codec_name, audioCodec: audio?.codec_name, format,
  };
}

const PLAYABLE_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const PLAYABLE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const PLAYABLE_IMAGE = new Set(["png", "mjpeg", "webp", "gif"]);

/** What kind of proxy the editor needs for this file, or null when Chromium plays it as is. */
export function proxyNeeded(probe: MediaProbe): "mp4" | "m4a" | "jpg" | null {
  if (probe.kind === "image") return PLAYABLE_IMAGE.has(String(probe.videoCodec)) ? null : "jpg";
  const container = /mp4|mov|matroska|webm/.test(probe.format) ? "mp4" : /^(mp3|ogg|flac|wav|aac)$/.test(probe.format) ? "audio" : "other";
  if (probe.kind === "audio") {
    const codec = String(probe.audioCodec);
    if (container === "audio" && (PLAYABLE_AUDIO.has(codec) || codec.startsWith("pcm_"))) return null;
    if (container === "mp4" && PLAYABLE_AUDIO.has(codec)) return null;
    return "m4a";
  }
  if (container !== "mp4") return "mp4";
  if (!PLAYABLE_VIDEO.has(String(probe.videoCodec))) return "mp4";
  if (probe.hasAudio && !PLAYABLE_AUDIO.has(String(probe.audioCodec))) return "mp4";
  return null;
}

/** Makes the proxy file; the caller records its name on the media item. */
export async function makeProxy(source: string, out: string, kind: "mp4" | "m4a" | "jpg", signal?: AbortSignal): Promise<void> {
  const args = kind === "jpg"
    ? ["-i", source, "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", "-q:v", "3"]
    : kind === "m4a"
      ? ["-i", source, "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
      // 720p on the short side keeps scrubbing light; every frame a keyframe-ish GOP for seeking.
      : ["-i", source, "-vf", "scale='trunc(iw*min(1,720/min(iw,ih))/2)*2':'trunc(ih*min(1,720/min(iw,ih))/2)*2',format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "30", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart"];
  const result = await runTool(requireTool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { signal });
  if (result.code !== 0) fail(500, `could not make a playable copy: ${ffmpegError(result.stderr)}`);
}

export const THUMB_WIDTH = 160;
const THUMB_COLUMNS = 10;
const MAX_THUMBS = 120;

/** Filmstrip sprite: one 160px-wide frame every `every` seconds, tiled
 * left-to-right, top-to-bottom, THUMB_COLUMNS per row. Frame i shows source time i*every. */
export async function makeFilmstrip(source: string, out: string, probe: Pick<MediaProbe, "kind" | "duration" | "width" | "height">, signal?: AbortSignal) {
  const width = THUMB_WIDTH;
  const height = Math.max(2, Math.round((width * (probe.height || 9)) / (probe.width || 16) / 2) * 2);
  const still = probe.kind === "image" || !(probe.duration > 0);
  const every = still ? 0 : Math.max(1, Math.ceil(probe.duration / MAX_THUMBS));
  const count = still ? 1 : Math.max(1, Math.ceil(probe.duration / every));
  const columns = Math.min(THUMB_COLUMNS, count);
  const rows = Math.ceil(count / columns);
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const vf = still ? scale : `fps=1/${every}:round=down,${scale},tile=${columns}x${rows}`;
  const result = await runTool(requireTool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-an", "-vf", vf, "-frames:v", "1", "-q:v", "5", out], { signal });
  if (result.code !== 0) fail(500, `could not make the filmstrip: ${ffmpegError(result.stderr)}`);
  return { every, count, width, height, columns };
}

export const PEAKS_PER_SECOND = 50;
const PEAK_RATE = 8000;

/** Waveform peaks: mono, PEAKS_PER_SECOND buckets per second, each the max
 * absolute sample scaled to 0..1. Written as JSON `{ perSecond, duration, peaks }`. */
export async function makePeaks(source: string, out: string, signal?: AbortSignal): Promise<{ perSecond: number; count: number }> {
  const bucket = PEAK_RATE / PEAKS_PER_SECOND;
  const peaks: number[] = [];
  let current = 0, filled = 0;
  let carry: Buffer | null = null;
  const result = await runTool(requireTool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-i", source, "-vn", "-ac", "1", "-ar", String(PEAK_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], {
    signal,
    onStdout: chunk => {
      const data = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = data.length - (data.length % 2);
      carry = usable < data.length ? data.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(data.readInt16LE(i));
        if (v > current) current = v;
        if (++filled === bucket) { peaks.push(current); current = 0; filled = 0; }
      }
    },
  });
  if (result.code !== 0) fail(500, `could not read the audio: ${ffmpegError(result.stderr)}`);
  if (filled) peaks.push(current);
  const max = 32768;
  const scaled = peaks.map(p => Math.round((p / max) * 1000) / 1000);
  await writeFile(out, JSON.stringify({ perSecond: PEAKS_PER_SECOND, duration: scaled.length / PEAKS_PER_SECOND, peaks: scaled }), { mode: 0o600 });
  return { perSecond: PEAKS_PER_SECOND, count: scaled.length };
}

let drawtextSupport: Promise<boolean> | null = null;
/** Homebrew's plain `ffmpeg` (8.x) is built without freetype, so drawtext
 * is often missing; the renderer then rasterises text with ImageMagick. */
export function ffmpegHasDrawtext(): Promise<boolean> {
  drawtextSupport ??= (async () => {
    const bin = mediaTool("ffmpeg");
    if (!bin) return false;
    const result = await runTool(bin, ["-hide_banner", "-filters"]).catch(() => null);
    return Boolean(result && /\bdrawtext\b/.test(result.stdout.toString("utf8")));
  })();
  return drawtextSupport;
}
