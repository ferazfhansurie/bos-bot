# BOS Bot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.

## Parallel threads (bos-bot fork)

Many threads build in this repo at once. Never edit or commit in the main
checkout; its pre-commit hook refuses (`BOS_LAND=1` overrides, on purpose only).

1. `bin/bos-wt start <slug>`: your own worktree off the latest prod; it prints
   the path. Do all edits, builds and commits there.
2. `bin/bos-wt status`: open worktrees, the files each touches, overlaps.
3. `bin/bos-wt land "<why>"` from inside the worktree: rebases onto the latest
   prod under a lock, moves prod and release/bos-1.0 together, removes the
   worktree. On a conflict it stops, names the files and keeps your commits;
   resolve with `git rebase prod`, keep both sides' intent, rerun checks, land again.
