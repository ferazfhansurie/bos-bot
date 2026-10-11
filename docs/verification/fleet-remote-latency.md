# local fleet hydration with slow linked homes

`server/fleet-remote-latency.e2e.test.ts` launches the real server with a temporary
home and fake engine. Its exact synthetic remote hostname is redirected by the
verification launcher's transport to an owned loopback HTTP server. That remote
waits 1.5 seconds and refuses requests. No real account or live data is used.

The fixture creates a local bot and fetches `/api/bots?messages=50` twice. Both
responses must contain the local bot and finish below 800 ms. The persisted
remote room remains visible with `home.available: false`. The two reads share
one pending remote room refresh. All fixture servers close in cleanup.

The fleet route gives remote bot discovery/transcripts 100 ms in total, then
remote rooms 100 ms. Other direct remote routes retain their existing waits.
Late transcript hydration emits ordinary message frames. No phone connection
status, replay cursor, draft, upload identity or send identity changes.

Run:

```
pnpm exec vitest run server/fleet-remote-latency.e2e.test.ts server/remote-bot-bridge.test.ts server/multiplayer-remote-rooms.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

2026-10-11: 51 tests passed and server typecheck passed. Separate diff review
checked late-message emission, timeout fallback, link-identity checks, and
unchanged direct-route authentication. This proves the server wait is bounded;
physical phone wake-up animation and hosted-network latency still need device
acceptance. Nonselected remote threads awaiting approval can still require a
remote page during the phone's hydration; this change does not claim to remove
that separate wait.
