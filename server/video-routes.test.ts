import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { handleInternalVideoRoute, handleOwnerVideoRoute, parseRange, videoMediaSource, type VideoHttp } from "./video-routes.ts";
import { VideoStore } from "./videos.ts";
import { mediaTool, runTool } from "./video-probe.ts";

const owner = { kind: "human" as const, id: "owner", name: "Firaz" };
const bot = { kind: "bot" as const, id: "bot-1", name: "bos" };
const haveTools = Boolean(mediaTool("ffmpeg") && mediaTool("ffprobe"));

const dirs: string[] = [];
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(body: unknown = {}) {
  const dir = tmp("bos-video-routes-");
  const videos = new VideoStore({ root: botId => join(dir, botId, "videos"), text: async () => null });
  const out: { status?: number; body?: any; headers?: Record<string, string> } = {};
  const http: VideoHttp = {
    readBody: async () => body,
    json: (status, value) => { out.status = status; out.body = value; },
    send: (status, headers, value) => { out.status = status; out.headers = headers; out.body = value; },
    sendStream: (status, headers) => { out.status = status; out.headers = headers; },
  };
  return { dir, videos, out, http };
}

describe("video routes", () => {
  it("parses byte ranges", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("bad");
    expect(parseRange("bytes=5-2", 100)).toBe("bad");
    expect(parseRange("items=0-1", 100)).toBe("bad");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  });

  it("refuses a non-owner before touching the store, and drains an upload it refuses", async () => {
    const { videos, out, http } = harness({ title: "x" });
    let drained = false;
    const deps = {
      ...http, videos, owner: () => owner, botExists: () => true, directBotOf: () => null, afterBody: () => {},
      requestBody: () => (async function* () {})(), discardBody: () => { drained = true; }, header: () => undefined,
      assertOwner: () => { throw Object.assign(new Error("owner access required"), { status: 403 }); },
    };
    await handleOwnerVideoRoute("POST", "/api/videos/bot-1", new URLSearchParams(), deps);
    expect(out.status).toBe(403);
    expect(videos.list("bot-1")).toEqual([]);
    await handleOwnerVideoRoute("POST", "/api/videos/bot-1/v-abcdefgh1234/media", new URLSearchParams("name=a.mp4"), deps);
    expect(out.status).toBe(403);
    expect(drained).toBe(true);
  });

  it("keeps a thread link only for the bot's own direct conversation", async () => {
    const { videos, out, http } = harness({ title: "x", threadId: "t-other", size: "square" });
    const deps = {
      ...http, videos, owner: () => owner, botExists: () => true, assertOwner: () => {}, afterBody: () => {},
      directBotOf: (id: string) => id === "t-other" ? "bot-2" : null,
      requestBody: () => (async function* () {})(), discardBody: () => {}, header: () => undefined,
    };
    await handleOwnerVideoRoute("POST", "/api/videos/bot-1", new URLSearchParams(), deps);
    expect(out.status).toBe(200);
    expect(out.body.video.threadId).toBeUndefined();
    expect(out.body.video.timeline).toMatchObject({ width: 1080, height: 1080 });
  });

  it("gives bots their own videos in direct chats and nothing in rooms or other conversations", async () => {
    const { videos, out, http } = harness({ title: "Teaser", size: "landscape" });
    const deps = { ...http, videos, botId: "bot-1", threadId: "t-1", bot, requireActive: () => {} };
    await handleInternalVideoRoute("POST", "/api/internal/videos", new URLSearchParams(), { ...deps, inRoom: true });
    expect(out.status).toBe(403);
    await handleInternalVideoRoute("POST", "/api/internal/videos", new URLSearchParams(), { ...deps, inRoom: false });
    expect(out.status).toBe(200);
    expect(out.body.video).toMatchObject({ title: "Teaser", revision: 1, width: 1920 });
    expect(out.body.video.text).toContain("1920x1080");
    expect(out.body.video.where).toMatch(/side tab/);
    const id = out.body.video.id;
    await handleInternalVideoRoute("GET", `/api/internal/videos/${id}`, new URLSearchParams(), { ...deps, threadId: "t-2", inRoom: false });
    expect(out.status).toBe(404);
    await handleInternalVideoRoute("GET", "/api/internal/videos", new URLSearchParams(), { ...deps, threadId: "t-2", inRoom: false });
    expect(out.body.videos).toEqual([]);
  });

  it("requires base_revision on bot edits and refuses malformed or stale ones", async () => {
    const { videos, out, http } = harness();
    const video = videos.create("bot-1", { threadId: "t-1" }, owner);
    const text = video.timeline.tracks.find(t => t.kind === "text")!.id;
    const run = (body: unknown) => handleInternalVideoRoute("POST", `/api/internal/videos/${video.id}/edit`, new URLSearchParams(), {
      ...http, readBody: async () => body, videos, botId: "bot-1", threadId: "t-1", bot, inRoom: false, requireActive: () => {},
    });
    await run({ ops: [{ op: "add_clip", track_id: text, text: "hi" }] });
    expect(out.status).toBe(400);
    await run({ base_revision: 1, ops: [{ op: "explode" }] });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/op must be one of/);
    await run({ base_revision: 1, ops: [{ op: "add_clip", track_id: text, text: "hi", start: 0, duration: 2 }], title: "Cut" });
    expect(out.status).toBe(200);
    expect(out.body.created).toHaveLength(1);
    expect(out.body.video).toMatchObject({ title: "Cut", revision: 3, clipCount: 1 });
    await run({ base_revision: 1, ops: [{ op: "delete_clip", clip_id: out.body.created[0] }] });
    expect(out.status).toBe(409);
  });

  it("lets bots import only from their folders and the owner's media folders", () => {
    const root = tmp("bos-video-paths-");
    const home = join(root, "home"), data = join(home, ".bos"), ws = join(data, "workspaces", "bot-1");
    for (const d of [join(home, ".ssh"), join(data, "workspaces", "bot-2"), ws, join(home, "Movies", ".cache"), join(home, "Documents")]) mkdirSync(d, { recursive: true });
    const files = { key: join(home, ".ssh", "id.png"), other: join(data, "workspaces", "bot-2", "a.mp4"), own: join(ws, "a.mp4"), movie: join(home, "Movies", "a.mp4"), hidden: join(home, "Movies", ".cache", "a.mp4"), doc: join(home, "Documents", "a.mp4"), link: join(home, "Movies", "sneaky.mp4") };
    for (const f of [files.key, files.other, files.own, files.movie, files.hidden, files.doc]) writeFileSync(f, "x");
    symlinkSync(files.other, files.link);
    const roots = { home, allowed: [ws] };
    expect(videoMediaSource(files.own, "bot-1", roots)).toBe(realpathSync.native(files.own));
    expect(videoMediaSource(files.movie, "bot-1", roots)).toBe(realpathSync.native(files.movie));
    for (const f of [files.key, files.other, files.link, files.hidden, files.doc]) expect(videoMediaSource(f, "bot-1", roots)).toBeNull();
    expect(() => videoMediaSource(join(ws, "missing.mp4"), "bot-1", roots)).toThrow(/no file/);
  });
});

