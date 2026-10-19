# Exact outbound message review

`propose_outbound_message` creates a durable review in the calling direct thread. Channel, exact recipient, sending account identifier, optional subject and full body appear before approval. No provider action runs and Full Access never auto-approves. Owner-only decisions recheck session liveness and owner binding after reading the body.

Approve returns one stable, pinned-thread chat request with the exact reviewed values; the renderer uses the existing send path. Repeated approval uses the same send ID. Discard grants nothing. After approval the card says **waiting for a successful send tool receipt**, including when the fake engine merely replies “done”. Provider execution still belongs to the bot's existing tools and permission rules.

`record_outbound_receipt` accepts only an actual successful send activity under the exact approval's nearest user ancestor, with matching exact content and a supported structured receipt. It can find one unique matching activity or accept an explicit activity message ID. Currently supported proof adapters are native `BOS_WHATSAPP_SEND`/`REPLY` and a strict `GMAIL_SEND_EMAIL` schema, directly or as the only call in an explicitly successful, matching single-result Composio batch. Extra recipients, attachments, HTML, unknown fields/schemas, changed subjects (including empty), absent/wrong account, unrelated later turns, prose claims and uncertain/failed results stay awaiting receipt. **Submitted** describes a tool receipt, never recipient delivery. There is no new provider execution path.

Pure tests:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" pnpm exec vitest run server/outbound-reviews.test.ts
pnpm typecheck
```

Isolated renderer proof, with no outbound provider:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" node --experimental-strip-types scripts/control-omb.ts ui launch
# in another shell, use only the printed explicit handle:
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" node --experimental-strip-types scripts/testing/prepare-outbound-review.ts /tmp/bosbot-verify-data-XXXX/ui.json
```

The preparer refuses non-fixture handles, writes a synthetic CLI only in its disposable home, verifies the capability targets that exact fixture URL, and proposes two messages to `.test` recipients through the real internal proposal route. It never calls a provider. Approve the first and discard the second. Reload and verify both states persist, exactly one approval user turn exists in that thread, and the first card remains awaiting receipt despite the fake reply. Stop the foreground launcher to close its owned browser/server and remove temporary data.

Desktop and web render the dedicated card. Older native clients receive the complete exact content in the subtitle with no generic approve option and directions to open desktop/web review.
