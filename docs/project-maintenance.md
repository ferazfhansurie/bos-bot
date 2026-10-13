# Project maintenance

## Branches

- `main`: public integration branch; always preserve merged contributor history.
- `feat/*`, `fix/*`, `docs/*`, `chore/*`: focused, short-lived pull-request branches.
- `vX.Y.Z`: immutable release tags, created only for reviewed release commits.
- No permanent `develop`, public `prod`, or per-platform release branches.

Delete a branch only after its work is merged or verified to be superseded. Keep
open pull requests and unfinished work. For old release branches containing unique
commits, retain an `archive/*` tag before deleting the branch.

The maintainer's private development checkout and installed builds are separate
from this public repository. Public source synchronization uses sanitized patches
on top of `main`, never a rewritten export force-pushed over contributor history.
Customer data, local account identifiers, transcripts and private evidence are excluded.

## Releases

Publishing is a separate action from pushing source. A version in `package.json`
is not evidence that signed installers, phone builds or GitHub release assets exist.
Use the manual Release workflow for this repository and verify one exact commit
across platform artifacts. Keep signing credentials in GitHub secrets. Never upload
this fork's binaries to upstream repositories or npm packages.

Inherited upstream Docker/npm/release-sync/CLA workflows are retained for provenance
but guarded to run only in the upstream repository. Artifact-only platform build
workflows remain available. CI validates source pull requests on this fork.

## Contribution and licensing

The fork maintainer is [@ferazfhansurie](https://github.com/ferazfhansurie).
Upstream OpenMausBot remains credited in NOTICE and LICENSING.md. Its trademark and
third-party license notices remain applicable. The optional upstream `enterprise/`
adapter is not included in this public checkout; do not claim it has been relicensed.

Report defects through the issue templates, include relevant validation in pull
requests, and use the private contact in SECURITY.md for vulnerabilities.
