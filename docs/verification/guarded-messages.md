# Guarded external messages

External interfaces can submit a pinned task message through
`POST /api/bots/:botId/messages/guarded`. Check the authenticated
`GET /api/health` response for `capabilities.guardedMessages: 1` first. An older
runtime must not receive a fallback request to the ordinary send route.

The guarded request includes `text`, `threadId`, a stable `sendId`, and the
`expectedActiveLeafId` from the task's current message page. An empty task uses
`null`; a newly created bot may already have a greeting and a non-null leaf.
The runtime admits new work only while the task is idle, has a free slot, uses
Ask mode without automatic or remembered approvals, and still has that leaf.
It returns the original receipt for an already accepted matching send.

Run the permanent isolated HTTP checks:

```sh
pnpm exec vitest run server/guarded-messages-api.test.ts
```

Each case launches the prescribed `control-omb` verification server in a fresh
home and uses only its gated fake provider. The test records the exact HTTP
requests, `control:omb` commands, bounded transcripts and wait results next to
the server log in a `.log.guarded-messages.json` receipt. Temporary homes and
their child processes are closed by each fixture.

The checks cover strict input and authentication, foreign task refusal, lost
response recovery, changed-leaf rejection, Ask/automatic/remembered approval
settings, busy/capacity refusal without enqueueing or steering, concurrent
guarded admissions, and duplicate receipt identity. A running ordinary turn
remains unchanged when a guarded send is refused. Ordinary composer sends
retain their existing behavior; this endpoint does not prohibit a later human
message from steering or queueing through the ordinary route.

The coordination case gates one real fake-provider teammate after the source
provider has settled. A no-op Ask settings update proves the source's raw busy
flag and dispatch reservation have both cleared; the guarded send still gets
`guarded_busy` because that conversation parks messages behind its teammate.
The transcript and queue stay unchanged, and releasing the gate completes the
original request. Its bounded commands and results are retained beside the
fixture log in a `.log.guarded-coordination.json` receipt.

On 2026-09-20, all six cases and the server TypeScript check passed with real
isolated runtime processes after rebasing onto public `main` at `c08fc0de`.
These fixtures do not qualify real providers, Slack delivery, production
deployment, or a worker connected to a customer workspace.
