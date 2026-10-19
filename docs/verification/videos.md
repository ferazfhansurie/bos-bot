# videos editor

launch only the disposable fake-engine fixture with node 24 or newer and ffmpeg/ffprobe installed (imagemagick `magick` adds text clips):

```sh
node --experimental-strip-types docs/verification/videos/verify.ts
```

the launcher owns a temporary home and data directory; it never uses the installed app or live data. it generates a 3s test clip, a tone and a still in its own temp folder, then drives the real owner api of that fixture: create a landscape video, stream-upload the three files, wait for the filmstrip and waveform peaks, apply one `PATCH` of ops (format, two video clips, an audio clip, a text clip when `magick` exists), prove a stale `PUT` returns 409, start a render and poll it to `done`, fetch bytes 0-1023 of the download with curl and ffprobe the full mp4. it prints one json object with that evidence (expect `staleSave: 409`, `peaks.perSecond: 50`, `rangeResponse[0]` `HTTP/1.1 206 Partial Content` with `content-range: bytes 0-1023/<size>`, and ffprobe h264 640x360 + aac at 4.5s) and parks until ctrl-c. pass `--exit` to stop right after printing.

while parked, the project stays readable at the printed `videoUrl` for manual checks with curl. this recipe proves the server and renderer only; it does not mount the Videos editor ui.

## editor ui

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch --entry videos
```

the `videos` entry is not in `scripts/testing/control-omb-ui.ts` yet: anything under `scripts/` changes the native contract and makes installed apps need a full desktop package, so it rides along with the next native change. until then add it locally (do not commit it alone):

```ts
videos: { entry: "/docs/verification/videos/preview.tsx", route: "/__videos.html", title: "Isolated video editor" },
```

this serves `/__videos.html` from the same disposable fixture: the real `VideoEditor` beside a stub conversation column, against the bot named "Pepper" or "Video fixture". create a video and upload media through the fixture's owner api (as `videos/verify.ts` does), then open `/__videos.html?v=<videoId>`; `&w=520` narrows the editor panel to check the compact layout (default 72% of the window). "ask bos" requests land in `[data-testid=video-request]` instead of a real turn. the harness does not mount the app store, so server frames never arrive: fire one by hand to see a bot edit land live, e.g. `window.dispatchEvent(new CustomEvent("bos-video-changed", { detail: { kind: "video", botId, videoId, revision, byKind: "bot" } }))` after a `PATCH` raised the revision. render progress still moves because the editor polls `renders/<id>?status=1` while a render runs.

checked 2026-10-17 at 1600x900 and 520px: three-panel layout with all three tracks visible, ruler seek, space play, b split (2.2s + 2.8s stored without float drift), edge trim, delete, a bot-kind frame redrawing the text clip with the outline pulse, ask-bos text carrying the video id, playhead and selected clip, render to done through the poll, and the downloaded mp4 showing the same text wrap and cover fit as the preview.

regressions:

```sh
pnpm exec vitest run shared/video.test.ts server/videos.test.ts server/video-routes.test.ts server/video-render.test.ts server/drivers/agents-proxy.test.ts src/components/videos
pnpm exec tsc --noEmit -p tsconfig.server.json
```

the render suite renders a real multi-track timeline (speed 2, cover fit, still image, fades, offset audio, text) and checks duration and codecs with ffprobe, plus cancellation (499) and snapshots. the store suite covers revisions and 409s, version checkpoints and restore, trash and 30-day purge, media import, background thumbs/peaks/proxy without revision bumps, renders with progress, cancel, interrupted-on-restart and export. the route suite runs a real http server: owner refusal, room refusal, conversation scoping, the bot path policy (no app data, no hidden home folders, symlinks resolved), streamed upload limits, range 206/416 and the render download.

scope: private per-bot projects; bot tools are conversation-scoped and hidden in coordinating room turns. one source input per clip, h264/aac mp4 output only. homebrew ffmpeg has no `drawtext`, so text renders through imagemagick and is refused with 503 when neither exists; the drawtext path is not exercised on this machine. no public sharing, no gpu encode, no keyframes or transitions beyond fades.
