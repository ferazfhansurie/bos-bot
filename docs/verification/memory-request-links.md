# Answer sources and request continuation

Run the safe, isolated regression suite after removing inherited BOSBOT/BOS/OMB/OPENMAUSBOT/AIOS tool capability variables from the invoking process:

```sh
pnpm exec vitest run server/memory-sources.test.ts server/request-continuation.test.ts server/request-auth.test.ts server/memory-request-links.e2e.test.ts server/drivers/agents-proxy.test.ts
swift test --package-path ios --filter RequestContinuationTests
```

The proxy fixture itself strips every one of those namespaces before spawning its stub-bound MCP child. Do not revert that isolation to a spread of compatEnv: canonical aliases override legacy fixture variables.

## Memory attribution

Session-search memory retrievals record exact matching on-disk lines, their file hash, owning bot, source conversation and a random source id. The tool gives the model an explicit `[memory-source:<id>]` marker contract. The model must cite only entries used in that answer. Merely retrieving a file does not label any answer as memory-derived. Memory preloaded into an engine's system context cannot be attributed automatically, so no citation is invented for it.

The answer footer requests only source ids explicitly present on that exact stored bot answer. The server verifies bot, conversation and answer ownership. Sources expire after 30 days and the ledger keeps at most 500 records per bot outside its workspace. Recognized secret-bearing lines are not copied into this ledger.

A correction replaces or removes only the exact cited line at its original position. Both the original whole-file hash and the caller's expected hash must still match. Other changes produce a 409 and require a new review in Memory settings. Writes use the existing protected memory store and journal. The old answer retains its original cited context; future memory reads use the corrected file.

## Continue on phone

Pending approval/question cards offer a QR code and copyable `bosbot://request` link containing only home/bot/thread/message/request identifiers. No bearer credential or pairing code appears in the URL. The resolver requires the workspace owner and the exact still-pending card, and rejects wrong homes, resolved cards, missing cards and cards older than seven days. The phone uses its current paired connection to resolve the identifiers, then rechecks pending state on the fetched transcript before focusing that exact card. It neither signs in nor switches accounts because of a URL and never submits an answer automatically.

The HTTP fixture runs a fake provider against disposable data. It creates a real explicitly cited answer, corrects its entry, verifies the journal and stale-write refusal, creates a pending profile proposal through the actual MCP path, verifies its link, then declines the proposal and checks link refusal. Native parser tests reject malformed, duplicate and credential-bearing URLs. No real accounts, messages or production data are required. Renderer interaction and physical-device acceptance remain separate checks.
