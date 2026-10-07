# cloud room v1 / slice 1

Normative slice: D03/D04/D05 + `slice-1-freeze.md`. Decimal sequences are strings;
never convert to JS Number. All IDs in examples are fictional. No legacy routes changed.

Every protected HTTP request carries issuer bearer in `Authorization: Bearer ...`.
No actor/role headers are trusted. Stub sign-in only exists in the isolated test server.
WS authenticates with first `{type:"authenticate", bearer:"..."}` frame (no URL token).
All routes bind workspace and account using authoritative current membership.

Routes (JSON, error = `{error: <ERROR_CODES>, retry_after?: seconds}`):

- POST `/v2/test/sign-in` `{subject}` -> `{bearer, account_id, issuer, subject, service}` (test stub only)
- GET `/v2/me` -> same identity without bearer
- POST `/v2/workspaces` `{name}` -> `{workspace_id, role:"owner"}`
- GET `/v2/discovery/sync` -> `{workspaces:[{workspace_id,role,rooms:[{room_id,thread_id,policy_revision}]}]}` (full authorized replacement; removes first)
- POST `/v2/workspaces/{w}/rooms` `{name}` -> `{room_id,thread_id,policy_revision}` (owner/admin)
- POST `/v2/workspaces/{w}/invites` `{role, room_ids, subject?:string, expires_in_seconds?:number}` -> `{invite_id,token,expires_at}`; owner/admin, one-use, hashed token
- POST `/v2/invites/preview` `{token}` -> issuer/workspace/inviter/access (authenticated; never redeem)
- POST `/v2/invites/redeem` `{token}` -> `{workspace_id,role,room_ids}` (explicit action)
- DELETE `/v2/workspaces/{w}/invites/{id}` -> `{revoked:true}`
- DELETE `/v2/workspaces/{w}/members/{account}` -> `{removed:true}` (last-owner protected)
- POST `/v2/workspaces/{w}/operation-windows` `{}` -> `{namespace,window_id,window_token,issued_at,expires_at}`; signed 30d, actor/epoch-bound
- POST `/v2/workspaces/{w}/messages` `SendEnvelope` -> accepted/rejected `OperationResult`; persist entire envelope before first I/O
- GET `/v2/workspaces/{w}/operations/{id}` -> `OperationResult` (actor-only; current room reauthorization for retained receipts)
- POST `/v2/workspaces/{w}/operations/{id}/resolve-not-accepted` original `SendEnvelope` -> acceptance or sealed rejection. Same-key lock races sends. Recovery-unknown cannot seal.
- GET `/v2/workspaces/{w}/operations` -> `{operations:[OperationResult],next_cursor:string|null}` (actor recent 30d, page 100)
- POST `/v2/workspaces/{w}/rooms/{r}/snapshot` `{thread_id}` -> `CloudSnapshot`; server-owned 5m consistent projection at H
- GET `/v2/workspaces/{w}/rooms/{r}/snapshots/{id}` -> same pinned snapshot; reauthorized
- POST `/v2/workspaces/{w}/rooms/{r}/replay` `{thread_id,cursor,snapshot_id?:string}` -> `event_batch` or `reset_required`; <=100 events / 1MiB, empty filtered pages can advance cursor
- GET `/v2/workspaces/{w}/rooms/{r}/history?thread_id=...&before=...&limit=100` -> `{messages,next_before}`; canonical current messages/tombstones, authorized history floor
- POST `/v2/workspaces/{w}/rooms/{r}/read` `{thread_id,intervals:[[lo,hi]],mark_read_through?:string,attention?:boolean}` -> private `ReadCoverage`; max 256 sparse merged intervals, explicit mark-read bounded by acknowledged room head
- WS `/v2/realtime`: authenticate first, then `SubscribeSchema`. Null cursor returns reset with initial snapshot; resubscribe its cursor/snapshot_id. Batches catch up after H, set live only at B. Up to 50 rooms/account; persistent polling covers lost wakeups. Every publication revalidates identity/current authority. Overflow reset/close is recoverable.

Slice 1 has no bot registration, attachment service, run/card/control or edit/delete API.
Selected bot IDs and nonempty attachments fail closed. Human mentions must be current room
members. Plain pasted @text has empty mentions. Events for unsupported optional kinds can
advance cursor; unknown *required* kind/version must atomically block the entire batch and
request upgrade, retaining old projection/cursor. A changed same-key envelope is HTTP 409
operation_conflict. Transport/identity outage is no definitive operation outcome.

Digest is SHA-256 over `canonicalJson` exact frozen envelope. Recursive object keys sorted
by UTF-16 code units, JSON compact UTF-8, array order preserved, no text normalization.
Clients receive digest in receipt; fixtures pin language-neutral digest vectors.

`fixtures.json` is the common corpus. `schema_cases`: parse with named schema, compare valid.
`digest_vectors`: compare hex digest. `reducer_cases`: each starts from `initial`, apply `steps`
and assert the partial `expected`. `outbox` persists original envelope/state; `operation`
updates state only for terminal results, not_found stays checking, recovery_unknown flags
reconciliation. `snapshot` atomically replaces selected projection/cursor/read, preserves outbox,
sets live=false. `frame` validates the whole batch before mutation; dedupe IDs/sequences,
ignore <= snapshot H, ignore other-thread content without changing selection; optional unknown
is skipped; cursor advances including filtered empty pages. `read` replaces private coverage.
`account_switch` clears visible projection/cursor/outbox and sets a new namespace; callbacks
with another `namespace` are ignored. Quarantined old-account outbox may remain in separately
scoped persistent storage; it must never dispatch as the new account. Guest content/drafts are
session memory only. Expected `message_ids` are sequence-ordered selected-thread IDs;
`outbox_state`/`outbox_envelope` refer to the fixture operation; `outbox_empty` means current
namespace. Missing expected flags mean unconstrained, not truthy. Do not replay automatically
on account return or recovery_unknown.

Run wire checks: `node --experimental-strip-types --test shared/cloud-protocol/corpus.test.ts`.
UI and Swift independently run every reducer case; these wire checks are not reducer proof.
