import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeFilmstrip, makePeaks, mediaTool, probeMedia, proxyNeeded, runTool } from "./video-probe.ts";
import { atempoChain, buildRenderGraph, drawtextText, ffColor, filterValue, magickText, renderSnapshot, runRender, textEngine } from "./video-render.ts";
import type { VideoMedia, VideoTimeline } from "../shared/video.ts";

const ffmpeg = mediaTool("ffmpeg");
const ffprobe = mediaTool("ffprobe");
const haveTools = Boolean(ffmpeg && ffprobe);

describe("render helpers", () => {
  it("escapes filter values and text for both text engines", () => {
    expect(filterValue("a:b,c'd")).not.toMatch(/(^|[^\\]):/);
    expect(drawtextText("50% off: it's")).toContain("50");
    expect(magickText("@secret")).not.toMatch(/^@/);
    expect(magickText("100% \\ done")).toBe("100%% \\\\ done");
  });

  it("maps colours with alpha and chains atempo within its range", () => {
    expect(ffColor("#ff0000")).toBe("0xff0000");
    expect(ffColor("#00000080")).toBe("0x000000@0.501961");
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(2)).toEqual(["atempo=2"]);
    const slow = atempoChain(0.25);
    expect(slow.length).toBeGreaterThan(1);
    expect(slow.map(s => Number(s.split("=")[1])).reduce((a, b) => a * b, 1)).toBeCloseTo(0.25, 5);
  });
});

