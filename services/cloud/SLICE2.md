# slice 2 local issuer contract

Base: `6556508f4`. Everything below is disposable localhost state. No deployment,
production D1, real email, installation or running BOS restart is involved.

## run

Use Node 24 and the repository workspace dependencies, including the declared
control-plane Wrangler 4.125.0. Install service dependencies separately with
`npm ci --prefix services/cloud --ignore-scripts --no-audit --no-fund`.

```sh
node --experimental-strip-types services/cloud/local.ts
# Independent races only:
node --experimental-strip-types services/cloud/local.ts --acceptance-hooks
```

`local.ts` uses `cloudflare/control-plane/node_modules/wrangler`, applies D1
migrations 0001–0005 with `--local` to its own temporary persistence directory,
and launches `wrangler dev --local` with `wrangler.local.jsonc`. It launches an
owned PG cluster, applies service migrations 001–002, enables fsync/synchronous
commit, and uses non-owner `cloud_app` with forced tenant RLS. No hosted IDs or
credentials are used. Normal service startup has no test routes.

The JSON contains `issuer_url`, `otp_url`, `url`, `ws_url`, `state_path`,
`fixture_directory`, `local_d1_directory`, `fixture_pid`, `issuer_pid` and
`postgres_pid`. State includes fixture scheduling credentials and stays mode
0600. Ctrl-C/SIGTERM to `fixture_pid` stops the exact children and removes its
own PG and D1 directories. Do not kill by process name.

The launcher picks free ports. Set renderer `CLOUD_ISSUER_URL` to `issuer_url`
and its room proxy target to `url`. Default permitted renderer origins are
`http://127.0.0.1:5173`, `http://localhost:5173`, `http://127.0.0.1:5199`.
Set `CLOUD_ALLOWED_ORIGINS` to an explicit comma-separated replacement before
launch for another dev origin. Websocket Origin is checked too. Cookie-bearing
writes require an allowed Origin; native signed bearers do not require Origin.

## sign in

1. Issuer `POST /api/auth/email-otp/send-verification-otp` with
   `{email:"alice@example.test",type:"sign-in"}`.
2. Operator tooling reads issuer `GET /__dev/otp?email=alice%40example.test`.
   It returns `{email,otp,type}`. This route refuses browser Origin, provides no
   CORS, and exists only in the separate `src/local.ts` worker entrypoint.
3. Issuer `POST /api/auth/sign-in/email-otp` with `{email,otp}`. Web preserves
   the HttpOnly SameSite cookie; native stores the signed `set-auth-token`
   response header. The JSON raw session token is not the native bearer.
4. Fresh issuer `GET /v1/me` accepts the protected cookie or signed account
   bearer and returns `{user:{id,email,name,emailVerified}}`.
5. Room `GET /v2/me` returns `{account_id,issuer,subject,service,validated_at,
   expires_at}`. `subject` is the immutable Better Auth user ID, never email.
   Operation-window responses provide the full existing workspace namespace.

The dev worker only permits fictional `*@example.test` OTP requests and sign-in.
Its sink never invokes an email binding. Production `src/index.ts` has no import
of `src/local.ts`; deployed auth continues requiring HTTPS and secure cookies.

Web sends the cookie through its same-site dev proxy and starts websocket auth
with `{type:"authenticate"}`. Native uses Authorization Bearer on HTTP and
`{type:"authenticate",bearer}` on websocket. No credentials go in URLs.
Namespace/cache/keychain separation stays `service|issuer|subject|workspace`.

## fresh authority and wire errors

Every room identity validation performs server-to-server GET `/v1/me`, forwards
only the selected account credential, bypasses positive/cookie caches, rejects
redirects, and has a 3-second total deadline. Assertions are service-bound,
contain no grants, and expire within 15 seconds. Sensitive mutations validate
again after the PG authority-lock wait; reads/publications validate under current
PG authority too. No protected publication outlives its assertion.

Issuer session checks use D1 `withSession("first-primary")` and Better Auth
`disableCookieCache:true, disableRefresh:true`, preserving the binding interface
used by the D1 adapter. See [Cloudflare’s consistency contract](https://developers.cloudflare.com/d1/best-practices/read-replication/). Immutable identity restoration cannot restore revoked
sessions or PG grants. D1 is never queried directly by the room service.

- Issuer 401 -> room HTTP 401 `{error:"session_invalid"}` or error stream frame.
- Timeout/network/5xx/malformed issuer response -> HTTP 503
  `{error:"identity_unavailable",retry_after:1}` or error stream frame.
- Current PG grant removal -> 403 `forbidden` immediately after removal commits.

`POST /api/auth/sign-out` revokes the issuer session. Cached cookies and the same
signed bearer are rechecked against D1. A new OTP session retains the same subject
and account but receives only currently held PG grants.

## invite publication outbox

Migration 002 adds tenant-fenced `invite_outbox`, with no token material. Invite,
invitation room bindings and its pending publication intent commit together. Actual HTTP
publication holds the workspace authority lock and freshly validates the issuer;
only then is its intent marked published. Pending invitations cannot preview or
redeem. A publication exception reaps the invitation and intent; if the process
crashes or cleanup cannot finish, the durable worker reaps pending rows after
15 seconds. Published invitations survive reaping. Existing slice-1 invitations
are backfilled as published.

HTTP acknowledgement remains subject to network ambiguity: bytes already admitted
may arrive later. Pending records cannot confer membership, and no pending token
is stored in an outbox or retried as an external effect. Slice 2 sends no emails.

## test-only boundaries

`app.ts` is the real room entrypoint, and `npm start --prefix services/cloud`
selects it. It requires `CLOUD_DATABASE_URL`, `CLOUD_ISSUER_URL` and
`CLOUD_SERVICE_URL` for local throwaway state. Its module graph contains neither
`stub-issuer.ts` nor `fixture-http.ts`; no environment flag can enable stub sign-in.

`fixture.ts`/`npm run fixture --prefix services/cloud` retains the slice-1 stub
for existing tests. `local.ts --acceptance-hooks` supplies secret-gated scheduling
routes on the real issuer fixture; `/v2/test/sign-in` still returns 404. Stub
session/outage/revoke controls are rejected on that real issuer fixture. Use
actual issuer sign-out or stop the owned issuer for revocation/outage evidence.
