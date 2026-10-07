# Bos self-host piece evidence — 2026-10-08

Source base: ae6deb715; this commit adds compose, docs, an isolated smoke and
database connect grants. Nothing was promoted, installed or restarted in BOS.

- Legacy authority unit + isolated server e2e: 2 files, 76 tests passed.
- Self-host entrypoint: 2 tests passed (empty PG migration, rerun, private issuer
  adapter, workspace creation, worker). Issuer: 2 tests passed (real Better Auth
  OTP, signed bearer, same subject after sign-in, revocation, hostile origins).
- Typechecks: services/cloud and services/selfhost-issuer, exit 0.
- `npm audit --omit=dev` for private issuer: zero vulnerabilities after pinning
  nodemailer 10.0.16. The original 8.0.11 audit failed; no audit auto-fix was used.
- Bos-server disposable project `bos-20-rehearsal-20261008`: compose config and
  both Node 24 images built; PG, issuer and room healthy; worker running.
- Compose HTTP smoke passed twice, including after the issuer dependency update:
  two distinct fictional OTP sign-ins, workspace/room creation, member invite
  redemption, one accepted message from each human, ordered shared history,
  sign-out immediately rejects the bearer, fixture sign-in route absent.
- Initial image run found shared protocol could not resolve zod. Added the
  image-local /app/node_modules link; rebuilt and reran successfully.
- Migration rerun and exact disposable project cleanup recorded in terminal.
  Source contained no legacy user data; OTPs/tokens were held in memory only.

Remaining release gates: ship's legacy copy migration rehearsal (G08), final
merged auth/data/infra review, slice34 acceptance, onboarding integration,
reachable TLS origin, real SMTP recipient delivery, native/phone acceptance,
backup restore, approved promotion and guarded install. HTTP smoke does not
prove any of those. Log-delivery OTP requires operator relay and cannot be
represented as self-service colleague onboarding. Upload scanning remains closed.
