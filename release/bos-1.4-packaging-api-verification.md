# mac signing / build stamp follow-up, 2026-10-05

## cause and fix

The afterPack hook hashes server/ui before electron-builder signs nested native
files. PTY runtime binaries now live in the server tree; signing changes their
bytes, so the no-downgrade guard correctly rejects the old digest.

The configured mac.sign hook delegates to electron-builder's existing signing
helper, retaining its retry behavior and the supplied identity, keychain,
entitlements, hardened runtime and per-file options. At the final outer-app
per-file callback it synchronously refreshes the stamp from packaged source
metadata, after all children are signed and before the outer resource seal.
afterPack still stamps unsigned packages and the other platforms as before.
No digest algorithm, guard rule, source-commit ancestry or prod-head check changed.

The callback must remain synchronous: installed osx-sign 1.3.3 does not await
optionsForFile. Writing the stamp in afterSign would invalidate the app signature.
The hook uses electron-builder's internal macCodeSign helper; its configured-hook
regression should accompany future builder upgrades. Lifecycle reference:
[electron-builder hooks](https://www.electron.build/v26/docs/features/hooks/).

## verification

Node 24.21.0, darwin-arm64, in v14/api-terminal:

- Red: the disposable compiled Mach-O fixture reproduced a valid app signature
  with a stale server digest under the default signer.
- Green: the same fixture uses the configured hook through the builder's hook
  resolver. Its stamp matches both the TypeScript digest and the shipped Python
  guard; codesign --verify --deep --strict passes. Subsequent UI tampering is
  rejected by both signature verification and the guard. Missing/short source
  metadata rejects before signing.
- `pnpm exec vitest run scripts/mac-sign.test.mjs scripts/after-pack.test.mjs server/no-downgrade.test.ts server/updater-build.test.ts scripts/stage-update.test.ts`:
  35/35 passed (11:26:14 run).
- `pnpm typecheck`: passed.
- Changed-file `oxlint --deny-warnings`: passed.
- Builder getConfig for staging.yml and live.cjs: both inherit mac.sign.
- `node --test scripts/release-contract.test.mjs`: 12/13. The existing test at
  line 86 expects extraMetadata to omit bosUpdatePolicy even though live.cjs
  supplies it. The same failure was reproduced from untouched 3d9791a5 files in
  a temporary directory. No release-contract assertions were relaxed here.

## handoff

One infrastructure review from bos remains. Ship owns merging, rebuilding the
real arm64 staging candidate, signature/stamp/guard verification and any guarded
install. No full application packaging, installation, restart, Developer ID
signing or notarization was performed by api. The regression uses an ad-hoc
signature in a disposable app, not the signed release artifact.
