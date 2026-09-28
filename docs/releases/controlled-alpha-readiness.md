# Controlled-alpha readiness evidence

This is an evidence checklist, not installation or publishing authorization. The supplied manifest is intentionally blocked: it describes a dirty staging draft with no certified release artifacts or device acceptance. Do not change booleans merely to make the gate green.

```sh
node --test scripts/bos-readiness.test.mjs
node scripts/bos-release-readiness.mjs docs/releases/controlled-alpha.manifest.json
```

The validator exits 1 for gaps and 0 only when required claims, existing evidence files and artifact hashes are present. Paths are relative to the manifest. It cannot prove a signing receipt, reviewer claim, device screenshot or approval is authentic: a release owner must inspect evidence. A passing report is not permission to release.

1. Freeze all changes into one reviewed clean commit and capture the full hash, diff, tests and exact build commands. The draft manifest base commit is not the final candidate commit. Record typechecks, relevant isolated workflows, regression tests and independent review, including not-run checks.
2. Verify packaged identity: staging uses `ai.bos.bot.staging`; the live desktop identity is `ai.bos.bot`. Record platform bundle/package identity and separate storage locations. Confirm staging cannot adopt live conversations, pairing, drafts, approvals or updater destination. Inspect the actual packaged server, not only source files.
3. Build macOS, iOS, Windows and Android separately. Record exact version/build, source commit, toolchain, artifact path/SHA-256, signing identity/entitlements and build log for each. Verify native artifacts on the appropriate OS/device. A cross-platform source change or Mac test does not verify Windows/Android. Development signing is not notarization or store approval.
4. Establish a BOS-owned controlled-alpha destination and verify updater metadata/signatures, package URLs and access scope. Do not trigger inherited upstream release workflows. Record current and proposed builds per pilot device; no automatic channel rollout.
5. Preserve durable active-work checkpoints, chats, tasks, drafts, pairing and pending approvals. Name one external recovery/installation owner with a proven continuation route. Honor quit/maintenance locks; use bounded retries and one rollback, never competing restart/install loops or replay of uncertain external actions.
6. Obtain explicit approval for immutable artifact hashes and named target devices, separately from publication. Install only within that scope, with rollback bytes and procedure already verified.
7. Record installed identity/hash/version and device-visible acceptance: launch, connection, first conversation, attachments, drafts across navigation/restart, pairing, approvals, reconnect/recovery and notification behavior. For mobile, verify the actual phone-to-packaged-server route. Record platform limitations and untested paths openly.
8. Re-run the manifest gate after evidence is collected. Keep configured, tested, packaged, installed and device-verified statuses separate in release notes. Public distribution remains a separate decision.
