# BOS Staging 0.1.85-staging.2

Private staging candidate only. No live, Faeez, other-user or public rollout is included.

## Implemented

- Scoped remote-bot streaming publishes replies and working progress promptly. Polling remains the recovery fallback. Stale polls cannot overwrite newer streamed content; address/token changes reconnect. Recovery never replays sends. Older hosts without the new endpoint continue polling.
- Shared bots can return bounded downloadable text, markdown, CSV, TSV and JSON artifacts directly from their terminal response. Existing image/document attachment transport remains. This does not grant private filesystem access, image generation or arbitrary execution.
- New empty workspaces start with BOS as coordinator. Business/customer/outcome setup leads to provider connection and one first assignment, directly with BOS or with specialist recruitment. The saved assignment survives uncertain responses/reloads and stays pinned to its original bot, thread and provider. Existing user bots are not renamed or migrated.
- A zero-price benchmark harness accepts an explicit free-model shortlist and designated OpenRouter key. It produces reviewable synthetic results, blocks missing credentials/nonzero prices and has no paid fallback. No best-model claim or live inference result yet.
- Controlled-alpha manifest and evidence validator cover source, identity, review, platform artifacts, signing, installed acceptance and rollback. Missing evidence blocks the gate; it never installs or publishes.

## Verification

324 integrated tests passed across 14 files, including real isolated servers for scoped streaming, group download/room isolation, and first-assignment receipt recovery. Six onboarding recovery/render checks passed again after final correction, including client config privacy. Twelve offline benchmark/release tests passed. Renderer/server typechecks and production renderer build passed.

Independent code reviews cleared remote races, onboarding retry/task targeting and group artifact boundaries. Tests use disposable homes and fake providers. The rendered onboarding form is covered by static rendering checks, but interactive visual acceptance is pending: mounted browser preparation refused because another thread owns the computer. No alternate computer-control route was attempted.

## Limits before release

- Live comparative free-model inference requires a securely configured provider key. Structural smoke scores are not intelligence rankings.
- Full end-to-end onboarding with a real provider, actual specialist recruitment and delivered website/dashboard/motion output remains to be accepted.
- Newly authored onboarding UI is desktop/web. Native iPhone/Android parity is not claimed; Windows/Android builds and device acceptance remain pending.
- Group image generation is not newly enabled; the implemented envelope creates bounded text artifacts only.
- Transient remote progress frames are not replayed after disconnection; committed transcripts recover through scoped reads. Remote hosts need the new endpoint for streaming.
- No live app or phone update is represented by this source candidate. Existing private pilot iPhone reinstall remains pending device reconnection.
