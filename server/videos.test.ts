import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { VideoStore, type VideoChange } from "./videos.ts";
import { mediaTool, runTool } from "./video-probe.ts";
import { VIDEO_LIMITS } from "../shared/video.ts";

const owner = { kind: "human" as const, id: "owner", name: "Owner" };
const bot = { kind: "bot" as const, id: "b1", name: "Editor" };
const haveTools = Boolean(mediaTool("ffmpeg") && mediaTool("ffprobe"));

let root = "";
let now = 1_000_000;
let changes: VideoChange[] = [];
let store: VideoStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "videos-test-"));
  now = 1_000_000;
  changes = [];
  store = new VideoStore({ root: botId => join(root, botId, "videos"), now: () => now, onChange: c => changes.push(c), text: async () => null });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("VideoStore documents", () => {
  it("creates, lists, reads and broadcasts", () => {
    const video = store.create("b1", { title: "  Launch   teaser ", size: "landscape", threadId: "th1" }, owner);
    expect(video).toMatchObject({ title: "Launch teaser", threadId: "th1", revision: 1, media: [], renders: [], versions: [] });
    expect(video.timeline).toMatchObject({ width: 1920, height: 1080 });
    expect(changes.at(-1)).toMatchObject({ botId: "b1", videoId: video.id, revision: 1, by: owner });
    expect(store.list("b1").map(v => v.id)).toEqual([video.id]);
    expect(store.list("b1", { query: "teaser" })).toHaveLength(1);
    expect(store.list("b1", { query: "nope" })).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(root, "b1", "videos", video.id, "project.json"), "utf8")).id).toBe(video.id);
    expect(() => store.create("b1", { size: "huge" }, owner)).toThrow(/size must be/);
    expect(() => store.get("b1", "v-missing00")).toThrow(/no such video/);
  });

  it("refuses a stale save with the current record", () => {
    const video = store.create("b1", {}, owner);
    const t = structuredClone(video.timeline);
    t.background = "#112233";
    const saved = store.save("b1", video.id, { baseRevision: 1, timeline: t }, owner);
    expect(saved.revision).toBe(2);
    let error: (Error & { status?: number; video?: { revision: number } }) | undefined;
    try { store.save("b1", video.id, { baseRevision: 1, timeline: t }, owner); } catch (e) { error = e as typeof error; }
    expect(error?.status).toBe(409);
    expect(error?.video?.revision).toBe(2);
    t.tracks[0].clips.push({ id: "c-zzzz", start: 0, duration: 1, mediaId: "m-nothere" });
    expect(() => store.save("b1", video.id, { baseRevision: 2, timeline: t }, owner)).toThrow();
  });

  it("applies edit ops, coalesces human checkpoints and keeps one per bot edit", () => {
    const video = store.create("b1", {}, owner);
    const textTrack = video.timeline.tracks.find(t => t.kind === "text")!.id;
    const first = store.edit("b1", video.id, [{ op: "add_clip", track_id: textTrack, text: "hello", start: 0, duration: 2 }], owner);
    expect(first.created).toHaveLength(1);
    expect(first.video.versions).toHaveLength(1);
    now += 60_000;
    store.edit("b1", video.id, [{ op: "update_clip", clip_id: first.created[0], text: "hello again" }], owner);
    expect(store.get("b1", video.id).versions).toHaveLength(1); // same person, within ten minutes
    now += 11 * 60_000;
    store.edit("b1", video.id, [{ op: "update_clip", clip_id: first.created[0], duration: 3 }], owner);
    expect(store.get("b1", video.id).versions).toHaveLength(2);
    const rev = store.get("b1", video.id).revision;
    store.edit("b1", video.id, [{ op: "update_clip", clip_id: first.created[0], text: "bot one" }], bot, rev);
    store.edit("b1", video.id, [{ op: "update_clip", clip_id: first.created[0], text: "bot two" }], bot);
    const after = store.get("b1", video.id);
    expect(after.versions).toHaveLength(4);
    expect(() => store.edit("b1", video.id, [{ op: "update_clip", clip_id: first.created[0], text: "x" }], bot, rev)).toThrow(/changed since/);
    expect(() => store.edit("b1", video.id, [{ op: "delete_clip", clip_id: "c-nope" }], bot)).toThrow(/no clip/);

    const version = after.versions.find(v => v.timeline.tracks.some(t => t.clips.some(c => c.text === "bot one")))!;
    const restored = store.restoreVersion("b1", video.id, version.id, owner);
    expect(restored.timeline.tracks.flatMap(t => t.clips).map(c => c.text)).toEqual(["bot one"]);
    expect(restored.versions.at(-1)!.timeline.tracks.flatMap(t => t.clips).map(c => c.text)).toEqual(["bot two"]);
  });

  it("caps versions", () => {
    const video = store.create("b1", {}, owner);
    for (let i = 0; i < VIDEO_LIMITS.versions + 5; i++) {
      const t = store.get("b1", video.id).timeline;
      t.background = `#0000${(i % 256).toString(16).padStart(2, "0")}`;
      store.save("b1", video.id, { baseRevision: store.get("b1", video.id).revision, timeline: t }, bot);
    }
    expect(store.get("b1", video.id).versions).toHaveLength(VIDEO_LIMITS.versions);
  });

  it("trashes, restores, purges after 30 days and destroys", () => {
    const video = store.create("b1", { title: "old" }, owner);
    store.setTrashed("b1", video.id, true, owner);
    expect(store.list("b1")).toHaveLength(0);
    expect(store.list("b1", { trash: true })).toHaveLength(1);
    expect(() => store.edit("b1", video.id, [], owner)).toThrow(/trash/);
    store.setTrashed("b1", video.id, false, owner);
    expect(store.list("b1")).toHaveLength(1);
    store.setTrashed("b1", video.id, true, owner);
    now += 31 * 86_400_000;
    expect(store.list("b1", { trash: true })).toHaveLength(0);
    expect(existsSync(join(root, "b1", "videos", video.id))).toBe(false);
    expect(changes.at(-1)).toMatchObject({ videoId: video.id, deleted: true });

    const other = store.create("b1", {}, owner);
    store.destroy("b1", other.id, owner);
    expect(store.list("b1")).toHaveLength(0);
  });

  it("reloads from disk and marks interrupted renders failed", () => {
    const video = store.create("b1", { title: "persisted" }, owner);
    const file = join(root, "b1", "videos", video.id, "project.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.renders = [{ id: "r-aaaa", status: "running", progress: 0.3, revision: 1, startedAt: now }];
    writeFileSync(file, JSON.stringify(raw));
    const fresh = new VideoStore({ root: botId => join(root, botId, "videos"), now: () => now });
    expect(fresh.get("b1", video.id).renders[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
    expect(fresh.list("b1")[0].title).toBe("persisted");
  });

  it("clears scratch files a stopped app left behind", () => {
    const video = store.create("b1", {}, owner);
    const dir = join(root, "b1", "videos", video.id);
    for (const sub of ["media", "renders"]) mkdirSync(join(dir, sub), { recursive: true });
    const junk = [join(dir, "renders", "r-aaaa.part.mp4"), join(dir, "media", "m-aaaa.proxy-part.mp4"), join(dir, "snap-x.work")];
    for (const f of junk) writeFileSync(f, "x");
    mkdirSync(join(dir, "renders", "r-aaaa.work"));
    writeFileSync(join(dir, "media", "m-keep.mp4"), "x");
    new VideoStore({ root: botId => join(root, botId, "videos"), now: () => now }).list("b1");
    expect(junk.filter(f => existsSync(f))).toEqual([]);
    expect(existsSync(join(dir, "renders", "r-aaaa.work"))).toBe(false);
    expect(readdirSync(join(dir, "media"))).toEqual(["m-keep.mp4"]);
  });
});

describe.skipIf(!haveTools)("VideoStore media and renders", () => {
  let fixtures = "";
  beforeAll(async () => {
    fixtures = mkdtempSync(join(tmpdir(), "videos-fixtures-"));
    const gen = (args: string[]) => runTool(mediaTool("ffmpeg")!, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    await gen(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(fixtures, "a.mp4")]);
    await gen(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2", "-c:v", "mpeg4", join(fixtures, "b.avi")]);
    await gen(["-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-c:a", "libmp3lame", join(fixtures, "c.mp3")]);
  }, 60_000);
  afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

  it("imports from a file, probes and derives filmstrip, peaks and a proxy in the background", async () => {
    const video = store.create("b1", {}, bot);
    const { media, video: after } = await store.addMediaFromFile("b1", video.id, join(fixtures, "a.mp4"), bot);
    expect(after.revision).toBe(2);
    expect(media).toMatchObject({ name: "a.mp4", kind: "video", width: 320, height: 180, hasAudio: true });
    expect(media.duration).toBeCloseTo(2, 1);
    const avi = await store.addMediaFromFile("b1", video.id, join(fixtures, "b.avi"), bot);
    await store.idle();
    const live = store.get("b1", video.id);
    expect(live.revision).toBe(3); // derived files never bump the revision
    const a = live.media.find(m => m.id === media.id)!;
    expect(a.thumbs).toMatchObject({ every: 1, count: 2, width: 160 });
    expect(a.peaks).toMatchObject({ perSecond: 50 });
    expect(a.proxy).toBeUndefined();
    const b = live.media.find(m => m.id === avi.media.id)!;
    expect(b.proxy).toMatch(/\.proxy\.mp4$/);
    expect(store.mediaFile("b1", video.id, b.id, "proxy")).toMatchObject({ mime: "video/mp4" });
    expect(store.mediaFile("b1", video.id, a.id, "proxy").path).toBe(store.mediaFile("b1", video.id, a.id, "source").path);
    const peaks = JSON.parse(readFileSync(store.mediaFile("b1", video.id, a.id, "peaks").path, "utf8"));
    expect(peaks.perSecond).toBe(50);
    expect(Math.max(...peaks.peaks)).toBeGreaterThan(0.1);
    await expect(store.addMediaFromFile("b1", video.id, join(fixtures, "missing.mp4"), bot)).rejects.toMatchObject({ status: 404 });
  }, 60_000);

  it("streams an upload to disk and cleans up a refused one", async () => {
    const video = store.create("b1", {}, owner);
    const { media } = await store.addMediaFromStream("b1", video.id, "../../evil/clip.mp3", createReadStream(join(fixtures, "c.mp3")), owner);
    expect(media).toMatchObject({ name: "clip.mp3", kind: "audio" });
    await expect(store.addMediaFromStream("b1", video.id, "x.mp4", Readable.from([Buffer.from("x")]), owner, { afterBody: () => { throw Object.assign(new Error("nope"), { status: 403 }); } })).rejects.toMatchObject({ status: 403 });
    await expect(store.addMediaFromStream("b1", video.id, "junk.mp4", Readable.from([Buffer.from("not a video at all")]), owner)).rejects.toMatchObject({ status: 415 });
    const dir = join(root, "b1", "videos", video.id, "media");
    expect(readdirSync(dir)).toEqual([media.file]);
    await store.idle();
  }, 60_000);

  it("refuses files ffmpeg would read as something other than media", async () => {
    const video = store.create("b1", {}, owner);
    const secret = join(fixtures, "notes.ans");
    writeFileSync(secret, "api_key=hunter2\n");
    await expect(store.addMediaFromFile("b1", video.id, secret, owner)).rejects.toMatchObject({ status: 415 });
    const list = join(fixtures, "list.ffconcat");
    writeFileSync(list, `ffconcat version 1.0\nfile '${join(fixtures, "a.mp4")}'\n`);
    await expect(store.addMediaFromFile("b1", video.id, list, owner)).rejects.toMatchObject({ status: 415 });
    expect(readdirSync(join(root, "b1", "videos", video.id, "media"))).toEqual([]);
  });

  it("refuses removing media in use", async () => {
    const video = store.create("b1", {}, owner);
    const { media } = await store.addMediaFromFile("b1", video.id, join(fixtures, "c.mp3"), owner);
    const audio = video.timeline.tracks.find(t => t.kind === "audio")!.id;
    const { created } = store.edit("b1", video.id, [{ op: "add_clip", track_id: audio, media_id: media.id }], owner);
    expect(() => store.removeMedia("b1", video.id, media.id, owner)).toThrow(/used on the timeline/);
    store.edit("b1", video.id, [{ op: "delete_clip", clip_id: created[0] }], owner);
    await store.idle();
    expect(store.removeMedia("b1", video.id, media.id, owner).media).toHaveLength(0);
  }, 60_000);

  it("renders the current revision, broadcasts progress and exports the mp4", async () => {
    const video = store.create("b1", { title: "Demo cut", size: "square" }, bot);
    const a = (await store.addMediaFromFile("b1", video.id, join(fixtures, "a.mp4"), bot)).media;
    const b = (await store.addMediaFromFile("b1", video.id, join(fixtures, "b.avi"), bot)).media;
    const c = (await store.addMediaFromFile("b1", video.id, join(fixtures, "c.mp3"), bot)).media;
    const tracks = store.get("b1", video.id).timeline.tracks;
    const [vt, , at] = tracks;
    store.edit("b1", video.id, [
      { op: "set_format", width: 320, height: 320 },
      { op: "add_clip", track_id: vt.id, media_id: a.id, fit: "cover" },
      { op: "add_clip", track_id: vt.id, media_id: b.id, speed: 2 },
      { op: "add_clip", track_id: at.id, media_id: c.id, start: 0.5, volume: 0.5 },
    ], bot);
    await store.idle();
    const render = store.startRender("b1", video.id, bot);
    expect(render.status).toBe("queued");
    expect(() => store.startRender("b1", video.id, bot)).toThrow(/already running/);
    for (let i = 0; i < 600 && store.activeRender("b1", video.id); i++) await new Promise(r => setTimeout(r, 50));
    const done = store.render("b1", video.id, render.id);
    expect(done).toMatchObject({ status: "done", progress: 1, revision: 5 });
    expect(changes.filter(c => c.render?.id === render.id).map(c => c.render!.status)).toContain("done");
    const out = store.renderFile("b1", video.id, render.id);
    const probe = await runTool(mediaTool("ffprobe")!, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
    expect(Number(probe.stdout.toString())).toBeCloseTo(3.5, 1);
    const exported = await store.exportRender("b1", video.id, render.id, join(root, "workspace", "videos"));
    expect(exported).toMatch(/Demo-cut-.*\.mp4$/);
    expect(existsSync(exported)).toBe(true);

    const snap = join(root, "snap.jpg");
    await store.snapshot("b1", video.id, 1, snap, 160);
    expect(existsSync(snap)).toBe(true);
    const shot = await store.snapshotTo("b1", video.id, 1, join(root, "workspace", "videos", "snapshots"), 160);
    expect(shot.path.startsWith(join(root, "workspace", "videos", "snapshots"))).toBe(true);
    expect(shot.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // A bot can plant links in its own folder; exports never write through them.
    const elsewhere = mkdtempSync(join(tmpdir(), "videos-elsewhere-"));
    const linked = join(root, "workspace", "linked");
    symlinkSync(elsewhere, linked);
    await expect(store.exportRender("b1", video.id, render.id, linked)).rejects.toMatchObject({ status: 409 });
    await expect(store.snapshotTo("b1", video.id, 1, join(linked, "snapshots"), 160)).rejects.toMatchObject({ status: 409 });
    const trap = join(root, "workspace", "trap");
    mkdirSync(trap);
    symlinkSync(join(elsewhere, "owned.mp4"), join(trap, exported.slice(exported.lastIndexOf("/") + 1)));
    await expect(store.exportRender("b1", video.id, render.id, trap)).rejects.toMatchObject({ status: 409 });
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  }, 120_000);

  it("cancels a render", async () => {
    const video = store.create("b1", {}, owner);
    const a = (await store.addMediaFromFile("b1", video.id, join(fixtures, "a.mp4"), owner)).media;
    const vt = store.get("b1", video.id).timeline.tracks[0].id;
    store.edit("b1", video.id, [{ op: "add_clip", track_id: vt, media_id: a.id, duration: 8, speed: 0.25 }], owner);
    await store.idle();
    const render = store.startRender("b1", video.id, owner);
    store.cancelRender("b1", video.id, render.id);
    for (let i = 0; i < 200 && store.activeRender("b1", video.id); i++) await new Promise(r => setTimeout(r, 50));
    expect(store.render("b1", video.id, render.id).status).toBe("cancelled");
    expect(readdirSync(store.rendersDir("b1", video.id))).toEqual([]);
  }, 60_000);
});
