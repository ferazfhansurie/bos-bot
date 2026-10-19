# PTY native architecture packaging follow-up, 2026-10-05

## cause and change

The old bundler selected build/Release whenever pty.node existed. Ship's failed
vendored addon is a Mach-O x86_64 bundle on a darwin-arm64 build host. node-pty's
runtime loader would normally try the host prebuild after an incompatible local
build, but packaging copied only the incompatible local directory.

bundle-server.mjs now calls stage-node-pty.mjs. It checks the native headers of
the addon and every copied helper/DLL against the host platform and architecture.
A mismatched, corrupt or incomplete local build falls back to the host prebuild;
if neither candidate matches, server bundling fails with both candidate reasons.
The stage clears previous vendor output and copies only the selected native
directory, retaining upstream CJS layout and executable helper permissions.
Compatible local release builds remain usable when no prebuild exists.

The existing shared executableTarget header reader now recognizes ARM64 PE files
as well as AMD64. Cloudflared's asset allowlist and digest checks are unchanged.
This is structural platform/architecture validation; the build smoke separately
proves that this host's Node runtime can load and use the selected native addon.

## verification

Node 24.21.0, darwin-arm64, v14/api-terminal:

- Red: restored the original existence-only selector into the extracted staging
  function, then ran the real npm x64-release/arm64-prebuild regression. It failed
  because the selector returned build/Release instead of prebuilds/darwin-arm64.
  The fixed implementation was restored in finally.
- Green: 62/62 checks across stage-node-pty, prepare-cloudflared, mac-sign,
  after-pack, no-downgrade, updater-build and stage-update. Native staging covers
  all six darwin/linux/win32 x64/arm64 header fixtures, wrong/missing helpers,
  corrupt addons, mislabeled prebuilds, and stale vendor cleanup. The real npm
  fixture stages arm64 despite a real x64 Release addon, loads that isolated
  vendor and spawns a shell from an empty home.
- pnpm build:server: passed; staged prebuilds/darwin-arm64.
- node scripts/smoke-terminal-pty.mjs: passed with relocated runtime, cwd,
  interactive output, resize and clean exit.
- node scripts/smoke-packaged-server.mjs: passed with no node_modules in reach;
  all 12 spawned proxy paths, WhatsApp client and MCP/API flush checked.
- pnpm typecheck: passed.
- Changed-file oxlint --deny-warnings and git diff --check: passed.

Windows/Linux coverage here is structural fixtures, not native execution on
those platforms. No full app package, installation or restart was performed.

## handoff

One infrastructure review from bos remains. Ship owns merging, rebuilding the
arm64 staging candidate, checking the selected packaged native binaries and
PTY smoke, then signature/build-stamp/release-contract/no-downgrade/restart
guard verification before any install. Use ship's merged b9bef2ab release state;
this fix is committed on the existing v14/api-terminal branch after 3d236bc8.
