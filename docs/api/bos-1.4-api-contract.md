# BOS 1.4 server contracts

Base: prod `44031e67`. API integration branch: `v14/api-server`.

## Message priority

`POST /api/bots/:botId/messages` and `POST /api/groups/:groupId/messages` accept `priority: "block" | "queue"`; omitted means `queue`. Invalid values return 400. Existing threadId, sendId, replyToId and room mode fields retain their meaning. Guarded and exclusive routes retain their admission guarantees.

Queue waits until the current turn settles; it does not steer automatically at tool boundaries. Block interrupts the targeted direct thread or current room task, closes provider-owned asks, waits for provider teardown, then starts the new message. Concurrent receipts are serialized per conversation; previously queued messages remain pending. Existing explicit queue steer endpoints remain available.

Queued response: `{ok: true, queued: true, queueId, threadId}`. Pending chips use the existing SSE `bot.queued {queues}` and GET `/api/bots` `botQueuedMessages`; both now include room threads. Each queue entry is `{queueId, text}` (direct capacity waits may also carry `reason: "capacity"`). Cancellation and dispatch remove chips. Retry sendId deduplication remains in force.

## Fallback

Normal `POST /api/bots` and `PATCH /api/bots/:botId` accept `fallbackModel?: string | null`, an exact discovered model ID, optional/clearable. Add `fallbackInstanceId?: string | null` to name the instance that serves it; that explicit choice is the only way a fallback may use a sibling subscription of the same engine (a second Claude account). Native profile proposals and paired cosmetic profile edits do not configure this field. Only compatible current approvals can transfer. No automatic grant escalation or substitution of an unknown model.

SSE envelope: `{kind: "runtime", event: {type: "model.switched", botId, threadId, from, to, reason, ...}}`; `from` and `to` are model ID strings, reasons `provider_limit` and `provider_reset`. The server also records one compact thread line. Provider authentication failures are distinct from exhausted usage. Switching is scoped to the task or room; reset recovery waits for a known reset and available primary. An unknown reset stays on the configured backup. Only clean direct quota failures before tools/output may retry once; room fallback uses usage preflight and does not replay failed turns.

## Busy rooms

Chief manage_room and owner PATCH may update bulletin and membership during a turn; existing team/Chief/auth bounds and secure credential/card safeguards remain. Changing responder behavior or switching tasks while busy retains its guard. Removed members cannot start pending work.

## Attachments

Aggregate cap: 2 GiB. Per image: 10 MiB; per file: 25 MiB. Under quota pressure, oldest recognized uploads without persisted references may be pruned after a 24-hour grace period. Archived/off-branch transcript rows, durable queues, avatars and JSON-backed references remain protected. Reference-read failure prevents pruning. HTTP 507 `{error}` is actionable and reaches the existing paste error/toast path.

Unsent browser drafts older than 24 hours have no server-visible reference. Shared-room attachment storage has its own store and is unchanged.

## Release boundary

API tests use isolated fake-provider fixtures. Ship owns merging, version 1.4.0, packaging, update-feed publication, restart guard and installed-app verification.
