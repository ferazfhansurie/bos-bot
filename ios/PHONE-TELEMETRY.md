# Phone anonymous usage

iOS and Android send `install`, `open` and `pair_success` to
`https://bosbot.my/api/events`. iOS additionally sends `push_ok` only after the
paired server confirms both `registered: true` and `deliveryConfigured: true`.
Android has no push registration event.

Each phone stores its own random UUID, local opt-out and bounded event queue.
Only the install UUID, running app version, platform, event name, ISO timestamp
and empty `props` object leave the phone. Paired tokens, device/computer names,
addresses, conversations and files are never included in the public request.
The public transport has no paired-server authorization or cookie store.

The phone's Privacy switch and `BOS_NO_PING=1` take precedence. Before each batch,
every paired computer's `/api/config` must explicitly allow anonymous usage; any
`anonymousUsage.enabled: false` or `disabledByEnv: true` purges queued events.
Missing policy or unreachable computers defer sending. **Unpaired installs are
excluded from receiver counts** until the phone pairs with an allowing server.
Debug and preview apps disable public telemetry entirely.

Queues retain at most 200 events and send at most 50 in one request. Foreground
timers flush every 60 seconds; entering the background also attempts a flush.
Failures stay local and never become a UI error. Unsent events survive process
exit. Background/termination delivery is best effort under mobile OS limits.

Core checks use in-memory stores and injected transports, without a public
request or the user's app data:

```sh
swift test --package-path ios --filter UsageTelemetryTests
cd android
./gradlew :core:test --tests '*UsageTelemetryTest' --offline
```

Core tests do not prove native app lifecycle integration, physical pairing,
push delivery, installation or public receiver acceptance.
