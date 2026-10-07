# Independent slice-1 acceptance

Owner: check. Scope: local throwaway PG, stub identity, fictional data only. No
installation, restart, provisioning or production mutation. This directory must
not be imported by the cloud service. No server digest/reducer/DB implementation
may compute the expected answers.

Current state: **foundation committed; server scenarios unrun**. Protocol binding,
HTTP driver and real admission barriers depend on api's first interface commit.
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
| a16 | Invite expiry/replay/revoke/concurrent redemption; parallel removal/demotion of last owners | redeem/revoke, double redemption and last-owner both orders x100 |

The HTTP driver must record actual requests/responses and candidate/protocol/base
commits, schema, fixture DB identity and app role. Session/invite credentials are
redacted from journals; only explicitly pinned loopback origin is accepted and
redirects are refused. No automatic retry of an uncertain submission.

`bothOrders` requires a test-only pause **before actual protected admission**,
waits for the held request to reach it, admits the other request, then releases
the held request. Sequential requests or a fake barrier cannot count as a P0
server race. Hooks must be bounded, disabled outside isolated fixtures, and
serialize at the authority/operation/membership lock that protects the invariant.

Unsupported routes/features are explicit gates, never passing no-ops. Two-sided
browser/native/device outcomes, real D1 consistency, load/restore/host/effects,
and physical interaction remain distinct from this slice-1 harness. Raw results
go outside service/PG storage so service failures cannot erase the oracle.
