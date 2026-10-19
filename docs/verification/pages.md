# pages editor

launch only the disposable fake-engine fixture with node 24 or newer:

```sh
node --experimental-strip-types scripts/verify-pages.ts
```

open its printed `previewUrl` in the mounted browser. the launcher owns a temporary home and data directory; it never uses the installed app or live data. ctrl-c stops that exact fixture.

verify: rename the page and blur, type in the editor, read the same page through `/api/pages/<fixture-bot>/<page>` and confirm the title and text. select a block, add a comment, reply and resolve/reopen; confirm the stored anchor/replies. type `/head`, choose a heading with keys or pointer, and confirm the node type. ask the bot from the editor and inspect the generated page request in the fixture conversation; the fixture captures rather than sends it. download md/html/docx and check their contents. open version history, preview and restore; re-read the page and confirm restored content with surviving comments. use the app fixture when verifying conversation dispatch and server event delivery; the single-editor preview does not mount the app event stream.

regressions:

```sh
pnpm exec vitest run shared/page.test.ts src/components/pages/page-doc.test.ts server/pages.test.ts server/page-routes.test.ts server/drivers/agents-proxy.test.ts
pnpm typecheck
pnpm build
```

the route suite checks owner refusal, room isolation, per-conversation bot access, malformed operations and stale bot revisions. store regressions check atomic cache publication after failed writes and separate checkpoint byte limits. editor conversion tests retain block ids and exercise typing during a delayed conflict retry.

this implements private per-bot documents with conversation-scoped bot tools. owner page browsing spans that bot's pages; asking for edits targets the page's originating conversation. no public sharing, crdt/offline claim, native window management or direct pdf export.
