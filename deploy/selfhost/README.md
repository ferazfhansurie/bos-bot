# BOS 2.0 private pilot

This profile runs PostgreSQL, a private Better Auth issuer, room service, worker,
ledgered migrations and Caddy. It never uses the hosted issuer or the legacy BOS
data directory. This is one node; failure of the host stops the pilot.

## Configure and start

Copy `.env.example` to `.env`, set mode 0600, and generate four independent hex
passwords (`openssl rand -hex 24`) and a service key (`openssl rand -base64 32`).
Preserve every secret across upgrades. Set DOMAIN to the actual HTTPS hostname;
configure DNS and a TLS ingress before admitting clients. Defaults bind only
loopback on 18080/18443, keeping existing services and their ports untouched.
An existing authenticated tailnet ingress may proxy to Caddy; use the same
public origin for the private issuer and room service. For direct public TLS,
set BIND_ADDRESS and ports only after checking conflicts and reachability.

Set an email/domain allowlist. Log OTP delivery is a pilot aid requiring the
operator to relay each code privately; it is not self-service email delivery.
For colleagues, set ISSUER_OTP_DELIVERY=smtp with a designated SMTP URL/from
address, then verify actual delivery before claiming invites work. Keep SMTP
credentials and OTP logs private. Uploads remain quarantined until a scanner is
configured; this profile does not claim ready attachments.

Sentry is optional until SENTRY_SERVER_DSN is configured for the designated
aihlete/bos-server project. Room, worker and issuer preload the SDK, record release
and environment, capture unexpected errors, and sample traces at 10%. The allowlist
in shared/telemetry/privacy.mjs removes user identity, requests, message/exception
text, arbitrary metadata, breadcrumbs, source context and span data. Prompts,
OTP/auth data and client conversations must never be sent. Logs, replay and metrics
are disabled. A real startup fault was confirmed in Sentry; deployed events still
need independent verification after installation. Desktop/mobile are separate gates.

From the repository root:

```sh
docker compose --env-file deploy/selfhost/.env -f deploy/selfhost/compose.yml config --quiet
docker compose --env-file deploy/selfhost/.env -f deploy/selfhost/compose.yml up -d --build
docker compose --env-file deploy/selfhost/.env -f deploy/selfhost/compose.yml ps
```

Do not print `config` without `--quiet`: it contains resolved secrets. PostgreSQL
and application ports are not published. The room/worker use non-owner cloud_app
with tenant RLS; issuer_owner owns only the separate issuer database. The owner
credential is confined to PostgreSQL bootstrap and the one-shot migration job.

## Backup, upgrade and diagnostics

Back up both databases using `pg_dump` inside PostgreSQL plus the objects volume,
private `.env`, and Caddy state. Store encrypted backups off this node, keep seven
daily copies, and perform a restore to a separate compose project before cutover.
Retain journals for the oldest restorable backup. Never run `down -v` on the live
project. A volume is persistence, not a backup.

Ship is the installer. All releases require bos's `bin/bos-promote.sh --check`
and the restart guard before installation; this compose profile is not permission
to bypass either. Pin RELEASE_TAG to the approved commit, retain the prior images,
back up, then run the migration job and replace services. Database migrations are
forward-only after cloud writes; reverting an image is not a data rollback.

Check `compose ps`, `/healthz`, `/v2/health`, private issuer `/v1/me`, and worker
logs. Inspect issuer logs only privately (log delivery contains OTPs). HTTP health
does not prove two-human chat, revocation, mobile acceptance, recipient email or
backup restoration. Those checks remain separate release gates.
