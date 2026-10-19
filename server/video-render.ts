// The video renderer: one ffmpeg run per render, its whole timeline in a
// single filter graph. A colour canvas runs the full length; every visible
// clip is seeked at the input (fast), retimed to its place on the timeline,
// framed (cover = fill and crop, contain = fit inside), faded through alpha
// and overlaid bottom track first. Text is drawn with drawtext when this
// ffmpeg has it, otherwise rasterised to a transparent PNG by ImageMagick and
// overlaid like an image. Audio is each clip's own sound (or an audio-track
// clip), retimed, faded, delayed to its start and mixed without normalising.
//
// The same graph over a short window gives the bot a single still frame of
// the edit (video_snapshot), so what it sees is what the render will show.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ffmpegError, ffmpegHasDrawtext, mediaTool, requireTool, runTool } from "./video-probe.ts";
import {
  TEXT_STYLE_DEFAULTS, clipEnd, clipFit, clipSpeed, timelineDuration,
  type VideoClip, type VideoMedia, type VideoTextStyle, type VideoTimeline,
} from "../shared/video.ts";

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };

export type TextEngine = "drawtext" | "magick";

/** drawtext when this ffmpeg has it, else ImageMagick, else null (text cannot be drawn). */
export async function textEngine(): Promise<TextEngine | null> {
  if (await ffmpegHasDrawtext()) return "drawtext";
  return mediaTool("magick") ? "magick" : null;
}

