# pinned bosbot capability audit

upstream: `https://github.com/milind-soni/OpenMausBot.git`
commit: `ed1c15d970550e984541b4474d6731c1597c6563`
audited: 2026-09-20

## retained v1 capabilities

| capability | implementation evidence | test evidence | state |
| --- | --- | --- | --- |
| bot create/edit/duplicate/archive/delete | `server/index.ts`, `server/store.ts`, `src/components/NewBotDialog.tsx`, `src/components/BotSettingsDialog.tsx` | `server/index.test.ts`, `server/bot-deletion-write-failure.e2e.test.ts`, component tests | isolated-tested upstream |
| claude subscription cli | `server/drivers/claude.ts`, `server/drivers/claude-login-auth.ts` | `server/drivers/claude*.test.ts` | isolated-tested upstream; live test required |
| codex subscription cli | `server/drivers/codex.ts`, `server/drivers/codex-device-auth.ts` | `server/drivers/codex*.test.ts` | isolated-tested upstream; live test required |
| model and effort selection | provider catalogs, `src/components/ModelPicker.tsx` | catalog and model picker tests | isolated-tested upstream |
| approval modes | `shared/approval-mode.ts`, provider drivers, `server/auto-approve.ts` | approval matrix/provider tests | isolated-tested upstream; BOS matrix required |
| attachments | `server/attachments.ts`, composer components | attachment and composer tests | isolated-tested upstream |
| stop/resume/recovery | drivers, `server/resume-recovery.ts`, follow-up store | continuity, restart, retry tests | isolated-tested upstream |
| persistence | `server/config.ts`, `server/store.ts`, `server/message-db.ts`, `server/atomic.ts` | migration, continuity, atomic-write tests | isolated-tested upstream; BOS policy required |
| voice | Electron speech helper and renderer voice components | Electron speech and component tests | source present; packaged live test required |
| MCP registry | `server/mcp-registry.ts`, MCP routes and renderer panel | MCP registry/gate/probe/panel tests | isolated-tested upstream |
| local computer control | Electron CUA modules, `server/local-computer*.ts` | CUA, local-computer, screen gate tests | isolated-tested upstream; explicit opt-in live test required |
| macOS package | `electron-builder.yml`, packaging scripts | packaged-server and Electron tests | configured upstream; BOS package required |

## excluded-service coupling and disposition

| excluded surface | entry points | disposition |
| --- | --- | --- |
| enterprise implementation | `enterprise/`, `server/enterprise.ts`, imports in `server/index.ts`, brand entitlement | delete implementation; replace runtime hooks with fixed BOS community/local policy |
| companion and phone | `companion/`, Electron companion/account/tunnel modules, preload APIs, server phone routes | delete sidecar and phone source; remove imports, IPC, routes, scripts, resources, and settings UI |
| hosted workspaces | hosted contracts/access routes and Electron workspace switching | remove remote connection flows and fail closed to embedded local server |
| cloudflared | preparation script and packaged native resource | remove build script, resource, license copy, and runtime launch path |
| Android and iOS | `android/`, `ios/`, Electron Android controller | delete mobile trees and desktop controller wiring |
| Box/cloud computers | Box server modules, cloud backend picker, remote computer UI | remove routes/startup and UI; retain only generic local-computer contracts proven necessary |
| Composio | broker worker, server integration, Electron managed broker | delete broker and runtime wiring; remove UI marketplace entry |
| routines and webhooks | server managers/routes, Electron wake hold, renderer pages | remove managers, routes, IPC, navigation, and tests from retained suite |
| team packages/marketplace | team library/package/import routes and renderer panels | remove public marketplace/deep-link surfaces; bot duplication remains local |
| updater | Electron updater modules and GitHub publish target | disable/remove upstream updater until BOS owns a release channel |
| telemetry | PostHog/analytics initialization | disable by fixed product policy; remove network initialization from packaged app |
| browser bundle | downloaded browser preparation/runtime | exclude downloaded browser bundle in v1; local computer control remains separate |

## build and package boundary

`package:prepare` currently includes companion, updater, Android tools, cloudflared, and browser preparation. `electron-builder.yml` packages companion, Android tools, cloudflared, updater metadata, and remote-related resources. v1 must rewrite both before packaging. `pnpm test` currently invokes the Composio broker suite and must be reduced to retained local product tests.

## security boundary already present

Upstream already uses Electron context isolation/sandboxing, a narrow preload bridge, local-origin checks, a per-launch desktop mutation capability, request authentication, loopback checks, JSON body limits, atomic JSON writes, owner-only transcript permissions, and provider-specific approval logic. BOS must preserve these controls and add absence tests for every removed remote entry point; upstream presence is not proof of BOS packaging.

## gate result

the pinned source contains the required local bot, Claude, Codex, MCP, persistence, voice, and computer-control foundations. excluded services are deeply coupled through `server/index.ts`, `electron/main.mjs`, `electron/preload.cjs`, build scripts, and renderer composition, so removal must be incremental with compile/tests after each boundary rather than a directory-only deletion.
<!-- branding compatibility (electron/branding-compat.json): upstream-artifacts: pinned third-party binaries and historical upstream provenance cannot be redirected by a product rename -->
