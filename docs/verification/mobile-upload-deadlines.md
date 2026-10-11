# Mobile upload deadlines and retry identities

A paired phone sends raw video bytes through the companion proxy to the
local file route. The harness cannot answer until the complete body arrives.
Previously the proxy started its 30-second response deadline before uploading
finished, returning 504 even while the upload made progress.

Raw file/image upload routes now get a bounded five-minute transfer window.
The normal response deadline starts when the upstream request finishes writing.
Early rejection still clears the timer; unrelated calls retain their deadlines.

The iOS client gives uploads five minutes and retries transient network and
408/502/503/504 errors at most twice, only with a stable upload/message identity.
It replays exactly the original URL/body and selected thread. Other mutations,
unauthorized requests and uploads without an identity are not replayed.

Verification:

- `pnpm exec vitest run companion/test/proxy-upload.test.ts companion/test/proxy-response.test.ts companion/test/proxy.test.ts`: 38 pass.
- `cd ios && swift test --filter 'ShareClientTests|QueuedSendClientTests'`: 35 pass.
- Before the change the slow-upload regression returned 504; after it returns
  201 with every byte. A mute harness still returns 504 after transfer finishes.
- An isolated control fixture accepted a synthetic 12,831,840-byte MP4
  streamed through the proxy over 32.04 seconds; stored SHA-256 matched.
- iOS tests check lost responses, unchanged message/upload identities and bytes,
  authorization failures, single-attempt uploads and bounded retries.

This proves the local client/proxy behavior in isolated synthetic fixtures.
A real mobile upload over the user's hosted route remains a device acceptance
check after installation. Media count/size limits are a separate pending slice.
