# Staff logins on the real web client

Client staff can use the same renderer as the desktop app without pairing a
device or owning a work email. Serve the normal `dist` build from the client's
own BOS server (`OMB_STATIC_DIR`), behind HTTPS, and configure its public URL.
An admin creates staff accounts under Settings → People → Staff logins. The
initial generated password is shown once. Staff open `/pair` and sign in by
username or phone number. Reset or removal revokes that account's sessions.

Use a separate BOS instance and data directory for each client. These logins
are workspace membership, not a tenant boundary: members can use that
workspace's non-private bots and their conversations. Keep unrelated clients,
personal work and Ops on their own instances. Hosted workspaces continue to
use their portal authority; password sign-in is unavailable there.

## Disposable verification

```sh
pnpm exec vitest run server/password-signin.test.ts server/password-signin-stream.e2e.test.ts server/peer-events.test.ts server/request-auth.test.ts server/sessions.test.ts server/environment.test.ts src/lib/session.test.ts
pnpm typecheck
pnpm exec vite build
```

The HTTP fixture proves username/phone authentication, hash-only storage,
admin-only account management, member scope, stable person identity, private
bot/transcript filtering, password reset/removal revocation and lockout even
when concurrent clients delay their request bodies. The fake-engine stream
fixture proves a staff member can send a turn and receive the final reply
live. It also verifies owner-private turns never reach that stream and that
making a shared bot private evicts it and suppresses subsequent turn events.
No fixture uses live accounts, client data, email, WhatsApp or paid models.

Verified 2026-10-15: the targeted tests, type checks and renderer build passed.
Independent review found the person-binding and concurrent-lockout issues;
both were fixed, along with direct reply and bot-update stream projection.
The existing `server/bot-visibility.e2e.test.ts` fails at line 26 on unchanged
prod too (peer contacts), independently of these changes. The BOS browser
preview timed out, so these checks do not prove visual UI acceptance or a
client production deployment.
