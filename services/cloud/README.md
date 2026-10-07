# isolated cloud rooms — slice 1

Protocol is `shared/cloud-protocol/index.ts`, `README.md`, and `fixtures.json`
from interface commit `ffd3a022d56485a11363a49c2e070d6cb075bbb8`. HTTP/WS route,
authentication, schema, decimal-sequence and reducer rules live in that README.
This service implements that frozen contract using fictional identities and local
throwaway PostgreSQL. Sign in with `POST /v2/test/sign-in {"subject":"fictional_alice"}` (subjects
require the `fictional_` prefix; use `fictional_bob` for the second person).
Every bearer maps to an immutable issuer/subject/account;
request headers cannot select an actor or role. The entrypoint uses StubIssuer;
real D1 consistency/session revocation and recovery remain the separate G01 gate.

## launch, migrate, stop

From the worktree containing this commit (api's source is
`/Users/firazfhansurie/.bos-bot/workspaces/6ca32513-1716-40e6-b006-59a6130e3570/cloud-slice-1`):

```sh
export PATH=/Users/firazfhansurie/.nvm/versions/node/v24.21.0/bin:$PATH
npm ci --prefix services/cloud --ignore-scripts --no-audit --no-fund
node --experimental-strip-types services/cloud/fixture.ts
```

The repository's ordinary shared `node_modules` must resolve zod. For lean Mac
worktrees, reuse `/Users/firazfhansurie/Repo/firaz/bos-bot/node_modules`, as the
builders' worktrees already do. Service dependencies install separately (~10 MiB).

The launcher invokes `/opt/homebrew/bin/initdb` and `/opt/homebrew/bin/postgres`,
binds a fresh cluster to `127.0.0.1` on a free port, creates a random
`cloud_slice1_*` database, and applies `migrations/001.sql` before HTTP starts.
WAL/fsync and synchronous_commit remain enabled. It never starts a Homebrew daemon.
The printed JSON includes `url`, `ws_url`, `database_url`, `migration_url`,
`fixture_pid`, `postgres_pid`, and `state_path`; use those exact targets.
`state_path` is a mode-0600 file containing the fictional fixture hook secret.

Ctrl-C stops that launcher, HTTP/WS and its exact PostgreSQL child, then removes
only its own `services/cloud/.fixture/run-*` directory. Alternatively send SIGTERM
to the printed `fixture_pid`. All data is intentionally disposable. To run the
migration separately on an already-created fresh local throwaway database:

```sh
CLOUD_MIGRATION_URL='postgres://cloud_migrator@127.0.0.1:PORT/cloud_slice1_NAME' \
  node --experimental-strip-types services/cloud/migrate.ts
```

The migration is a fresh-schema migration, not an idempotent rerun. `cloud_app`
is created once in that throwaway cluster. Runtime connections require that
non-owner, NOINHERIT, NOBYPASSRLS role; startup checks actual role attributes,
table ownership and RLS flags. Tenant context is set transaction-locally.
Missing context denies tenant rows. Only accounts are global. Receipts, windows,
snapshots, read coverage and acknowledged heads additionally require the actor.
Compound workspace/room/thread foreign keys include same-thread replies.

## deterministic acceptance controls

Controls exist only when the fictional loopback fixture supplies hooks and a
secret; without that combination they deny. Every control requires
`X-Cloud-Fixture-Secret: <hook_secret from state_path>` and JSON content type.
These are test scheduling controls, never production authority.

- `POST /v2/test/hooks/arm`: `{id,point,match:{...}}`.
- `GET /v2/test/hooks`: `{gates:[{id,point,entered,waiting}],worker_paused,drop_notify,worker_fault}`.
- `POST /v2/test/hooks/release`: `{id}`.
- Each barrier is bounded to 5 seconds; at most 32 barriers. Match all supplied
  fields. Arm/release one named barrier per intended winner and record entry.

`point` is `<action>.before_admission` or `<action>.after_admission`, where actions
are `message.send`, `operation.seal`, `operation.lookup`, `operation.list`,
`invite.redeem`, `invite.revoke`, `member.remove`, `snapshot.create`,
`snapshot.page`, `realtime.publication`, `http.publication`, `replay`, `history`,
or `read`. Before means after authoritative identity validation but immediately
before acquiring the real workspace authority row lock. After means the row lock
is held and fresh identity/current membership/room access have been checked,
before executing the operation. Redeem also holds the invite row lock at its
`after_admission` point. It validates expiry/use/revocation after the barrier.

