# BOS Staging 0.1.85-staging.3

Private candidate for Firaz's Mac and iPhone pilot. Public release and other users remain held.

## Changes

- Existing workspaces can open **Set up my AI team** in Settings. Setup reuses the existing coordinator without renaming it, or creates BOS with its coordinator role in one persisted write. Failure restores memory; retries do not create duplicates.
- The first assignment carries the business brief into actual specialist setup and delegation instructions. Saved assignments retain their original coordinator, thread, model and send receipt across retries.
- **Start free** connects an explicitly supplied OpenRouter key. Authentication is checked without inference; secrets are write-only. The connection is replaced independently of other running providers, with concurrency and session-revocation checks.
- The free runtime supports BOS's existing permission-controlled tools. Every generation rechecks the official catalog for zero prices and tool support, and requests zero token prices with no paid fallback. No inherited credentials or configurable provider URL are accepted.
- Free models appear as cloud models in the picker and can be connected from onboarding or Settings. OpenRouter's free router chooses among available models; this is not a claim that it selects the smartest model.
- Manual first-bot creation preserves the user's profile rather than inserting Firaz's personal Jarvis profile.
- A private-pilot release gate requires Mac/iPhone evidence and explicitly excludes unsupported Windows/Android, while preserving the separate stricter public-alpha gate.

## Evidence and remaining acceptance

Focused integration, provider tool approval/denial, credential privacy, concurrency, revoked-session and persistence recovery tests pass. Real isolated renderer tests cover existing and missing coordinators, brief delivery and replay without duplicate sends. Native core checks pass (511 tests). Test providers and keys are synthetic.

A real free-provider connection, specialist creation and useful delivered result still require acceptance. Actual phone workflow checks and the final installed candidate record remain pending. The source and passing tests alone are not an alpha-ready claim. No installation or public release is represented by this document.

Setup is desktop-first for this pilot. Free-model rate limits and availability belong to OpenRouter; BOS does not silently switch to a paid model. Group text artifacts are supported; unconfigured image-generation/Office capabilities are not promised. Other users' hosts are not upgraded during this pilot.
