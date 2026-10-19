// Real video store, owner routes and ffmpeg renders against a disposable fake-engine server.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "../../../scripts/control-omb.ts";
import { parkUntilSignal } from "../../../scripts/testing/preview-fixture.ts";
import { mediaTool } from "../../../server/video-probe.ts";
import { textEngine } from "../../../server/video-render.ts";

const ffmpeg = mediaTool("ffmpeg");
const ffprobe = mediaTool("ffprobe");
const curl = ["/usr/bin/curl", "/opt/homebrew/bin/curl"].find(path => { try { execFileSync(path, ["--version"]); return true; } catch { return false; } });
if (!ffmpeg || !ffprobe || !curl) throw new Error("verify-videos needs ffmpeg, ffprobe and curl on this computer");

const media = mkdtempSync(join(tmpdir(), "verify-videos-media-"));
const gen = (args: string[]) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
gen(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(media, "clip.mp4")]);
gen(["-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-c:a", "libmp3lame", join(media, "tone.mp3")]);
gen(["-f", "lavfi", "-i", "color=c=teal:size=400x400", "-frames:v", "1", join(media, "still.png")]);

const fixture = await launchVerificationServer();
const park = !process.argv.includes("--exit");
try {
  await runControlOmb(["new-bot", "--name", "Video fixture", "--url", fixture.info.url]);
  const base = fixture.info.url;
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, init);
    const body = await res.json() as any;
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const { bots } = await api("/api/bots") as { bots: Array<{ id: string; name: string }> };
  const bot = bots.find(b => b.name === "Video fixture")!.id;

  let { video } = await api(`/api/videos/${bot}`, json("POST", { title: "Fixture cut", size: "landscape" }));
  const root = `/api/videos/${bot}/${video.id}`;
  const ids: Record<string, string> = {};
  for (const name of ["clip.mp4", "tone.mp3", "still.png"]) {
    const added = await api(`${root}/media?name=${encodeURIComponent(name)}`, { method: "POST", body: readFileSync(join(media, name)) });
    ids[name] = added.media.id;
  }
  // Thumbs and peaks derive in the background without bumping the revision.
  for (let i = 0; i < 60; i++) {
    video = (await api(root)).video;
    const clip = video.media.find((m: any) => m.id === ids["clip.mp4"]);
    if (clip?.thumbs && clip?.peaks) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const [vTrack, tTrack, aTrack] = ["video", "text", "audio"].map(kind => video.timeline.tracks.find((t: any) => t.kind === kind).id);
  const text = await textEngine();
  const ops = [
    { op: "set_format", width: 640, height: 360 },
    { op: "add_clip", track_id: vTrack, media_id: ids["clip.mp4"], start: 0, duration: 3 },
    { op: "add_clip", track_id: vTrack, media_id: ids["still.png"], start: 3, duration: 1.5, fit: "cover" },
    { op: "add_clip", track_id: aTrack, media_id: ids["tone.mp3"], start: 0.5, duration: 4, volume: 0.4 },
    ...(text ? [{ op: "add_clip", track_id: tTrack, text: "verify-videos fixture", start: 0.5, duration: 3 }] : []),
  ];
  const edited = await api(root, json("PATCH", { ops, baseRevision: video.revision }));
  const stale = await fetch(`${base}${root}`, json("PUT", { baseRevision: video.revision, title: "stale" }));

  const peaks = await api(`${root}/peaks/${ids["clip.mp4"]}.json`);
  const thumbs = await fetch(`${base}${root}/thumbs/${ids["clip.mp4"]}.jpg`);

  let { render } = await api(`${root}/renders`, { method: "POST" });
  for (let i = 0; i < 240 && (render.status === "queued" || render.status === "running"); i++) {
    await new Promise(r => setTimeout(r, 500));
    render = (await api(`${root}/renders/${render.id}?status=1`)).render;
  }
  if (render.status !== "done") throw new Error(`render ended ${JSON.stringify(render)}`);

  const renderUrl = `${base}${root}/renders/${render.id}?download=1`;
  const headers = execFileSync(curl, ["-s", "-D", "-", "-o", "/dev/null", "-r", "0-1023", renderUrl]).toString().trim().split(/\r?\n/);
  const out = join(media, "render.mp4");
  execFileSync(curl, ["-s", "-o", out, renderUrl]);
  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", out]).toString());

  console.log(JSON.stringify({
    ...fixture.info, botId: bot, videoId: video.id, videoUrl: `${base}${root}`,
    media: ids, textClip: Boolean(text), revision: edited.video.revision, staleSave: stale.status,
    peaks: { perSecond: peaks.perSecond, count: peaks.peaks?.length }, thumbs: { status: thumbs.status, type: thumbs.headers.get("content-type") },
    render: { id: render.id, status: render.status, bytes: render.bytes }, rangeResponse: headers,
    ffprobe: probe,
  }, null, 2));
  if (park) await parkUntilSignal();
} finally {
  await fixture.close();
  rmSync(media, { recursive: true, force: true });
}
