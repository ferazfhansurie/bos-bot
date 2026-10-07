# Sentry addition — server piece

User requested Sentry in 2.0 and supplied a designated aihlete credential. Stored
privately at mode 0600; no credential is in this tree, screenshots or evidence.
Agent plugins installed for Claude Code and Codex. Existing mounted MCP belongs to
a different organization; aihlete was provisioned and verified through its API using
only the supplied credential. No other organization's telemetry was used.

Created projects: aihlete/bos-server (node), bos-desktop (electron), bos-mobile
(apple-ios). Only server SDK is implemented in this commit. DSNs are in bos's
private monitor/sentry-aihlete-projects.json; owner builders need only the relevant
public DSN, never the API token. Project creation is not runtime instrumentation.

Server SDK 11.5.0 preloads before Node application modules in compose. Worker and
issuer handled failures, and unexpected cloud HTTP failures, are captured. Auth,
validation and other expected failures are not sent by the HTTP error adapter.
Release/environment tags and bounded trace sampling are configured. Content is
allowlisted before sending; replay/logging/metrics are disabled.

Real application startup fault: launched services/cloud/selfhost.ts room with its
actual SDK preload and deliberately omitted CLOUD_SERVICE_URL. Process exited 1;
Sentry ingested and API readback confirmed:

- Issue BOS-SERVER-1: `Error: BOS runtime error (details withheld)`.
- https://aihlete.sentry.io/issues/7779612524/
- Release bos@2.0.0-sentry-verification-20261008, environment verification.
- App stack frames point to /services/cloud/selfhost.ts at lines 133, 44 and 36.
- No request or breadcrumb entry; no user email, ID, name or IP value.

Verification: privacy tests 2/2, selfhost/issuer tests 4/4, cloud server/runtime
regressions 47/47; both service typechecks exit 0. Production dependency audits
zero findings after explicit ws 8.22.0 and nodemailer 10.0.16 updates. Rebuilt both
images and reran disposable compose sign-in/invite/two-human chat/revocation smoke
with SDK preloads enabled, passed. No production install or restart.

Remaining: desktop SDK, legacy local server SDK, iOS SDK, readable bundled/native
debug artifacts, and actual deployed-event acceptance for each surface. The existing
Node TypeScript service reports direct source file/line without a minified bundle.
