# Bot readiness

Bot settings → Overview now separates model/app connection health from optional
setup suggestions. It never enables apps or changes model/approval settings.
The overview response includes only service names and normalized pending or
reconnect lists; account records, identifiers and credentials are excluded.

Run the focused checks:

```sh
pnpm exec vitest run server/bot-overview.test.ts src/lib/bot-readiness.test.ts src/components/bot-settings/OverviewSection.test.ts src/components/bot-settings/AccessSection.test.ts
pnpm exec tsc -p tsconfig.server.json
```

For controlled renderer scenarios:

```sh
node --experimental-strip-types scripts/verify-bot-readiness.ts
```

Open its printed preview URL. It mounts the real panel with synthetic model and
connector responses, never real accounts. Test pending → connected (automatic
refresh within five seconds), expired → Reconnect, signed-out → Sign in, and
offline → unknown states without retaining green connection rows. Check again
must disable while loading. Delay responses and switch bots to check isolation.
The fixture's action readout verifies the selected destination without opening
real login flows. Ctrl-C stops the exact child and removes its temporary data.

For the real settings integration and real disposable API response, run
`scripts/verify-bot-settings.ts`, open Overview, and use Connect apps. The
production dialog routes app repair to the existing Plugins panel, model sign-in
to App Settings → Engines, and missing model choice to bot Model settings.

Polling stops when the section unmounts. Hidden pages do not issue new checks;
visibility/focus checks resume, pending connections poll every five seconds,
other connections every minute. Requests have a twelve-second timeout, no
overlap and cancellation/identity guards. Errors replace health with unknown.
Servers without the added inventory field show unknown rather than false ready.

## Verified 2026-10-15

- 43 readiness/overview/access tests and 4 device-pairing tests passed.
- Changed-file lint, full web/server typecheck and the renderer build passed.
- In the mounted Browser, the real settings dialog rendered the fake engine as
  available, optional apps as optional, and the Connect apps action closed bot
  settings through the existing Plugins dispatch.
- The controlled renderer showed Slack pending → connected automatically, an
  expired Slack connection with Reconnect, a signed-out account with Sign in,
  and offline model/app checks with no previous green rows.
- Screenshot inspection confirmed readable hierarchy, action labels and status
  icons. No real provider sign-in or OAuth execution was tested.
- The existing `SettingsModal.tsx:531` companion lookup initially blocked web
  typecheck. An `in` guard now checks that optional bridge before reading it,
  preserving the native-versus-hosted pairing behavior; all four existing
  pairing regressions pass.

This is the first setup/readiness slice. It does not claim to discover every
tool a task might need, validate computer access or application permissions,
resume an interrupted bot turn, or infer enterprise admin approval states.
