# Bounded phone approval hydration

`CompanionClient.fleetForHydration` fetches up to four background approval
pages concurrently. It deduplicates thread IDs, skips selected transcripts,
and still rejects the entire snapshot if any required page fails. The caller's
cursor and connection-generation checks are unchanged. One slow page still
holds the complete snapshot; this change removes cumulative serial delays.

Run:

```sh
swift test --package-path ios --filter 'WaitingThread|WaitingPages|BotDraft|Transcript'
node scripts/testing/waiting-pages-fixture.mjs
```

The loopback fixture requires only Node and Swift, starts on an ephemeral
port, uses a fixture-only bearer, and closes its HTTP server on completion.
Nine delayed approval pages must all reappear as pending cards; the duplicate
thread must be fetched once and maximum observed concurrency must be 2–4.
It does not contact a real home or change live conversations.

2026-10-11 evidence: the concurrency regression failed before the change
(maximum 1); the focused suite passed 36 tests with the opt-in fixture skipped.
The separate real HTTP acceptance passed with nine pages, maximum concurrency
4, all nine pending approvals recovered, and no replay cursor advancement.
Existing tests also cover failed-page rejection, cancellation, stale snapshots,
and approvals answered by the live stream during hydration.
