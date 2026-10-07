# Independent slice-1 acceptance

Owner: check. Scope: local throwaway PG, stub identity, fictional data only. No
installation, restart, provisioning or production mutation. This directory must
not be imported by the cloud service. No server digest/reducer/DB implementation
may compute the expected answers.

Current state: **partial live acceptance; full matrix pending**. Source protocol commit:
`ffd3a022d56485a11363a49c2e070d6cb075bbb8` (local cherry-pick `8ab9ea4c`).
The HTTP driver uses contract schemas but independently computes intent digests;
it never imports the service digest, reducer or DB code. The fixture and real
admission barriers are bound to api's `7883a6f34`; same-key changed-envelope
scheduling still requires a digest selector in the send/seal hook details.
An oracle/scheduler self-test is not server, client or recipient acceptance.

The oracle freezes exact intended envelopes and expected message fields to an
exclusive manifest file before dispatch. It appends submitted/observed evidence
to a separate journal. Neither `not_found` nor `recovery_unknown` counts as a
terminal result. Canonical messages must occur once with their original text;
missing, duplicate, changed and rejected-operation messages fail reconciliation.
The independent envelope hash is evidence, not an assertion that an unbound
server uses this digest encoding. Binding will freeze the wire encoding separately.

Run foundation checks (Node 24, no dependencies):

```sh
node --test services/cloud/acceptance/oracle.test.mjs
```

Run the binding and wire checks (Node 24 plus the repository's existing `zod`):

```sh
node --experimental-strip-types --test services/cloud/acceptance/oracle.test.mjs services/cloud/acceptance/protocol.test.mjs shared/cloud-protocol/corpus.test.ts
```

`protocol.mjs` exposes `operationEnvelope`, `frozenOperation`, `CloudDriver` and
`recipientMessages`. Create every planned envelope and expected message, then
`freezeManifest` **before** dispatch. Construct each account driver with its own
credential and the external `Oracle`; call `operation(id)` explicitly. Lookup and
seal require `mode: 'lookup'` / `'seal'`. Lost responses do not establish a receipt
and there is no implicit retry. HTTP errors are recorded without inventing a
terminal rejected outcome. Receipts bind the independently frozen digest, key,
room and thread. Recipient messages must match canonical receipt ID and exact
decimal sequence before the oracle checks text, actor and scope.

The driver captures redacted request bodies before transmission and observations
afterward; transport failures retain an unknown trace. Bearer, invite and signed
window credentials are redacted. Private manifest files preserve the original
signed envelope, remain outside service storage, and must not be pasted in chat.

These 15 acceptance self-checks plus 27 wire checks are **not** a01–a16 passes.
The 19 wire fixture cases validate schema shapes only; actual UI/Swift reducer
behavior belongs to those owners. No PG migration, RLS role, server race,
realtime recipient, installed app or physical device is verified by this run.

## Remaining interface gates

- full a01/a03–a08/a13–a16 independent matrix; do not infer it from API-owned tests.
- same-key changed-envelope races: match `digest` in send/seal admission hooks.
  The live probe on `7883a6f34` armed that selector but the send escaped with the
  gate unentered, because the operation hook supplies only the key.
- a16 uses the existing member-removal route: two owners remove each other,
  with both admission orders repeated 100 times. Bos resolved this scope in the
  room on 2026-10-07; no role-change endpoint is required for slice 1.

## Required server coverage

| Case | Required checks | Volume / race |
| --- | --- | --- |
| a01 | Stub sign-in, invite/redeem; two humans exchange exact Unicode and multiline text through canonical room and realtime, host off | independent intended text and recipient projection |
| a03 | Response lost before dispatch and after commit; unchanged-key retries; operation lookup | 1000 intended operations per fault schedule |
| a04 | Changed envelope conflicts; expired never-seen key; retained acceptance after expiry; window swap; missing epoch outcome; seal/delayed-send | seal/send, changed-envelope and expiry-at-admission both orders x100 |
| a05 | Lost NOTIFY; worker outage after commit; duplicate queue delivery and lost claim acknowledgement | 1000 source operations per schedule; accepted message/outbox ledger |
| a06 | Drop/reorder/duplicate events; crash around projection/checkpoint; versions/tombstones and filtered empty cursor batches | 1000 source operations per schedule |
| a07 | Continuous writes during pinned snapshot/reset; H through B; cursor, handle expiry and visibility change | 1000 source operations; revocation/page both orders x100 |
| a08 | Pending socket byte/frame overflow and replay cap; explicit recoverable reset; corrupt cache; unknown required schema; outbox preserved | 1000 source operations; actual bounded-stream traces |
| a13 | Member/guest removal vs send, replay, snapshot and publication; no newly authorized bytes | deterministic protected admission/delivery both orders x100 |
| a14 | Stub issuer outage/revoke/stalled validation; fresh mutations fail closed; established publication deadline <=15s | bounded-clock receipts; real D1/host gates excluded |
| a15 | Every slice-1 direct/indirect HTTP and realtime route with tenant IDs substituted; compound-FK violation; RLS app role unset/wrong context and pool reuse; private read coverage | deny matrix plus sentinel scan; cross-tenant rows inaccessible |
| a16 | Invite expiry/replay/revoke/concurrent redemption; two owners concurrently remove each other | redeem/revoke, double redemption and last-owner both orders x100 |

The HTTP driver must record actual requests/responses and candidate/protocol/base
commits, schema, fixture DB identity and app role. Session/invite credentials are
redacted from journals; only explicitly pinned loopback origin is accepted and
redirects are refused. No automatic retry of an uncertain submission.

`last-owner.mjs` runs only the a16 owner invariant, not the invite scenarios.
It creates two fictional identities and 200 fresh workspaces through HTTP;
each starts with two owners. It holds the losing mutual removal at api's
`member.remove.before_admission` barrier, admits the winner, and then releases
the loser. Each iteration checks committed PG owner rows independently, the
survivor's room snapshot, the removed actor's discovery, and denial of the
survivor removing itself. No service algorithms compute expected results.

After api's server commit, launch its documented fresh fixture and run:

```sh
node services/cloud/acceptance/run-last-owner.mjs \
  /absolute/server-worktree /absolute/printed/state.json /absolute/new-evidence.jsonl
```

The runner rejects uncommitted server files and nonfixture state paths, records
the candidate and actual PG app role, and keeps credentials out of the journal.
The fixture launcher remains owned by its caller and must be stopped separately
using its documented exact PID/signal. This scenario passed 200/200 on both
`6c70f022` and `7883a6f34`; see the dated verification reports. This result covers
owner removal only, not all of a16.

`run-slice1.mjs` is an external HTTP/WS/PG runner with private manifests and
redacted append-only journals. Node 24 requires `--experimental-strip-types`.
Pass a new evidence directory outside the server checkout, and optional case
names. It pins the exact API source and protocol trees before any mutation.
The current committed report lists which selected cases actually ran; other
implemented schedules remain unrun, and a13/a15/invite races still need binding.
Do not use a selected smoke run as the full slice completion gate.

`bothOrders` requires a test-only pause **before actual protected admission**,
waits for the held request to reach it, admits the other request, then releases
the held request. Sequential requests or a fake barrier cannot count as a P0
server race. Hooks must be bounded, disabled outside isolated fixtures, and
serialize at the authority/operation/membership lock that protects the invariant.

Unsupported routes/features are explicit gates, never passing no-ops. Two-sided
browser/native/device outcomes, real D1 consistency, load/restore/host/effects,
and physical interaction remain distinct from this slice-1 harness. Raw results
go outside service/PG storage so service failures cannot erase the oracle.
