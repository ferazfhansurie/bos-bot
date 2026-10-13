# BOS Bot contributor notes

This is the public BOS Bot fork. Start with [CONTRIBUTING.md](CONTRIBUTING.md),
[the architecture](docs/architecture.md), and [the documentation index](docs/README.md).

- Base focused changes on `main`; submit a pull request against `main`.
- Use a separate branch or worktree for each task. Do not edit another contributor's work.
- Verify server and conversation changes in disposable fixtures, never a live user's home.
  See [verification](docs/verification/README.md).
- Keep credentials, transcripts, customer information and private deployment notes out of commits.
- Preserve upstream and bundled third-party license notices.
- Run checks relevant to the change; report commands and limitations in the pull request.
- This public clone does not use the maintainer's private `prod` / `bos-wt land` workflow.
