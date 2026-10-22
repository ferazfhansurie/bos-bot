# Desktop mods

Use Node 24. Install this worktree's dependencies with `pnpm install`.

```
pnpm exec vitest run server/mods.test.ts server/mod-routes.test.ts server/drivers/agents-proxy.test.ts server/skill-library.test.ts
pnpm typecheck
BOS_MOD_TEST_CHROME=/path/to/test/chromium node --experimental-strip-types scripts/verify-mods.ts
```

The browser recipe uses the standard disposable fake-engine launcher, real owner HTTP API with make-mod's exact bundle format, real mods surfaces/settings and StoreProvider (set `BOS_MOD_TEST_FULL_APP=1` for the full App shell), and a separate Chromium profile inside the fixture's temporary data directory. It enables the cached remote flag only in that fixture. No live data, providers, credentials or user browser profiles are used. Startup may take up to 120 seconds on a loaded host.

It creates a today's-leads panel, exercises mod storage, disables/re-enables it without reloading, renders both example bundles, exports the panel, and runs attacks against parent DOM, parent and local storage, top navigation, fetch, undeclared capabilities and iframe self-navigation. It also asks the fake engine through the bridge and disables a running mod conversation to verify interruption. It then switches off the remote flag and checks that every mod disappears. Chromium screenshots and JSON evidence are written under `/tmp/bos-213-mods-*`. Unit tests cover safe-mode override and disabling during in-flight work; the recipe does not contact real connected apps or use a real paid engine.

The `make-mod` skill uses turn-scoped bot tools. Authoring and importing save off. The owner reviews permissions in Settings → Mods before enabling. No new phone event types or fields are introduced.

The focused renderer run passed with six screenshots: `/tmp/bos-213-mods-settings.png`, `/tmp/bos-213-mods-panel-on.png`, `/tmp/bos-213-mods-panel-off.png`, `/tmp/bos-213-mods-panel-back-on.png`, `/tmp/bos-213-mods-examples.png`, `/tmp/bos-213-mods-sandbox.png`. Its initial evidence is `/tmp/bos-213-mods-evidence.json`. Full-shell runs use `-full-app` screenshot suffixes and `/tmp/bos-213-mods-evidence-full-app.json`.

Verified full-shell screenshots: `/tmp/bos-213-mods-panel-on-full-app.png`, `/tmp/bos-213-mods-panel-off-full-app.png`, `/tmp/bos-213-mods-panel-back-on-full-app.png`, `/tmp/bos-213-mods-examples-full-app.png`, `/tmp/bos-213-mods-sandbox-full-app.png`. The full-shell run also verified the real fake-engine reply and interruption after disable; all seven sandbox assertions passed.

Exact browser command used on this Mac:

```
export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH
BOS_MOD_TEST_FULL_APP=1 BOS_MOD_TEST_CHROME=$HOME/.cache/puppeteer/chrome-headless-shell/mac_arm-155.0.8059.84/chrome-headless-shell-mac-arm64/chrome-headless-shell node --experimental-strip-types scripts/verify-mods.ts
```

The four-suite command above passed 160 tests. No real provider/connected-app approval, native phone build, release build, publication, installation, or live app restart was performed. Bot capability HTTP dispatch was covered by route/agent-proxy tests; the browser recipe authored via the owner API using the same bundle format.

## open: child-frame webrtc (2026-10-22)
`scripts/verify-mods.ts` now probes WebRTC from an `about:srcdoc` child frame inside a mod. It fails on chromium 155: `frame-src 'none'` does not cover `about:srcdoc` / `about:blank` children, which share the mod's opaque origin and have a fresh realm with `RTCPeerConnection`. A mod can therefore leak bridge data over STUN or DNS. The in-frame strip can't close this. The fix needs a browser-level control (for example the mod in its own partition with WebRTC UDP disabled and a dead proxy). Until this probe passes, `flags.mods` stays off in app-config.