Ordinary details: `workspace_id`, `room_id` (empty for workspace-only actions),
`account_id` (the actor). Send/seal also have `client_operation_id`; removal has
`target_id`; revoke has `invite_id`; snapshot page has `snapshot_id`. Redeem has
`workspace_id`, `account_id`, `token_hash` (SHA-256 of the token), and at its after
point also `invite_id`.

All protected operations lock the workspace authority row `FOR UPDATE`, then
any selected room `FOR UPDATE`, through transaction commit. Send and seal share
that lock and the unique `(workspace_id, account_id, client_operation_id)`
ledger key. Expiry and expected policy revision are checked after lock wait.
Membership removal, invitation redeem/revoke and last-owner checks share the
workspace lock. Discovery locks workspaces in sorted order through publication. Invite preview
also holds its invite/workspace locks through data publication and never redeems.
HTTP data publication is separately reauthorized while holding the same lock;
actual WS publication holds it through `ws.send` admission. Already admitted
bytes may arrive after removal. Thus a concurrent mutation may commit and its
response later be denied; denial never proves the mutation did not commit.

Additional controls:

- `POST /v2/test/hooks/control`: any of `{worker_paused:boolean,
  drop_notify:boolean,worker_fault:"none"|"before_complete"|"after_commit",
  issuer_unavailable:boolean,issuer_stall_ms:0..16000,revoke_bearer:string}`.
  `before_complete` rolls back the claimed queue transaction; `after_commit`
  faults after durable queue completion. New ticks retry persisted pending work.
- `POST /v2/test/hooks/queue-state`: `{workspace_id}` -> queue rows with
  `room_id,event_id,attempts,completed_at` (fictional metadata).
- `POST /v2/test/hooks/redeliver`: `{workspace_id,room_id,event_id}` -> reset that
  queue row to pending to exercise duplicate delivery. It creates no room event.
- `POST /v2/test/hooks/expire-window`:
  `{workspace_id,account_id,window_id,after_ms?:0..5000}` -> set the persisted
  admission deadline to now + after_ms (default 0). Set a future deadline before
  taking a competing lock to prove expiry while send/seal waits for admission.
- `POST /v2/test/hooks/expire-snapshot`:
  `{workspace_id,account_id,snapshot_id,after_ms?:0..5000}` -> same deadline control.
- `POST /v2/test/hooks/rotate-epoch`: `{workspace_id}` -> new authority incarnation.
  Missing outcomes in the prior epoch return `recovery_unknown` and cannot seal.
  This tests the operation contract; it is not a restore implementation.

The transactional outbox and SQL queue reference committed room events by unique
key. LISTEN/NOTIFY is a wakeup; persisted-head polling every 250 ms continues when
notifications or the worker are unavailable. Human-message acceptance requires
message/event/outbox/queue/receipt commit together; it does not imply recipient
reading or bot execution. This slice has no external worker effects. Sockets are
bounded to 1 MiB/1000 pending frames; overflow emits reset if possible and closes
1013. A snapshot too large for the socket recovers through HTTP snapshot plus WS
subscribe with its cursor/snapshot_id. HTTP request bodies allow JSON escaping of
the frozen 64 KiB text bound; text-containing SQL columns use `json` source
storage rather than `jsonb`/text to preserve NUL and UTF-16 escape strings exactly
([PostgreSQL JSON storage](https://www.postgresql.org/docs/18/datatype-json.html)).

## verification

```sh
node --experimental-strip-types --test shared/cloud-protocol/corpus.test.ts
node --experimental-strip-types --test services/cloud/test/server.test.ts
./node_modules/.bin/tsc -p services/cloud/tsconfig.json
```

Server tests launch and clean up their own fresh cluster, advancing the real SQL
worker explicitly so its fault assertions cannot race the automatic timer.
The normal fixture launcher keeps the automatic worker enabled. Tests include real
HTTP/WS two-human exchange, direct non-owner RLS/FK checks, send/seal both orders
x100, lock-wait expiry, invite/owner races, revocation, pinned snapshots,
filtered/large-decimal replay, a fixed signed catch-up frontier across new writes,
private sparse read bounds, queue faults and
socket overflow. They are API-owned checks; check's external intent manifest
and independent a01/a03–a08/a13–a16 results remain separate. Web/Swift reducers,
optimized iOS compilation, real D1 and the final auth/data review are their own
gates. Slice 1 remains local; mentions/reactions and later host/effect slices
keep their recorded scope.
