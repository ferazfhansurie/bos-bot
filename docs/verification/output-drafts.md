# Output working copies and comments

Run `pnpm exec vitest run shared/output-draft.test.ts src/components/HtmlArtifact.test.ts src/components/ChatView.controls.test.ts` and `pnpm typecheck`.

Launch the isolated UI with `node --experimental-strip-types scripts/control-omb.ts ui launch` as described in [chat-ui.md](chat-ui.md). Send a fixture prompt and wait for the fake engine to settle. In its bot response's Message actions, choose **edit and comment on output**.

1. Edit the working-copy textarea. Undo and redo must restore the preceding text states. Save a version. The original transcript response stays unchanged.
2. Select exact text in the saved textarea, enter a comment, and add it. Repeat for a second range. Each comment shows its version and character range.
3. Reload the fixture page and reopen the same output. The saved version and both comments must survive. Choose original to read the untouched source; choose the saved version again.
4. Request revision in this thread. Wait for the bot to settle. Read the new user message from the fixture API/transcript: it must include the source message ID, chosen version, both quotes with their character ranges and both comments in that same thread.
5. Reposting a stale draft revision must return 409. Original/version rewrites, mismatched quotes, non-integer or out-of-bounds anchors and oversized requests must fail. The route refuses non-owner and peer sessions; it supports local direct bot threads only.

For a deterministic synthetic range in the harness, focus the edit textarea, call `setSelectionRange(start, end)` and dispatch `document.dispatchEvent(new Event("selectionchange"))` through `control-omb ui eval`; this triggers the real React selection handler. Dispatching a synthetic `select` event alone does not.

Working copies are explicit saves, separate from provider text and model context. Unsaved edits remain local until Save version. Up to 30 immutable versions and 100 comments are retained per output. Comments refer to the exact saved version, including repeated text occurrences; they do not silently move when another version is edited. Undo/redo covers the current editing session. Revision requests use the normal pinned-thread send path and do not send anything outside BOS. HTML source remains plain editor text; existing artifact sandbox/CSP is unchanged.