describe.skipIf(!haveTools)("ffmpeg render", () => {
  let dir = "";
  const media: VideoMedia[] = [];
  const author = { kind: "human" as const, id: "u", name: "Owner" };
  const probeDuration = async (file: string) => {
    const out = await runTool(ffprobe!, ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", file]);
    return JSON.parse(out.stdout.toString()) as { format: { duration: string }; streams: Array<{ codec_name: string; codec_type: string; width?: number; height?: number }> };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "video-render-test-"));
    const gen = (args: string[]) => runTool(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    await gen(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "a.mp4")]);
    await gen(["-f", "lavfi", "-i", "testsrc2=size=180x320:rate=25:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "b.mp4")]);
    await gen(["-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-c:a", "libmp3lame", join(dir, "c.mp3")]);
    await gen(["-f", "lavfi", "-i", "color=c=red:size=200x120", "-frames:v", "1", join(dir, "d.png")]);
    for (const [id, file] of [["m-aaaaaa", "a.mp4"], ["m-bbbbbb", "b.mp4"], ["m-cccccc", "c.mp3"], ["m-dddddd", "d.png"]] as const) {
      const probe = await probeMedia(join(dir, file));
      media.push({ id, name: file, file, kind: probe.kind, duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio, bytes: 1, addedAt: 0, addedBy: author });
    }
  }, 60_000);

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("probes video, audio and still images", () => {
    expect(media.map(m => m.kind)).toEqual(["video", "video", "audio", "image"]);
    expect(media[0]).toMatchObject({ width: 320, height: 180, hasAudio: true });
    expect(media[0].duration).toBeCloseTo(2, 1);
    expect(media[1]).toMatchObject({ width: 180, height: 320, hasAudio: false });
    expect(media[2].duration).toBeCloseTo(4, 1);
    expect(media[3].duration).toBe(0);
  });

  it("makes a filmstrip sprite and waveform peaks", async () => {
    const strip = await makeFilmstrip(join(dir, "b.mp4"), join(dir, "b.jpg"), media[1]);
    expect(strip).toMatchObject({ every: 1, count: 3, width: 160 });
    expect(existsSync(join(dir, "b.jpg"))).toBe(true);
    const peaks = await makePeaks(join(dir, "a.mp4"), join(dir, "a.json"));
    expect(peaks.perSecond).toBe(50);
    expect(peaks.count).toBeGreaterThanOrEqual(95);
    expect(proxyNeeded(await probeMedia(join(dir, "a.mp4")))).toBeNull();
  });

  const timeline = (withText: boolean): VideoTimeline => ({
    width: 320, height: 180, fps: 30, background: "#202020",
    tracks: [
      { id: "t-v1", kind: "video", clips: [
        { id: "c-1", start: 0, duration: 2, mediaId: "m-aaaaaa", in: 0, fadeIn: 0.5 },
        { id: "c-2", start: 2, duration: 1.5, mediaId: "m-bbbbbb", in: 0, speed: 2, fit: "cover" },
        { id: "c-3", start: 3.5, duration: 1, mediaId: "m-dddddd", in: 0, fadeOut: 0.5 },
      ] },
      { id: "t-t1", kind: "text", clips: withText ? [
        { id: "c-4", start: 0.5, duration: 3, text: "It's 50% off: [now], \"yes\"; \\ back\nline two @x", style: { background: "#000000aa", y: 0.2 } },
      ] : [] },
      { id: "t-a1", kind: "audio", clips: [{ id: "c-5", start: 1, duration: 3, mediaId: "m-cccccc", in: 0.5, volume: 0.5, fadeOut: 1 }] },
    ],
  });

  it("renders a multi-track timeline (speed 2, image, text, audio) to the timeline's length", async () => {
    const text = await textEngine();
    const graph = await buildRenderGraph(timeline(Boolean(text)), media, { mediaPath: m => join(dir, m.file), workDir: join(dir, "work"), audio: true, text });
    expect(graph.duration).toBeCloseTo(4.5, 3);
    const progress: number[] = [];
    const out = join(dir, "out.mp4");
    await runRender(graph, out, p => progress.push(p), { fps: 30 }).done;
    const info = await probeDuration(out);
    expect(Number(info.format.duration)).toBeCloseTo(4.5, 1);
    expect(info.streams.find(s => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 320, height: 180 });
    expect(info.streams.find(s => s.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(p => p >= 0 && p <= 1)).toBe(true);
  }, 120_000);

  it("refuses text clips when no text engine exists, and empty timelines", async () => {
    await expect(buildRenderGraph(timeline(true), media, { mediaPath: m => join(dir, m.file), workDir: join(dir, "work2"), audio: true, text: null })).rejects.toMatchObject({ status: 503 });
    const empty: VideoTimeline = { width: 320, height: 180, fps: 30, background: "#000000", tracks: [{ id: "t-v1", kind: "video", clips: [] }] };
    await expect(buildRenderGraph(empty, media, { mediaPath: m => join(dir, m.file), workDir: join(dir, "work3"), audio: true, text: null })).rejects.toMatchObject({ status: 400 });
  });

  it("cancels a running render", async () => {
    const long: VideoTimeline = { width: 320, height: 180, fps: 30, background: "#000000", tracks: [{ id: "t-v1", kind: "video", clips: [
      { id: "c-1", start: 0, duration: 600, mediaId: "m-dddddd", in: 0 },
    ] }] };
    const graph = await buildRenderGraph(long, media, { mediaPath: m => join(dir, m.file), workDir: join(dir, "work4"), audio: true, text: null });
    const run = runRender(graph, join(dir, "long.mp4"), () => {}, { fps: 30 });
    setTimeout(() => run.cancel(), 300);
    await expect(run.done).rejects.toMatchObject({ status: 499 });
  }, 60_000);

  it("snapshots one frame of the composite", async () => {
    const text = await textEngine();
    const out = join(dir, "snap.jpg");
    await renderSnapshot(timeline(Boolean(text)), media, 1, out, { mediaPath: m => join(dir, m.file), workDir: join(dir, "snapwork"), text, maxSide: 240 });
    const info = await probeDuration(out);
    expect(info.streams[0]).toMatchObject({ codec_name: "mjpeg", width: 240, height: 136 });
  }, 60_000);
});
