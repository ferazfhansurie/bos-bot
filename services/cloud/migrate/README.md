# Legacy migration rehearsal

Operator-only copy rehearsal with explicit serving projection. `inventory`,
`freeze`, `import`, `validate`, `project`, `verify-projection`, `cutover`, `archive`
and pre-cutover `rollback` are implemented. Production URLs and live source
directories remain forbidden. This tool does not install or promote a release.

Run with Node >=22.22 (Node 24 in release), from the repo root. A loopback database
named `bos_migration_rehearsal_<suffix>` and an explicitly marked copy are required.
The real `~/.bos-bot` path is rejected, even through a symlink. The marker is
`.bos-migration-copy.json` containing a stable `source_install_id`. Source changes
between inventory and import/validate fail closed. Public application roles have
no grant on the migration schema. Import and projection never dispatch an
invocation, queue or bot. Cutover emits one durable `authority_changed` room event
and publication job per mapped room; historical messages never pass through the
send route or invocation dispatcher.

```
BOS_MIGRATION_URL=postgres://owner@127.0.0.1:PORT/bos_migration_rehearsal_test \
  node services/cloud/migrate/tool.mjs inventory /path/to/marked/copy workspace-id
```

Repeat with `freeze`, `import`, `validate` and `rollback`. IDs are UUIDv5 scoped
by install/type/source ID. Original JSON is stored without JSONB normalization;
ordered transcript payloads, NUL and lone surrogate text survive. Batches commit
records and checkpoint together under a workspace advisory lock. Restart resumes
at the committed checkpoint. Every message remains quarantined until explicit
author and current-grant mapping is verified; pending work remains inert.

`rehearse.mjs` builds a disposable local PostgreSQL cluster, snapshots SQLite
through its online backup API, copies designated metadata, root transcripts and
the owned attachment tree (never provider credentials or browser profiles), kills a child
after batch one, resumes, imports twice, checks hashes, rejects tampering and
cutover, then rolls back. Copies and PostgreSQL together are capped at 3Gi and
removed in `finally`. Evidence contains counts/hashes only, no conversation text.

```
BOS_MIGRATION_EVIDENCE=/absolute/evidence/path node services/cloud/migrate/rehearse.mjs
BOS_MIGRATION_REAL_COPY=1 BOS_MIGRATION_EVIDENCE=/absolute/evidence/path \
  node --max-old-space-size=4096 services/cloud/migrate/rehearse.mjs
```

The inventory understands the persisted version 1 actor bindings, owner/member
registry, linked homes and shared-room snapshots, including their journal file.
It includes every root `messages-*.json` transcript, its raw branching
payload, SQLite rows in their original row order, every owned attachment file
(orphans and partials included), and message attachment references. It hashes
attachment bytes without following symlinks or external paths. Different JSON
and SQLite copies of a message are quarantined; JSON-only additions to an
already populated SQLite thread are also conflicts, preventing stale files from
resurrecting deleted history. A transcript with no SQLite rows is imported in
file order. Previous inventory digests change with this format: rollback and
reinventory an inert rehearsal instead of resuming an older digest/checkpoint.

Apply cloud migrations through `005_migration_authority.sql` to the throwaway
database before `project`. It creates the actual `cloud.*` serving rows in one
transaction. RLS hides the staged workspace from discovery, history, mutation
and worker reads until cutover; the request role cannot change its authority.
Do not grant the application role access to the private migration schema.

`BOS_MIGRATION_PLAN=/absolute/plan.json` supplies a version 1 reviewed manifest:

```json
{
  "version": 1,
  "source_install_id": "fictional-install",
  "source_digest": "sha256 from inventory",
  "reviewed_current_grants": true,
  "reviewer": "mapping reviewer",
  "name": "workspace name",
  "members": [{"account_id":"existing-account", "role":"owner", "evidence":{"type":"membership", "id":"source-membership-id", "digest":"source-record-sha256"}}],
  "authors": [{"source_author":"human:source-actor-id", "account_id":"existing-account", "issuer":"verified issuer", "subject":"verified subject", "evidence":{"type":"actor", "id":"source-actor-id", "digest":"source-record-sha256"}}],
  "rooms": [{"source_id":"source-room-id", "evidence":{"type":"room", "id":"source-room-id", "digest":"source-record-sha256"}, "thread_ids":["source-thread-id"], "grants":[]}]
}
```

