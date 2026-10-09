# piece 9 terminal endpoint handoff

implementation: `v14/api-terminal`, based on `v14/api-server` at `eb92a515`.
worktree: `/Users/firazfhansurie/.bos-bot/workspaces/6ca32513-1716-40e6-b006-59a6130e3570/v14-api-terminal`.
status: endpoint committed at `9d67c6d4`; bos's one auth/data review requested
workspace credential stripping. the follow-up below addresses that condition;
bos authorized integration after the fix with no second review. not installed.

implements the interface posted on `v14/api-connection-findings` at `e9cfb78a`:
`POST /api/terminal/ticket {botId,threadId}` returns `201 {ticket}` and
`WS /api/terminal?ticket=...` uses ready/output/exit/error and input/resize frames.
for rooms, botId is the group id and threadId is that room's selected conversation.

folder semantics: direct threads use their effective pinned cwd, including legacy
home-folder pins. rooms use the conversation's pinned room folder or its configured
room folder before pinning. a room with no shared folder gets an app-owned room/thread
workspace. opening a terminal does not pin or switch a provider conversation. the
server canonicalizes and rechecks the folder on upgrade. remote worker, VM/cloud,
and inherited team-computer bot targets fail closed.

## review surface

- minting needs the packaged desktop's private mutation capability, direct real
  loopback peer, permitted origin and loopback auth; remote admin sessions,
  companion headers, forwarding and IPC are refused. standalone server minting
  is refused even on loopback.
- tickets are private memory-only random 256-bit values, expire after 30 seconds,
  are consumed on the first upgrade attempt, and bind target/cwd/origin and desktop
  capability generation. only the primary API listener has an upgrade handler.
- 64 outstanding tickets, 8 terminals, 64 KiB inbound websocket frames,
  1 MiB output backlog, resize bounds 500 columns/200 rows, 15-second heartbeat.
- no transcript writes. no caller-supplied cwd or executable. shells run with the
  local owner's host permissions; cwd is a starting folder.
- closing/disconnecting tears down the PTY and discovered shell descendants,
  including job-control background children. PID birth times prevent delayed
  cleanup from signaling reused descendant PIDs. shutdown awaits cleanup.
- an open terminal holds the existing workspace maintenance admission lease and
  makes idle checks false, preventing update/restore until cleanup completes.
- native node-pty is loaded only after authorization, from a copied vendor runtime
  outside app.asar. node-pty 1.1.0, ws 8.18.3; no package version bump here.

## verified on 2026-10-05, darwin-arm64

- `pnpm exec vitest run server/terminal.test.ts server/terminal-target.test.ts server/request-auth.test.ts server/desktop-update-lifecycle.test.ts`: 62 passed.
  includes real isolated HTTP/websocket/PTY pwd/ls, tty resize, shell exit,
  socket/server-close child cleanup, auth/target/frame rejection, origin,
  expiry/replay, ticket/terminal bounds, simulated slow-consumer backlog,
  and real update admission held until cleanup.
- `pnpm typecheck`: passed; final `pnpm exec tsc -p tsconfig.server.json`: passed.
- `pnpm build:server`: passed, including vendored native runtime and ws bundling.
- `node scripts/smoke-terminal-pty.mjs`: passed with no node_modules in reach,
  disposable home/cwd, real shell output, resize to 93x31 and exit 0.
- `node scripts/smoke-packaged-server.mjs`: passed; relocated server startup,
  all 12 proxy paths, WhatsApp runtime and MCP stdio checks.
- changed terminal/bundler/smoke files: oxlint deny-warnings and diff check passed.
- standard control-omb disposable fake-provider fixture launched and doctor passed;
  its standalone terminal ticket route returned 403 as intended. fixture stopped.
  retained fixture log: `/var/folders/q4/_qf5jflj6gn91bt65srrhq040000gn/T/bosbot-verification-evidence/server-1791167628702-87812.log`.

## remaining with ship

ship integrates this endpoint and its credential-env follow-up with
ui terminal `15005330`, resolves package/lockfile additions, and checks the actual
desktop header button, ticket handshake and Electron native PTY in the packaged app.
api did not install or restart. full repository suite was not rerun; existing
unrelated baseline failures remain documented by the owners.

the native copy is for the build host platform/architecture. release builders must
build on their target; Linux needs a compiled node-pty addon because this version
does not ship a Linux prebuild. Windows PTY/taskkill paths are implemented but
unverified. arbitrary deliberately detached daemon processes are outside the
shell-owned child teardown guarantee.

## auth/data review follow-up, 2026-10-05

- `spawnTerminalPty` copies the server environment, applies
  `stripWorkspaceCredentialEnv` to that copy, then passes it to node-pty.
- regression verified red before the fix and green afterward through the real
  HTTP ticket / WebSocket / shell fixture: `XAI_API_KEY`, `BOX_TOKEN`, and
  `BOS_TTS_KEY` are absent in the shell. ordinary env and TERM survive; the
  server retains its credential env. fixtures use synthetic secrets only.
- `pnpm exec vitest run server/terminal.test.ts server/terminal-target.test.ts server/request-auth.test.ts server/desktop-update-lifecycle.test.ts server/engine-install.test.ts`: 72 passed.
- `pnpm typecheck`, `pnpm build:server`, changed-file oxlint deny-warnings,
  and `git diff --check`: passed.
- `node scripts/smoke-terminal-pty.mjs` and
  `node scripts/smoke-packaged-server.mjs`: passed with relocated runtimes and
  disposable homes, including real PTY output/resize/exit and server startup.

## child-pid fixture follow-up, 2026-10-05

The 8-second child-pid failure reproduced on Node 24.21.0. Diagnostic frames
contained only `ready` and the echoed input line; neither a shell prompt nor the
executed `child:<pid>` marker arrived. This happened before the cleanup assertion.
The fixture inherited the runner's `/bin/zsh` and treated PTY allocation as shell
initialization. The diagnostic does not establish why that shell failed to start
executing input, so the earlier load-only explanation is not proven.

The fixture now selects `/bin/sh`, a disposable HOME and empty ENV startup file,
and a known prompt. Both socket/server cleanup cases wait for actual prompt output
before launching their child. Real child creation, PID liveness before close and
bounded PID disappearance afterward remain required. The test deadlines stay at
8 seconds inside the 30-second case timeout. Failure diagnostics show only frame
types and socket state, never raw shell output or environment values.

Verified on Node 24.21.0, darwin-arm64:

- Temporary stress parameterization: 50 socket-close and 50 server-close cases
  passed; the final committed parameterization remains the two original cases.
- Final `pnpm exec vitest run server/terminal.test.ts server/terminal-target.test.ts server/request-auth.test.ts server/desktop-update-lifecycle.test.ts server/engine-install.test.ts`:
  72/72 passed (11:11:35 run).
- `pnpm typecheck`, changed-file oxlint deny-warnings and `git diff --check`: passed.

This change only touches tests and this handoff document. Ship still owns merged
checks, packaging and the guarded install; no runtime-shell startup claim follows
from these isolated fixture results.
