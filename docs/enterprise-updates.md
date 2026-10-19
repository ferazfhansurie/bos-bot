# Enterprise updates (headless servers)

A client server without the desktop app (e.g. a Windows PC started by a
scheduled task) updates itself from a signed feed, on demand, with no
installer.

## Pieces

- `standalone/launch.mjs`: run as `node launch.mjs config.json`. The supervisor
  starts the server as `--child`, applies handed-off updates, rolls back a build
  that fails its health check or dies inside the stable window, and restarts the
  server when it exits.
- `server/enterprise-update.ts`: the builder (fetch manifest, verify its
  ed25519 signature against `FEED_PUBLIC_KEY`, download, check sha256 and size,
  extract, stage in `<dir>/updates/staged`) and the executor (write
  `updates/request.json`, quit).
- `scripts/enterprise-publish.mjs`: signs a release from an app's
  `Contents/Resources` or a tree built from prod.

## Feed

`<feed>/manifest.json`, `<feed>/manifest.sig` (base64 ed25519 over the exact
manifest bytes) and `<feed>/bundle-<sha8>.tgz` (server without `vendor`, ui,
skills, build-commit.json). Upload the bundle first and the manifest last.

A server refuses: a bad signature, another channel, an older version than the
running one, a manifest older than the last one it installed, and a bundle
whose hash, size or build stamp disagrees with the manifest.

## config.json

Besides the launcher's own fields (`host`, `account`, `dataDir`, `resources`,
`port`, `version`, `publicUrl`, `logsDir`, `maintenanceMarker`,
`computerUse`): `label`, `feed` (enables the enterprise builder) and `channel`
(default `enterprise`). `resources` must be on the same volume as config.json
and writable by the account: updates are directory renames.

## Updating a client

`POST /api/update/check`, then `POST /api/update/apply` with an admin session.
The server drains, checkpoints running turns, hands off and exits; the launcher
swaps, health-checks and writes the result the next server reads on boot,
where it resumes the interrupted turns. The client can do the same from
Settings → Updates.

## Desktop client builds (first-launch provisioning)

`bin/enterprise-client-build.sh <slug> <provision.json>` builds signed, notarized
arm64 + x64 dmgs (`BOS-Bot-<version>-<slug>-<arch>.dmg`) with the client's
provision file at `Contents/Resources/enterprise/provision.json`. Output goes to
`$BOS_ENTERPRISE_OUT` (default `~/BOS-enterprise-builds/<slug>-<version>`),
never the repo; the file is staged in gitignored `.enterprise-build/` and
removed on exit. Nothing is published. `--dry-run` validates and prints.

On first open (no `enterprise-provision.json` receipt in the data folder and a
fresh workspace) the app shows "Setting up <label>…", downloads `{url}/archive`
(sha256 from `x-bos-sha256`, size-capped), restores it through the local backup
API, restarts the server, applies `{url}/setup` via
`POST /api/enterprise-provision/apply`, writes a secret-free receipt, then
POSTs `{url}/done`. Every stage is checkpointed in
`enterprise-provision-state.json`, so a failed or interrupted run resumes on the
next launch. A workspace that already holds user data is never replaced.

`{{DATA_DIR}}` and `{{NODE}}` are substituted in setup strings. `{{NODE}}` is
`<data>/enterprise-runtime/node`, a shim that runs the app binary with
`ELECTRON_RUN_AS_NODE=1`; the server rewrites it at every boot so it follows the
app after a move or update. Engine credentials are never carried: a codex bot
signs in through Engines as usual.
