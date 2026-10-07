# local slices 3/4 backend

Base: 06036613d. Interface commits: 261f3ece4 + 375dfeaef (latest). Public wire/routes are documented in
../../shared/cloud-protocol/README.md. All operations use current issuer authentication,
workspace/room locks, non-owner forced RLS and durable PG authority. No prod, installation,
restart, real provider call or push transport is part of this change.

- Explicit registered bot mentions atomically accept a source/model pin and invocation.
  Plain text/human mentions do not execute; invalid bot grants or unready/foreign attachment
  reject before message or invocation. Human send idempotency remains the slice-1 journal.
- Hosts register a hashed random credential scoped to original account/workspace/host.
  Claim, heartbeat, context and events require current issuer session and live grants.
  A host must record `checkpoint {replay_safe:false}` before invoking its provider.
  Only unstarted leased work can safely be reclaimed. After provider entry, lease loss holds
  uncertainty. No effect adapter/tool dispatch permission is conferred by this runtime.
- Attempt and decimal fence generation bind events. Source digest pins exact canonical
  source, context has untrusted room-history provenance and a 64KiB text budget. Model is
  recorded for every attempt. Stream deltas are immutable/deduped, <=64KiB each and bounded
  to 1MiB/1,000 per invocation. Final commits share source room/thread and unique result.
- Stop receipt sets held and blocks publication before observation; only matching host
  attempt/control evidence sets stopped_observed. Final-before-stop remains committed.
  Explicit resume requires verified stop. Expired unsafe lease never fabricates termination.
- Approval cards are visible/decidable only by their bound actor's current room authority.
  Version, effect digest, run/attempt/generation and expiry serialize one valid decision.
  Approval removes a human gate; it does not authorize strict/external effects.
- Local objects are immutable, keyed workspace|room|attachment, never by client filename.
  Upload URLs expire after 5min; 10MiB types/sha256 bind allocation. Completion first commits
  verifying, then scans, reauthorizes and commits ready/rejected. Scanner outage stays
  quarantined. Raw downloads/ranges hold current room authority through byte publication.
  Orphans expire at 24h; attached objects are excluded from orphan expiry.
  Upload/scan/download buffers share four concurrent operations per service.
- Removal holds source/host-owner/bot-owner runs, revokes pending cards and denies streams,
  upload/completion/ranges and payload hints. Reconnect uses existing durable room replay
  and operation receipt protocol; control mutations are online-only.
- Push builder emits generic hints once per committed event, account and installation
  across registration/token renewal. Mute and mention-only preferences are enforced. Registration
  binds session, installation, generation, token version, sandbox and seven-day authenticated
  renewal (guest <= fresh assertion lifetime), expiry and mute. No actual APNS send exists.

Run `node --experimental-strip-types --test shared/cloud-protocol/*.test.ts
services/cloud/test/*.test.ts` and `tsc -p services/cloud/tsconfig.json` with node 24.
The isolated fixture supplies fictional bytes and a deterministic test scanner. Real
`startRealCloud` accepts `objectStorePath` and a scanner function; absent scanner is fail
closed and cannot produce ready. CLI `CLOUD_OBJECT_STORE_PATH` configures only storage,
not a real scanner. Production malware scanning and provider transcript parity remain
separate integration gates; test scanner success is not malware/provider certification.

Ownership gates still pending outside this API piece: actual Mac native provider transcript,
web/iOS sim interaction, independent check manifests/races/recovery corpus, merge tests and
bos's single final auth/data/infra review. ship owns merge; no install for this job.
