# bos 1.5: api interfaces

status: interfaces posted 2026-10-05; implementation in progress on `v15/api`.

## piece 1: always-on phone connection (api + mobile)

no new pairing. the phone keeps its existing companion bearer and server identity.

- `GET /api/companion/endpoints` (already served by the companion) -> `{endpoints: [{url, kind: "hosted"|"tailnet"|"lan"|"bonjour", priority}]}`. the cloudflare `hosted` url (priority 0) appears only after the tunnel passes its public health check. the phone only ever switches to urls from this list, never to an arbitrary host.
- resume: reconnect `/api/events` with the saved cursor as today; replay or hydrate when the gap is too old.
- new `GET /api/companion/status` -> `{hosted: {status: "off"|"provisioning"|"ready"|"error", url?: string}, keepAwake: boolean}`. allowlisted for paired phones, read-only.
- new setting `companion.keepAwake` (default off): blocks idle sleep while the hosted endpoint is ready. lid close still sleeps.

## piece 2: thread state (api + ui)

- `WireTask.state` and `GroupTask.state`: `"running"|"waiting-on-you"|"queued"|"idle"|"closed"`, computed server-side, same values bots see in `list_threads`. comes on `GET /api/bots` and the existing event pushes.
- `GroupTask` gains `lastActivityAt?: number` and `closedBy?: {botId, name, at}` (same shape as `WireTask.closedBy`).
- closed = a bot closed it (`close_thread`) or it sat idle for `threads.autoSettleDays` (default 3) with nothing unread, running, queued or pending. room threads now settle too.
- reopen: `PATCH /api/bots/:id/tasks/:threadId` or `PATCH /api/groups/:id/tasks/:threadId` with `{closed: false}`. any new message also reopens.

## piece 4: needs-me + daily digest (api + ui)

- `GET /api/inbox` -> `{items: [{id, kind: "waiting-on-you"|"question"|"failed"|"unread", botId, groupId?, threadId, title, preview, at}], count}`, newest first. `question` = an unanswered card.
- event frame `{kind: "inbox", count}` on `/api/events` whenever the count changes; refetch on it.
- `GET /api/digest?since=<ms>` (default: last 24h) -> `{since, until, counts: {done, started, closed, failed, waiting}, moved: [{botId, groupId?, threadId, title, change: "done"|"started"|"closed"|"failed", summary, at}]}`.
- daily push at `digest.hour` (local, default 9) through the existing notify path with `kind: "digest"`; tapping it opens needs-me.

## piece 5 and 6

no new interface. piece 5 drops the same-section check; `peers` allowlists and hidden bots are unchanged. piece 6 is capture-side only (whatsapp resume after restart, interactive button text saved into `body`).
