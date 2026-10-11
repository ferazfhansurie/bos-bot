# Notification thread navigation

A normal bot notification tap is retained until Session attaches its handler.
Opening a bot thread uses the same local projection as the thread picker;
it does not send a task-switch mutation. Reconnect starts before capturing
navigation's stream generation. Concurrent opens use an id so older requests
cannot navigate over the latest one. Settled approval taps can open history;
tapping a banner never answers the request.

Verification:
- CompanionCore notification policy, decoding, and thread navigation tests.
- Offline native UI fixture launches with a notification already queued before
  Session installs the callback. Pepper is working in Gmail; the tap must open
  iCloud's transcript, with no Gmail messages. The fixture rejects all mutations, so the old
  server task-switch path cannot pass it. No live account/data is used.

The offline native check does not prove APNs delivery or a physical lock-screen
notification tap. Physical device install and user acceptance remain separate.

Run core checks from `ios/` with:

```
swift test --filter 'NotificationPolicyTests|DecodingTests|ThreadNavigationTests'
```

Generate the app with `xcodegen generate`, then use a disposable simulator:

```
xcodebuild -project BosBot.xcodeproj -scheme BosBot -configuration Debug \
  -destination 'platform=iOS Simulator,id=SIMULATOR_ID' \
  -parallel-testing-enabled NO \
  -only-testing:BosBotUITests/ThreadNavigationUITests/testColdNotificationOpensExactSiblingWhileAnotherThreadRuns \
  CODE_SIGNING_ALLOWED=NO test
```

2026-10-11: 70 focused core tests and the native cold-tap UI test passed.
The initial UI assertion referenced a retired header button; the final test
checks the destination transcript directly.
