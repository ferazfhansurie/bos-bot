# BOS release process

BOS changes are collected into versioned candidates. A successful test or build does not authorize installation. Firaz explicitly held all reinstalls on 28 September 2026; that hold stays in force until he releases it.

## Candidate record

Each candidate has one immutable source commit, user-facing release notes, a desktop version, an iOS build number, test results, known limitations, artifact checksums and signing evidence. Record each device's current and proposed build separately. Rebuilds receive a new candidate revision; do not silently replace approved bytes.

Use local candidate IDs such as `bos-2026.09.28-rc1` while the private release channel is being established. These IDs are not updater versions. Choose and validate the next semantic app version when packaging for that channel; the current source version is a prerelease and the inherited version-bump workflow only accepts stable versions.

## Stages

1. **Draft:** collect the scope and unresolved product decisions. Implement and test in an isolated workspace.
2. **Verified source:** focused regressions, isolated conversation fixtures, typechecks and platform builds pass. Include review findings and their resolution. Record any tests not run.
3. **Packaged candidate:** build all intended targets from the same commit. Verify the actual packaged server, signature, entitlements, runtime flags and artifact hashes. Preserve pairing, chats and drafts. Development signatures are labelled; they are not a public-distribution claim.
4. **Approved pilot:** Firaz approves a specific candidate and named devices. Check those devices' current builds and active work, preserve a rollback and durable continuation, then let one owner install. Do not stop bots or schedule installers while approval is held.
5. **Device verified:** verify installed bytes and health, then the relevant desktop/iPhone workflows. Log results per device; a desktop success does not imply iPhone success.
6. **Published:** a separate explicit distribution decision. Use a BOS-owned release destination and signing/distribution identities verified for that destination. Never trigger inherited upstream publication/mirroring workflows merely because they exist in this fork.

Installation, release publication and automatic-update rollout are separate actions. A candidate may stay in draft or packaged state without restarting any device. Failed health checks roll back once; interrupted external work is not replayed automatically.

## Release notes template

- Candidate and exact source commit
- Desktop version and iOS version/build
- User-visible changes
- Verification performed and evidence paths
- Known limitations and unresolved gates
- Target devices, current builds and proposed builds
- Artifact hashes and signing identity
- Explicit approval, install receipt, rollback and post-install results

Public distribution requires a verified BOS updater channel, proper Mac distribution signing/notarization and an approved iOS distribution route. Existing `.github/workflows/*release*` files describe upstream OpenMausBot infrastructure; they have not been configured or triggered for this BOS release.
