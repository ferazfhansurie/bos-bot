# Owner-managed WhatsApp access

The linked WhatsApp tile in **Connect apps → Connected apps** includes **Bot permissions**.
An owner chooses a bot, names captured chats, and reviews the exact scope before saving.
Starting messages and automatic replies are separate options, off for an unconfigured bot.
The UI discloses the existing default captured-history reading access. Revoke writes an
empty named scope, including when the bot had no policy, so reading stays denied.

The owner-only `GET /api/whatsapp/permissions` returns the current linked account and
up to 200 recent captured chats from that account. Bot connector credentials cannot use
this endpoint or configure permissions. A saved permission for another account is not
copied to the current account. Every save pins an explicit account and named chats.

## Automated checks

```sh
pnpm exec vitest run src/components/WhatsAppPermissions.test.ts src/components/NativeWhatsAppTile.test.ts server/whatsapp-replies.test.ts server/whatsapp-replies.e2e.test.ts
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
