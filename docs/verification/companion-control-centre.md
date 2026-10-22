# Companion control centre — 2026-10-20

## Implemented runtime boundary

The phone can inspect `GET /api/bots/:id/runtime?threadId=:threadId` and select the current thread's computer through the existing task PATCH with `deferComputerStart: true`. Selection changes the tools destination for the next turn, not the location of the model process. It does not transfer files, credentials, or open application state. Busy threads refuse a destination change. Selection does not prewarm, provision, or start compute; sending the next task may do so under the configured provider rules.

The runtime response explicitly reports `hostRequired: true` and `supportsMigration: false`. BoxCompute is sandbox tools, distinct from the Box agent driver. Even a Box agent still depends on the coordinating server. The UI retains these distinctions and never calls the selector a live task migration.

## Verification performed

- Isolated `server/index.test.ts`, test `phone runtime reads stay thread scoped and selection can defer all computer starts`: passed. Checks required/exact thread identity, unavailable computer capabilities with access off, truthful runtime flags, malformed deferral rejection, selection readback and reset.
- `server/request-auth.test.ts`: 41 passed.
- Swift `ShareClientTests`: 33 existing tests passed after compiling the new runtime models/client methods.
- New `testRuntimeSelectionPinsThreadAndDoesNotStartComputer`: added to check exact thread URL, PATCH body, explicit deferred start and JSON null reset. Its first build was interrupted by a concurrent source edit; consolidated Swift validation remains the integrating agent's responsibility.
- No live production mutation, process restart, provisioning, or physical-phone verification was performed by the runtime subtask.

## Independent settings security review

Standing instructions use an owner-and-admin authorization gate on the server, not merely a hidden phone control. The optional `expectedSoul` value is compared against the current record after reading the request and immediately before the synchronous profile mutation; a conflicting edit receives 409. Skills remain admin-scoped. Skill enable/disable optionally compares the reviewed manifest hash before the synchronous mutation. Imported-skill policy remains in `setSkillEnabled`; the phone does not bypass it. These source checks are not a substitute for the integrating agent's route regression tests.

## Full cloud execution remains unimplemented

Reusable existing components:

- `services/cloud/selfhost.ts`: durable room service, PostgreSQL migration ledger and background worker.
- `server/cloud-host.ts`: outbound host polling, invocation claims, lease heartbeats, fencing, stop acknowledgement and final-result commits.
- `server/cloud-host-runtime.ts`: maps cloud bot IDs to local native bots and isolated room tasks.

Important constraints:

- `startCloudHostFromEnv` is explicitly development-only and refuses packaged applications (`OMB_RESOURCES_PATH`). Removing that gate alone is not a production implementation.
- The current bridge deliberately uses conversation-only room isolation: no private soul, memory, connected apps or computer access. Full owner-bot execution must get a separate authorized binding, not weaken the room boundary globally.
- `services/cloud/runtime.ts` checkpoint marks provider execution as unsafe to replay. It is not a resumable file/process/session snapshot.
- No current selector migrates a running native process between macOS and a BoxCompute sandbox.

Next bounded implementation is an owner-bot worker-binding contract, with a versioned workspace manifest and an explicit transfer operation: pause at a safe boundary, capture required context/files, verify destination readiness and authorization, fence the previous worker, restore the validated checkpoint, and resume under one execution lease. Unknown side effects must remain held for review rather than replayed. A durable restart operation needs its own receipt and status readback. Secrets require per-destination grants; macOS application sessions cannot be copied as generic files.

Acceptance for full cloud requires the Mac completely offline while the phone reads history, submits work, receives progress and configures/restarts a worker on an independently hosted control service. Handoff acceptance requires reconnect/restart fault injection with no duplicated execution or lost files. Neither acceptance has been claimed by this change.

## Integrated phone change

Build 138 replaces the large pinned mascot grid with compact bot rows and explicit thread expansion. Recent activity/name/unread sorting, scoped pins, visibility controls, current-thread picker and exact-thread navigation use the owning connection. Hidden bots remain available in active-work filters. The hidden count uses the same scoped identity as the visibility control.

Bot settings add standing instructions, reviewable skill toggles, scoped permissions, and the next-turn tools-computer selector described above. Push registration reports each paired home's registration state and retries after reconnect. A failed draft unlock now detaches the previous archive and clears the visible composer rather than leaving another thread's text in place.

Consolidated checks before phone installation:
- Swift package: 1,007 tests, 4 skipped, zero failures.
- Server TypeScript check: passed.
- Isolated bot-profile, profile-soul-guard, request-auth and companion routes suites: 161 tests passed.
- Initial UI run found a missing explicit picker and a stale composer on keychain failure. Both were fixed. Visibility automation now taps the actual switch and checks its value, instead of tapping the encompassing label.

Server-dependent settings require the matching server code to be installed. Promoting source to prod/release does not restart or update the user's running desktop server. Full independent runtime, runtime restart from phone, durable cross-server authority and live task transfer remain separate unfinished work, not capabilities of this build.

