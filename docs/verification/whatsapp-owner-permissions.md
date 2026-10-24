# Owner-managed WhatsApp access

The linked WhatsApp tile in **Connect apps → Connected apps** includes **Bot access**.
An owner chooses a bot, then sets two things separately (since 2.1.7):
- **Reading**: all chats (`readAll`, includes new chats), chosen chats, or off.
- **Replying**: off by default. Off with chosen chats saves `readOnly`, which the server
  enforces on reply, send, auto-dispatch and the prompt (no send tools). On, it can reply
  only in named chats, with starting messages and automatic replies as separate switches.
Every save goes through a review dialog except turning access off. Off writes an empty
named scope, so reading stays denied.

Chat names: WhatsApp Web's `message.getChat()` throws an IndexedDB DataError on current
builds, so most chats were captured with no name and the panel showed raw `@lid` ids.
`chatTitles()` now reads titles straight from the page store, and opening the panel
backfills names for unnamed chats (bounded at 8s). Chats with no name show a formatted
phone number, "Unknown contact" or "Unnamed group", with the id as a tooltip.

The owner-only `GET /api/whatsapp/permissions` returns the current linked account and
up to 200 recent captured chats from that account. Bot connector credentials cannot use
this endpoint or configure permissions. A saved permission for another account is not
copied to the current account. Every save pins an explicit account and named chats.

## Automated checks

```sh
pnpm exec vitest run src/components/WhatsAppPermissions.test.ts server/whatsapp-native.test.ts src/components/NativeWhatsAppTile.test.ts server/whatsapp-replies.test.ts server/whatsapp-replies.e2e.test.ts
pnpm exec tsc -b --pretty false
```

## Isolated app acceptance (2026-10-15)

Used the real React renderer through `control-omb ui launch` in a disposable fixture.
Only the native-link snapshot and owner chat choices were stubbed with synthetic data;
per-bot permission GET/PUT requests used the actual fixture server. No live account or
message transport was used.

Verified:
- An unconfigured bot displays default reading access and offers revoke.
- Revoke creates an empty scope and displays “Chat access revoked”.
- Selecting one synthetic chat and enabling starting messages opens a review with Cancel focused.
- Cancel leaves the server's empty policy unchanged.
- Approve persists exactly one selected chat and outreach=true, autoDispatch=false.
- No browser console errors.
- Independent review caught and resolved legacy hyphenated group-id validation and
  missing visibility/revocation of default reading access.

Frontend typecheck and 14 targeted tests pass. The separate server typecheck currently
reports existing alias/extension errors in `src/lib/room-members.ts`, outside this change.
Source acceptance does not mean the installed desktop app has been updated or any real
WhatsApp delivery has been verified.

## Isolated app acceptance (2026-10-24, 2.1.7)

`control-omb ui launch --entry whatsapp-permissions` renders the panel with seven synthetic
chats (named, unnamed `@lid`, unnamed phone, unnamed group); bot policy GET/PUT hit the real
fixture server. Saved policies read back from reply-policies.json:
- All chats, replies off → `{chatIds: [], readAll: true}`.
- Chosen chats (2 groups), replies off → `{chatIds: [2], readOnly: true}`.
- Replies on + reply automatically → `{chatIds: [2], autoDispatch: true}`.
- Off → `{chatIds: []}`.
Fixed during acceptance: the panel stayed empty when the bot list loaded after mount.