All account IDs must already exist from verified sign-in. Author bindings match
the exact issuer and subject; source evidence is checked against the inventory.
`human:<sender.id>` binds an actor; `bot:<from.botId>` binds a source bot to its
explicitly reviewed owner account. A missing legacy stamp requires a per-message
`message:<source-message-id>` entry with that message's evidence. Display names,
implicit owners and linked-home claims never create identities or grants.
Thread ownership must exist in the room's source record. Guest room grants are
explicit `{account_id,evidence}` entries whose evidence names that same room and
whose source person is in its current roster. Member roles must match the source
membership ledger (`client-guest` becomes canonical `guest`); a manifest cannot
turn a source guest into an owner. The persisted `ownerId` is explicit evidence,
and can bind the owner without guessing from an unstamped message. Owners/admins/members retain the
canonical service's workspace visibility; guests require a room grant.

For a shared-room snapshot, set `source_type:"shared_room"` on its room mapping,
use that room's ID as its source thread ID, and bind full `home:person:id` or
`home:bot:id` identities. Its message's actor stamp can supply binding evidence.
Messages preserve canonical snapshot order, replies and deleted-at tombstones.
An unconsolidated shared-room journal quarantines that room's snapshot history;
the migration never replays its append inputs as new work. Consolidate and
reinventory the copy explicitly before reviewing a new projection. Generated
room/message/thread IDs match the source-type mapping ledger.

Legacy 1:1 bot threads (a bot record's `threadId` plus its tasks' thread IDs,
owned by no room) map as one private room per bot: `source_type:"bot_threads"`,
`source_id` = the bot ID, bot-record evidence, and an owner-role grant only.
Such a room is refused while any non-owner, non-guest member is mapped, because
the canonical service shows every room to owners/admins/members. In that room an
unstamped bot reply is the thread's bot. A deleted bot (stamped in messages, no
bot record left) binds with `{"type":"retired_bot","id":botId,"digest":sha256(JSON
of the sorted message record IDs naming it)}`; the digest is recomputed from the
inventory and refused when it differs or a live record exists.
`node migrate/plan.mjs <copyDir> <ownerAccountId> --reviewer name` generates this
manifest: the owner, every bot, every room/shared room/bot room, per-message
owner bindings for unstamped servable messages, and other humans only from an
explicit `--accounts` mapping file.

Payloads serve only when they are plain text (`text`, `markdown`, and the
plain-text fallback of `routine.run`/`goal.run`) from a user or bot role without
a tool/card/secret/screen/comm field. Everything else quarantines by kind:
`legacy_tool_activity`, `legacy_approval_card`, `legacy_secret_request`,
`legacy_screen_capture`, `legacy_turn_receipt` (digest/compaction chips),
`legacy_executable_payload`, or `unsupported_legacy_payload`.

Unmapped authors/threads, missing grants, conflicts, cards/pending work and
attachments without a verified transfer remain quarantined. Attachment objects
are inventoried and retained, not certified as scanned or downloadable. Serving
text preserves Unicode/NUL/surrogates, source order, versions and reply links;
deleted rows expose empty text while the original payload stays operator-only.
Mentions are inert on imported history. Historical bot IDs carry provenance
without registering a runnable bot or host.

`verify-projection` verifies source staging and mapping hashes plus serving and
quarantine digests. A separate reviewer must read exact staged history and grants
through an owner connection and prove staging is hidden through the request role,
then provide `BOS_MIGRATION_ACCEPTANCE` containing
`reviewer` (different from the plan reviewer), `evidence_digest`, `source_digest`,
`plan_digest`, `projection_digest` and `quarantine_digest`. Acceptance of the exact
quarantine set is deliberate, never an implicit assertion that all history served.

`cutover` rechecks those digests under the workspace authority lock, advances the
epoch, activates RLS visibility and publishes
`authority_changed {workspace_id,epoch,reason:"migration_cutover"}` atomically.
Old operation namespaces and cursors cannot cross the epoch. Clients re-discover,
reset cursors and retain legacy drafts for human review. The database commits
before the legacy flag changes: a crash leaves the old writer frozen, and a retry
repairs the flag without emitting duplicate events.

`archive` records a hash/count retention manifest and keeps the source files and
legacy writer frozen. It never deletes the original backup. Pre-cutover rollback
removes staged cloud rows and the private import ledger, then clears the copy's
flag. After `cloud_active`, rollback refuses; recovery is forward repair. Real
pilot identity/grant review, attachment transfer/scanning, installed client reset
acceptance and release approval remain separate gates.

Run the fictional serving test (temporary PG, real request role and HTTP):

```sh
node --experimental-strip-types --test services/cloud/test/serving-migration.test.mjs
```
