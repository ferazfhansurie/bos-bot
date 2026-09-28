# Private Mac and iPhone pilot

This evidence gate covers the user's local Mac and iPhone installation for a week of use before any public release. Windows and Android are explicitly unsupported. It does not install, publish, enable an updater, authorize messages, or expand access.

Copy `private-pilot.manifest.template.json` to a candidate record and replace unverified fields only with actual evidence. Run:

```sh
node scripts/bos-release-readiness.mjs path/to/candidate.json
```

The explicit `mode: "private-pilot"` requires `channel.name: "private-pilot"`, `distribution: "local-install"`, a named verified distribution owner, and a channel evidence file recording who controls the local artifacts and intended devices. No HTTPS distribution endpoint is required. Both macOS and iOS still need the exact source commit, version, artifact hash, build/signature records and installed device acceptance evidence. Use hashable artifact files such as a ZIP or IPA, not an app directory. Evidence paths resolve relative to the manifest.

Independent review, passing tests, distinct staging/live identities, a single recovery owner, durable checkpoint, rollback and candidate approval evidence remain required. A passing gate checks recorded evidence and file hashes; it does not independently prove the truth of receipts. Do not mark device acceptance complete based solely on a build, package or health response.

The template intentionally fails. Existing install receipts remain historical evidence; do not rewrite them to imply acceptance of a newer candidate. Record desktop-first onboarding and any unsupported image/Office generation in the acceptance notes. Verify phone pairing, thread selection, pins, group downloads and reconnect delivery on the intended candidate before the week begins.

Omitting `mode` preserves the existing controlled-alpha gate: all four platforms and verified HTTPS distribution remain required. Unknown modes fail and retain the full platform checks. Switching to public/controlled alpha requires a separate controlled-alpha record; private pilot completion is not public-release approval.