// A real HTTP server around the owner routes, wired the way index.ts wires them.
describe.skipIf(!haveTools)("video routes over HTTP", () => {
  let server: Server;
  let base = "";
  let root = "";
  let fixtures = "";
  let videos: VideoStore;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "bos-video-http-"));
    fixtures = join(root, "fixtures");
    mkdirSync(fixtures);
    await runTool(mediaTool("ffmpeg")!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(fixtures, "a.mp4")]);
    videos = new VideoStore({ root: botId => join(root, botId, "videos"), text: async () => null });
    server = createServer((req: IncomingMessage, res) => {
      const url = new URL(req.url!, "http://x");
      const readBody = () => new Promise<unknown>((resolve, reject) => {
        let data = "";
        req.on("data", c => { data += c; });
        req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
      });
      void handleOwnerVideoRoute(req.method!, url.pathname, url.searchParams, {
        videos, owner: () => owner, botExists: id => id === "bot-1", directBotOf: () => null, assertOwner: () => {}, afterBody: () => {},
        requestBody: () => req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>,
        discardBody: () => { req.resume(); },
        header: name => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; },
        readBody,
        json: (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
        send: (status, headers, body) => { res.writeHead(status, headers); res.end(body); },
        sendStream: (status, headers, body) => { res.writeHead(status, headers); if (body) body.pipe(res); else res.end(); },
      }).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise(resolve => server?.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it("uploads by streaming, serves media with Range, thumbs, peaks, and renders", async () => {
    const created = await (await fetch(`${base}/api/videos/bot-1`, { method: "POST", body: JSON.stringify({ title: "HTTP", size: "landscape" }) })).json() as any;
    const id = created.video.id as string;
    const bytes = readFileSync(join(fixtures, "a.mp4"));
    const up = await fetch(`${base}/api/videos/bot-1/${id}/media?name=${encodeURIComponent("my clip.mp4")}`, { method: "POST", body: bytes, headers: { "content-type": "video/mp4" } });
    expect(up.status).toBe(201);
    const { media, video } = await up.json() as any;
    expect(media).toMatchObject({ name: "my clip.mp4", kind: "video", bytes: bytes.length });
    expect(video.revision).toBe(2);

    const ranged = await fetch(`${base}/api/videos/bot-1/${id}/media/${media.id}`, { headers: { range: "bytes=100-199" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 100-199/${bytes.length}`);
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect(ranged.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true);
    const whole = await fetch(`${base}/api/videos/bot-1/${id}/media/${media.id}/proxy`);
    expect(whole.status).toBe(200);
    expect((await whole.arrayBuffer()).byteLength).toBe(bytes.length);
    const bad = await fetch(`${base}/api/videos/bot-1/${id}/media/${media.id}`, { headers: { range: `bytes=${bytes.length}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${bytes.length}`);

    await videos.idle();
    const thumbs = await fetch(`${base}/api/videos/bot-1/${id}/thumbs/${media.id}.jpg`);
    expect(thumbs.status).toBe(200);
    expect(thumbs.headers.get("content-type")).toBe("image/jpeg");
    const peaks = await (await fetch(`${base}/api/videos/bot-1/${id}/peaks/${media.id}.json`)).json() as any;
    expect(peaks.perSecond).toBe(50);
    expect(peaks.peaks.length).toBeGreaterThan(90);

    const vt = video.timeline.tracks[0].id;
    const patched = await (await fetch(`${base}/api/videos/bot-1/${id}`, { method: "PATCH", body: JSON.stringify({ baseRevision: 2, ops: [{ op: "add_clip", track_id: vt, media_id: media.id }] }) })).json() as any;
    expect(patched.video.revision).toBe(3);
    const stale = await fetch(`${base}/api/videos/bot-1/${id}`, { method: "PUT", body: JSON.stringify({ baseRevision: 2, timeline: patched.video.timeline }) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).video.revision).toBe(3);

    const started = await (await fetch(`${base}/api/videos/bot-1/${id}/renders`, { method: "POST", body: "{}" })).json() as any;
    expect(started.render.status).toBe("queued");
    let render = started.render;
    for (let i = 0; i < 400 && !["done", "failed"].includes(render.status); i++) {
      await new Promise(r => setTimeout(r, 50));
      render = ((await (await fetch(`${base}/api/videos/bot-1/${id}/renders/${render.id}?status=1`)).json()) as any).render;
    }
    expect(render.status).toBe("done");
    const mp4 = await fetch(`${base}/api/videos/bot-1/${id}/renders/${render.id}?download=1`, { headers: { range: "bytes=0-99" } });
    expect(mp4.status).toBe(206);
    expect(mp4.headers.get("content-disposition")).toMatch(/attachment/);
    expect(mp4.headers.get("content-disposition")).toMatch(/HTTP\.mp4/);
    expect(Buffer.from(await mp4.arrayBuffer()).subarray(4, 8).toString()).toBe("ftyp");

    const del = await fetch(`${base}/api/videos/bot-1/${id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    await fetch(`${base}/api/videos/bot-1/${id}`, { method: "PATCH", body: JSON.stringify({ trashed: true }) });
    expect((await fetch(`${base}/api/videos/bot-1/${id}`, { method: "DELETE" })).status).toBe(200);
  }, 120_000);

  it("deletes a refused upload's partial file", async () => {
    const created = await (await fetch(`${base}/api/videos/bot-1`, { method: "POST", body: "{}" })).json() as any;
    const res = await fetch(`${base}/api/videos/bot-1/${created.video.id}/media?name=x.mp4`, { method: "POST", body: Buffer.from("definitely not media") });
    expect(res.status).toBe(415);
    expect(videos.get("bot-1", created.video.id).media).toEqual([]);
  });
});
