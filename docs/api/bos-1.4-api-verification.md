# BOS 1.4 API verification

All test mutations used disposable fake-provider fixtures. No live app/data mutations, live provider calls, install or restart.

Final integration verified by api on `v14/api-server`:

- `pnpm typecheck`: passed.
- `pnpm build:server`: passed, including server bundle generation.
- Changed TypeScript files: `oxlint --deny-warnings` passed; `git diff --check` passed.
- Message priority, fallback unit/HTTP, pruning unit/HTTP, Chief busy-room edits and guarded messages: 32 tests passed across seven files (vitest run at 05:04:02 on 2026-10-05).
- Integrated room refused/uncertain receipt and pasted explicit steering fixtures: 3 tests passed, 18 unselected (05:05:41).

Independent API subwork verification reported before integration:

- Full room parallel runtime and Chief-room fixtures: 22 tests passed.
- Fallback service and real-server fixtures: 15 tests passed; related Store/approval/profile/provider/guarded regressions: 147 passed.
- Existing steering HTTP fixtures adapted to explicit enqueue then steer: 20 passed, 3 unavailable-ACP cases skipped.

Verified before final integration:

- Message priority, channel queues, send idempotency, dispatch guards and composer attachment handling: 100 tests passed across six files (2026-10-05, vitest run at 04:53:22).
- Attachment quota/pruning and attachment startup/upload handling: 50 tests passed across five files (vitest run at 04:50:16).
- Guarded message HTTP fixture: 6 tests passed (vitest run at 04:48:36).
- Direct queue module: 22 tests passed; ACP e2e excluded from this unit run.
- Changed queue/storage files: oxlint --deny-warnings passed; git diff --check passed.

New message-priority tests were red on base before implementation (default sends steered, invalid priority accepted), then green. Room pending-chip HTTP projection was separately red before channel queue snapshot/listener implementation, then green.

Concurrent block receipts exposed both conflicting admission and late provider teardown before the fix. The final integrated four-case priority fixture passes, including two simultaneous blocks with queued work retained.

Baseline limitation: `server/steer-queue.test.ts` ACP fixtures fail with provider instance `steer` unavailable. The same representative failure was reproduced on untouched prod `44031e67` with `pnpm exec vitest run server/steer-queue.test.ts -t 'queues sends while busy'` (04:51:44). No claim that the full repository suite passes.

Known scope limits: fallback configuration is through the normal bot HTTP profile endpoints; native profile proposals and paired cosmetic edits do not expose it. Unsent browser drafts older than 24 hours have no persisted attachment reference. Unknown provider reset timestamps do not trigger automatic return to primary. Shared-room attachment storage is unchanged.

The single auth/data review is requested from bos against the completed branch. Ship owns cross-owner merging, the 1.4.0 version bump, packaging, update-feed publication, installed-app checks and release acceptance.
