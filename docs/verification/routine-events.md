# Routine notification choices and named app events

Run these disposable fixtures from the worktree:

```sh
pnpm exec vitest run server/routine-notifications.e2e.test.ts server/routine-events.test.ts shared/routine-notifications.test.ts
```

The notification fixture launches the real server through `launchVerificationServer`,
creates a fake bot and routines through REST, runs the fake engine, reads saved
receipts and report cards, and captures the actual SSE notification bus. It checks
all runs, important updates, failures only, material output and quiet replies.
The event fixture listens on a disposable loopback webhook port and sends real
HTTP requests to prove authentication, exact source filters, paused verification,
activation, durable configuration and retry deduplication. No external providers,
subscriptions, accounts, or user data are touched.

Routine editor → Notifications offers **All runs**, **Important updates**, and
**Failures only**. Old routines default to all. The choice is captured on each run,
so editing it cannot change already queued/running receipts. Logs retain output
regardless of the choice. Quiet markers retain their existing semantics. Important
runs instruct the agent to prefix material final reports with `IMPORTANT_UPDATE:`;
the scheduler removes that marker from the saved summary, and the normal notification
and unread paths use the classification. Requests for input also count as important.
Failures-only keeps request cards accessible through logs/execution, but suppresses
their push notifications. Failures and missed runs always surface.

Tasks / routines → New → **App event / webhook** → Event source offers GitHub
pull requests, GitHub CI workflows and Slack app mentions. GitHub requires an exact
`owner/repository` and optionally an action; Slack requires exact team and channel
IDs. New named sources start paused. Setup produces a matching local curl request;
send it, inspect the captured sample, then turn the source on. This verifies the
relay ingress and configured payload filters, **not** a live upstream subscription.

An operator must separately configure a trusted relay (Composio or another provider)
and its upstream subscription. The relay must verify the provider signature, account
and retry identity, and forward the original provider JSON with the BOS webhook
bearer secret, `X-Webhook-Event`, and a unique `Idempotency-Key`. Native GitHub and
Slack signatures are not validated by BOS's capability ingress. Do not point a
signature-only provider directly at it or expose the bearer secret in payloads.
Slack's envelope is `{team_id,event:{type:"app_mention",channel,...}}`; GitHub uses
its normal repository plus pull_request/workflow_run object. Wrong source, missing
shape and wrong action are ignored before verification or dispatch. The general
custom webhook behavior is unchanged. No subscription is created automatically.

Desktop UI and physical mobile notification delivery are separate acceptance steps;
the automated fixture proves server behavior and wire notifications. Current native
mobile editors do not expose these new choices; they preserve server settings when
editing other fields.