const FONT_CANDIDATES: Record<400 | 600 | 800, string[]> = {
  400: ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf", "C:\\Windows\\Fonts\\arial.ttf"],
  600: ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"],
  800: ["/System/Library/Fonts/Supplemental/Arial Black.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "C:\\Windows\\Fonts\\ariblk.ttf"],
};
export function fontFile(weight: 400 | 600 | 800): string | undefined {
  return FONT_CANDIDATES[weight].find(path => existsSync(path));
}

// ---------- escaping ----------

/** A value for one filter option: first escaped for the option parser
 * (\ ' :), then for the filtergraph parser (\ ' [ ] , ;). See
 * "Notes on filtergraph escaping" in ffmpeg-filters(1). */
export function filterValue(value: string): string {
  const option = value.replace(/[\\':]/g, ch => `\\${ch}`);
  return option.replace(/[\\'[\],;]/g, ch => `\\${ch}`);
}

/** Text for drawtext with expansion off: escaped like any option value.
 * Newlines stay literal, which drawtext breaks lines on. */
export function drawtextText(text: string): string {
  return filterValue(text.replace(/\r\n?/g, "\n"));
}

/** Text for an ImageMagick caption: no @file reads, no %-escapes. */
export function magickText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/^@/, "\\@");
}

const num = (n: number) => String(Math.round(n * 1_000_000) / 1_000_000);
/** #rrggbb(aa) → 0xRRGGBB@alpha for ffmpeg colours. */
export function ffColor(hex: string): string {
  const h = hex.replace("#", "");
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return `0x${h.slice(0, 6)}${alpha < 1 ? `@${num(alpha)}` : ""}`;
}

export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s < 0.5) { out.push("atempo=0.5"); s /= 0.5; }
  while (s > 100) { out.push("atempo=100"); s /= 100; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${num(s)}`);
  return out;
}

// ---------- the graph ----------

export interface GraphOptions {
  /** Absolute path of a media file to read (the original, never the proxy). */
  mediaPath: (media: VideoMedia) => string;
  /** Scratch folder for text images. */
  workDir: string;
  /** Only part of the timeline (seconds). Defaults to the whole of it. */
  window?: { from: number; to: number };
  audio: boolean;
  text: TextEngine | null;
  /** Scale the result to fit this many pixels on the long side (snapshots). */
  maxSide?: number;
}

export interface RenderGraph {
  /** Input arguments, in input order. */
  inputs: string[];
  filter: string;
  video: string;
  audio?: string;
  /** Seconds the graph produces. */
  duration: number;
  from: number;
}

const style = (clip: VideoClip): Required<VideoTextStyle> => ({ ...TEXT_STYLE_DEFAULTS, ...clip.style });

/** Renders a text clip's look (with its box) to a transparent PNG sized to
 * the text, at most 90% of the frame wide; long lines wrap. */
async function magickTextImage(clip: VideoClip, timeline: VideoTimeline, out: string): Promise<void> {
  const s = style(clip);
  const px = Math.max(8, Math.round(s.size * timeline.height));
  const font = fontFile(s.weight);
  const gravity = s.align === "left" ? "West" : s.align === "right" ? "East" : "Center";
  const padX = Math.round(px * 0.45), padY = Math.round(px * 0.25);
  const args = [
    "-background", "none", "-fill", s.color, ...(font ? ["-font", font] : []), "-pointsize", String(px),
    "-size", `${Math.round(timeline.width * 0.9)}x`, "-gravity", gravity, `caption:${magickText(clip.text ?? "")}`,
    "-trim", "+repage",
    ...(s.background ? ["-bordercolor", "none", "-border", `${padX}x${padY}`, "-background", s.background, "-flatten"] : ["-bordercolor", "none", "-border", "2x2"]),
    `PNG32:${out}`,
  ];
  await mkdir(dirname(out), { recursive: true });
  const result = await runTool(mediaTool("magick")!, args);
  if (result.code !== 0 || !existsSync(out)) fail(500, `could not draw text "${(clip.text ?? "").slice(0, 40)}": ${ffmpegError(result.stderr)}`);
}

function drawtextFilter(clip: VideoClip, timeline: VideoTimeline, vs: number, ve: number): string {
  const s = style(clip);
  const px = Math.max(8, Math.round(s.size * timeline.height));
  const font = fontFile(s.weight);
  const start = clip.start, end = clipEnd(clip);
  const fi = clip.fadeIn ?? 0, fo = clip.fadeOut ?? 0;
  const alpha = fi || fo
    ? `min(1\\,min(${fi ? `(t-${num(start)})/${num(fi)}` : "1"}\\,${fo ? `(${num(end)}-t)/${num(fo)}` : "1"}))`
    : "1";
  const parts = [
    ...(font ? [`fontfile=${filterValue(font)}`] : []),
    "expansion=none", `text=${drawtextText(clip.text ?? "")}`, `fontsize=${px}`, `fontcolor=${ffColor(s.color)}`,
    `text_align=${s.align === "left" ? "L" : s.align === "right" ? "R" : "C"}`, `line_spacing=${Math.round(px * 0.2)}`,
    `x=max(0\\,min(w-text_w\\,w*${num(s.x)}-text_w/2))`, `y=max(0\\,min(h-text_h\\,h*${num(s.y)}-text_h/2))`,
    ...(s.background ? ["box=1", `boxcolor=${ffColor(s.background)}`, `boxborderw=${Math.round(px * 0.35)}`] : []),
    `alpha='${alpha}'`, `enable='between(t,${num(vs)},${num(ve)})'`,
  ];
  return `drawtext=${parts.join(":")}`;
}

/** Builds inputs and one filter graph for the timeline (or a window of it). */
export async function buildRenderGraph(timeline: VideoTimeline, media: VideoMedia[], options: GraphOptions): Promise<RenderGraph> {
  const W = timeline.width, H = timeline.height, FPS = timeline.fps;
  const snap = (t: number) => Math.round(t * FPS) / FPS;
  const total = snap(timelineDuration(timeline));
  const from = options.window ? snap(options.window.from) : 0;
  const to = options.window ? options.window.to : total;
  const length = to - from;
  if (!(length > 0)) fail(400, "the timeline is empty; add clips before rendering");
  const byId = new Map(media.map(m => [m.id, m]));
  const inputs: string[] = [];
  const chains: string[] = [];
  const audioLabels: string[] = [];
  let inputCount = 0;
  const addInput = (args: string[]) => { inputs.push(...args); return inputCount++; };

  chains.push(`color=c=${ffColor(timeline.background)}:s=${W}x${H}:r=${FPS}:d=${num(length + 1 / FPS)},format=yuv420p${from ? `,setpts=PTS+${num(from)}/TB` : ""}[base]`);
  let current = "base";
  let step = 0;
  const textClips = timeline.tracks.some(t => t.kind === "text" && !t.hidden && t.clips.some(c => c.text?.trim()));
  if (textClips && !options.text) fail(503, "this computer cannot draw text: install ImageMagick (`brew install imagemagick`) or an ffmpeg built with drawtext");

  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const s = snap(clip.start), e = snap(clipEnd(clip));
      const vs = Math.max(s, from), ve = Math.min(e, to);
      if (!(ve > vs)) continue;
      const fi = clip.fadeIn ?? 0, fo = clip.fadeOut ?? 0;
      const fades = [
        ...(fi ? [`fade=t=in:st=${num(s)}:d=${num(fi)}:alpha=1`] : []),
        ...(fo ? [`fade=t=out:st=${num(e - fo)}:d=${num(fo)}:alpha=1`] : []),
      ];
      const overlay = (label: string, x = "(W-w)/2", y = "(H-h)/2") => {
        const next = `v${++step}`;
        chains.push(`[${current}][${label}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${num(vs)},${num(ve - 0.5 / FPS)})'[${next}]`);
        current = next;
      };

      if (track.kind === "text") {
        if (track.hidden || !clip.text?.trim()) continue;
        if (options.text === "drawtext") {
          const next = `v${++step}`;
          chains.push(`[${current}]${drawtextFilter(clip, timeline, vs, ve)}[${next}]`);
          current = next;
          continue;
        }
        const png = join(options.workDir, `${clip.id}.png`);
        await magickTextImage(clip, timeline, png);
        const index = addInput(["-loop", "1", "-framerate", String(FPS), "-t", num(ve - vs + 2 / FPS), "-i", png]);
        chains.push(`[${index}:v]setpts=PTS-STARTPTS+${num(vs)}/TB,format=yuva420p${fades.length ? `,${fades.join(",")}` : ""}[t${index}]`);
        const st = style(clip);
        overlay(`t${index}`, `'max(0,min(W-w,W*${num(st.x)}-w/2))'`, `'max(0,min(H-h,H*${num(st.y)}-h/2))'`);
        continue;
      }

      const m = clip.mediaId ? byId.get(clip.mediaId) : undefined;
      if (!m) continue;
      const speed = clipSpeed(clip);
      const wantsVideo = track.kind === "video" && !track.hidden && m.kind !== "audio";
      const wantsAudio = options.audio && !track.muted && !(track.kind === "audio" && track.hidden)
        && m.kind !== "image" && m.hasAudio !== false && (clip.volume ?? 1) > 0;
      if (!wantsVideo && !wantsAudio) continue;
      const path = options.mediaPath(m);
      const index = m.kind === "image"
        ? addInput(["-loop", "1", "-framerate", String(FPS), "-t", num(ve - vs + 2 / FPS), "-i", path])
        : addInput(["-ss", num((clip.in ?? 0) + (vs - s) * speed), "-t", num((ve - vs) * speed + 0.25), "-i", path]);

      if (wantsVideo) {
        const frame = clipFit(clip) === "cover"
          ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
          : `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
        const timing = m.kind === "image"
          ? `setpts=PTS-STARTPTS+${num(vs)}/TB`
          : `setpts=(PTS-STARTPTS)/${num(speed)}+${num(vs)}/TB,fps=${FPS},tpad=stop_mode=clone:stop_duration=${num(0.5)},trim=end=${num(ve)}`;
        chains.push(`[${index}:v]${timing},${frame},setsar=1,format=yuva420p${fades.length ? `,${fades.join(",")}` : ""}[c${index}]`);
        overlay(`c${index}`);
      }
      if (wantsAudio) {
        const dur = ve - vs;
        const parts = [
          "asetpts=PTS-STARTPTS", ...atempoChain(speed),
          "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
          "apad", `atrim=end=${num(dur)}`,
          ...((clip.volume ?? 1) !== 1 ? [`volume=${num(clip.volume!)}`] : []),
          ...(fi && vs === s ? [`afade=t=in:st=0:d=${num(Math.min(fi, dur))}`] : []),
          ...(fo ? [`afade=t=out:st=${num(Math.max(0, e - fo - vs))}:d=${num(fo)}`] : []),
          `adelay=${Math.round((vs - from) * 1000)}:all=1`,
        ];
        chains.push(`[${index}:a]${parts.join(",")}[a${index}]`);
        audioLabels.push(`a${index}`);
      }
    }
  }

  const scale = options.maxSide && Math.max(W, H) > options.maxSide
    ? `,scale=${W >= H ? options.maxSide : -2}:${W >= H ? -2 : options.maxSide}`
    : "";
  chains.push(`[${current}]trim=end=${num(to)},format=yuv420p${scale}[vout]`);
  let audio: string | undefined;
  if (options.audio) {
    chains.push(`anullsrc=r=48000:cl=stereo:d=${num(length)}[asil]`);
    chains.push(audioLabels.length
      ? `[asil]${audioLabels.map(l => `[${l}]`).join("")}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0:dropout_transition=0[aout]`
      : "[asil]anull[aout]");
    audio = "aout";
  }
  return { inputs, filter: chains.join(";\n"), video: "vout", audio, duration: length, from };
}

// ---------- running ----------

export interface RenderRun {
  done: Promise<void>;
  cancel: () => void;
}

/** Starts an mp4 render of a built graph. `onProgress` gets 0..1. */
export function runRender(graph: RenderGraph, out: string, onProgress: (progress: number) => void, options: { fps: number }): RenderRun {
  const controller = new AbortController();
  const args = [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
    ...graph.inputs, "-filter_complex", graph.filter,
    "-map", `[${graph.video}]`, ...(graph.audio ? ["-map", `[${graph.audio}]`] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(options.fps),
    ...(graph.audio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
    "-movflags", "+faststart", "-t", num(graph.duration), "-f", "mp4", out,
  ];
  let buffer = "";
  const done = runTool(requireTool("ffmpeg"), args, {
    signal: controller.signal,
    onStdout: chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^out_time_(us|ms)=(\d+)/.exec(line.trim());
        if (m) onProgress(Math.max(0, Math.min(1, Number(m[2]) / 1_000_000 / graph.duration)));
      }
    },
  }).then(result => {
    if (controller.signal.aborted) fail(499, "cancelled");
    if (result.code !== 0) fail(500, ffmpegError(result.stderr));
  }, error => {
    if (controller.signal.aborted || (error as Error).name === "AbortError") fail(499, "cancelled");
    throw error;
  });
  return { done, cancel: () => controller.abort() };
}

/** One still frame of the edit at timeline time `t`, as a jpg. */
export async function renderSnapshot(timeline: VideoTimeline, media: VideoMedia[], t: number, out: string, options: Omit<GraphOptions, "window" | "audio">): Promise<void> {
  const total = timelineDuration(timeline);
  const at = Math.max(0, Math.min(t, Math.max(0, total - 0.5 / timeline.fps)));
  await mkdir(options.workDir, { recursive: true });
  const graph = await buildRenderGraph(timeline, media, { ...options, window: { from: at, to: at + 1 / timeline.fps }, audio: false });
  const result = await runTool(requireTool("ffmpeg"), [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...graph.inputs, "-filter_complex", graph.filter,
    "-map", `[${graph.video}]`, "-frames:v", "1", "-q:v", "3", "-update", "1", out,
  ]);
  if (result.code !== 0 || !existsSync(out)) fail(500, `could not draw the frame: ${ffmpegError(result.stderr)}`);
}
