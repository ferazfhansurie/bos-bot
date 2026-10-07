# Legacy migration rehearsal

Operator-only inert staging. `inventory`, `freeze`, `import`, `validate` and
pre-cutover `rollback` are implemented. `cutover` and `archive` deliberately refuse:
legacy author/grant projection into the serving cloud schema and independent
acceptance are still required. This tool does not make the pilot migration ready.

Run with Node >=22.22 (Node 24 in release), from the repo root. A loopback database
named `bos_migration_rehearsal_<suffix>` and an explicitly marked copy are required.
The real `~/.bos-bot` path is rejected, even through a symlink. The marker is
`.bos-migration-copy.json` containing a stable `source_install_id`. Source changes
between inventory and import/validate fail closed. Public application roles have
no grant on the migration schema. No invocation, event, queue or bot is dispatched.

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
through its online backup API, copies only designated metadata (never sessions,
provider credentials, browser profiles or arbitrary client files), kills a child
after batch one, resumes, imports twice, checks hashes, rejects tampering and
cutover, then rolls back. Copies and PostgreSQL together are capped at 3Gi and
removed in `finally`. Evidence contains counts/hashes only, no conversation text.

```
BOS_MIGRATION_EVIDENCE=/absolute/evidence/path node services/cloud/migrate/rehearse.mjs
BOS_MIGRATION_REAL_COPY=1 BOS_MIGRATION_EVIDENCE=/absolute/evidence/path \
  node --max-old-space-size=4096 services/cloud/migrate/rehearse.mjs
```

Remaining: serving projection, complete legacy-file/attachment inventory,
explicit account/grant mapping, authority_changed event, cutover/archive and
post-write forward repair. Do not promote or install this as complete slice 5.