Final UI evidence:
- CompactRosterUITests: 2 passed (exact thread/picker and hide/restore), result `/tmp/bos-companion-control-ui3.xcresult`; screenshots inspected.
- ThreadNavigationUITests/testSwitchingThreadsKeepsSeparateUnsentDrafts: passed, result `/tmp/bos-companion-control-draft2.xcresult`. A preceding run found simulator draft contamination; debug preview tokens now use an isolated per-test namespace. Another run failed before executing due to a stale test-runner installation; reinstalling only the simulator test runner resolved it.
- Release device build: passed; code signature verified; bundle build 138. Release behavior is from cdab58f77; subsequent source changes only add DEBUG fixture isolation and verification notes.

## User-directed UI correction — build 139

Firaz rejected the compact roster in build 138. The original pinned mascots, chat rows and chat header are restored. Holding a pinned bot or chat row now opens the native iOS liquid-glass context menu with up to eight recent threads and an All threads entry. Ordinary taps retain the prior behavior. The compact roster component/tests were removed. Draft and push-registration reliability fixes and functional bot settings remain. Build 138's navigation screenshots are historical evidence, not the accepted final design.

Build 139 UI acceptance: `HoldThreadPickerUITests/testHoldBotChoosesExactThreadWithoutChangingHomeLayout` passed in `/tmp/bos139-hold.xcresult`. It verifies the original roster, holds the chat row, pins the bot, holds its mascot, chooses the iCloud sibling thread, verifies its exact transcript, returns and unpins. The exported native glass-menu screenshot was inspected. No compact roster or new chat-header selector remains.

## Glass polish and simpler home — build 140

After accepting build 139, Firaz requested more liquid glass across the app, then removal of the All/Unread/Waiting/Running row. The row and its obsolete filtering logic are removed; attention items, unread badges and existing bot/chat ordering remain.

The existing shared native glass material now covers thread action bars/progress, computer and browser controls, attachment/media controls, the composer command menu, the latest-message button, pairing guidance and settings details. The settings computer card and icons use the same material. Transcript and roster layout remain as accepted in 139. Reduce Transparency uses solid semantic/tinted surfaces with a visible border. No new navigation model, server operation or permission change is introduced by this polish.

Build 140 verified: all three HoldThreadPickerUITests passed (light settings, dark settings, and exact hold-to-select thread flow) in `/tmp/bos140-final.xcresult`. Exported home and settings screenshots were inspected; the status filter row is absent. Release device build succeeded and its code signature verified. Installed over build 139 on the paired iPhone, launched successfully, and independent CoreDevice app inventory reports com.aihlete.aios version 2.1.0, build 140 (`/tmp/bos140-install.json`, `/tmp/bos140-launch.json`, `/tmp/bos140-apps.json`). Physical visual acceptance remains the owner's; simulator screenshots are not physical-device screenshots.

## Phone gateway repair and visible computer switch — build 141

The owner screenshot exposed a missed transport boundary: the companion's default-deny allowlist omitted both the skill review routes and `/runtime`. The desktop already served skills (read-only production inspection returned 22 installed skills), but the phone gateway returned `no route` before forwarding. Add only GET skills list/text, PATCH skill enablement, and GET runtime; skill import/delete, extra paths and unpaired access stay closed. Server admin scope, reviewed hash checks and exact-thread runtime checks remain in force.

ComputerView now has an accessible Switch computer button opening the existing exact-thread selector in a sheet. Dismissal refreshes the preview. The sheet receives the selected chat's projected Bot, not the roster's current thread. Selection remains a deferred tools destination, not runtime migration.

Verification:
- Companion routes, real proxy/harness integration and request-auth: 166 tests passed (`/tmp/bos141-proxy-tests2.log`). Integration installs an offline skill only in the fixture home, reads its text, rejects stale hashes and extra patch fields, toggles with the reviewed hash and verifies readback. It also selects/resets an exact thread through the proxy and verifies import denial.
- Companion TypeScript check and full desktop build passed.
- BrowserViewerUITests/testComputerPickerSavesAndReadsBackThreadSelection passed in `/tmp/bos141-picker3.xcresult`: open switcher, pick Browser, confirm, verify server readback, dismiss. Two earlier checks used the wrong accessibility query for a combined SwiftUI Menu; explicit accessibilityValue now exposes its selected computer. Screenshot inspected in the simulator.
- Independent security code review found no blockers; checked paired-device auth, admin gating, narrow paths, skill content/hash enforcement and selected-thread projection. This review was code inspection, not physical-phone testing.
- Device Release build and desktop package installation evidence follows separately; source promotion does not update a running gateway.

Build 141 physical install: the final device Release build passed (`/tmp/bos141-release2.log`), code signature verified, CoreDevice installation and launch both returned success (`/tmp/bos141-install.json`, `/tmp/bos141-launch.json`). Independent installed-app inventory reports com.aihlete.aios version 2.1.0, bundleVersion 141 (`/tmp/bos141-apps.json`). The desktop gateway is still the installed 8be616fbd build until the owner applies the prepared update; no live server restart or app replacement was performed.
