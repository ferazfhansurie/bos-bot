# Architecture

BOS has a local Node harness, a React interface, an Electron desktop shell, and
native mobile clients. The harness owns agent processes and persisted state.
Clients send HTTP commands and consume normalized events; provider drivers translate
CLI protocols into the shared contract.

| Directory | Responsibility |
| --- | --- |
| `src/` | React interface, components, state, and locales |
| `server/` | HTTP/SSE API, storage, permissions, and agent orchestration |
| `server/drivers/` | Claude, Codex, and other provider adapters |
| `shared/` | Contracts shared between clients and the harness |
| `electron/` | Desktop lifecycle, browser workspace, and native capabilities |
| `companion/` | Companion proxy and mobile transport |
| `ios/` | Swift app, CompanionCore, and native tests |
| `android/` | Android app |
| `services/` | Optional hosted and self-hosted supporting services |
| `cloudflare/` | Optional connector broker and control plane |
| `apps/docs/` | Documentation website |
| `scripts/` | Builds, packaging, migrations, and isolated checks |
| `third_party/` | Bundled dependency licenses and provenance |
| `docs/` | Contributor and user documentation |

Read `server/contracts.ts`, then `server/harness/` and `server/index.ts` for
runtime flow. Start in `src/state/` for client event handling. Desktop entrypoints
are `electron/main.mjs` and `electron/preload.cjs`.

The harness binds to loopback. Remote clients use explicit pairing and scoped
sessions. Agents use the user's local CLIs; approval settings govern their
computer and tool access. Credentials and personal runtime state belong outside
source control. Tests use fake providers and disposable data directories.

`dist*`, packaged installers, runtime homes, caches and signing material are build
or runtime output. They are not source contributions. Preserve path and protocol
compatibility when changing desktop branding or existing installations.
