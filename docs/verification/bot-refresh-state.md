# Bot roster refresh state

Pull-to-refresh publishes a checking state before starting its new stream.
The refresh waits for a handshake/hydration result, cancellation, or the
existing ten-second bound. A connection still negotiating after that bound
remains visually checking; it is not declared asleep because of a UI timeout.
Concurrent callers join the current check rather than restarting it.

The roster refresh checks every paired home concurrently. Shared roster
loading also runs alongside these checks. The refresh control passes its
checking phase to all roster avatars, including the minimum visible beat,
so the checking rings disappear with its landing phase. A home still
connecting retains its own checking ring. Cached bot activity is never used
to claim the computer is reachable.

Checking faces use neutral eyes, a thin synchronized ring and a small spring
settle. No second bot face is drawn. Reduce Motion disables the scale and
rotation; background scenes pause the ring clock.

Checks:
- `swift test --filter 'BotConnectionPhaseTests|WaitingThreadConcurrencyTests|NotificationPolicyTests'`
- `BotRefreshUITests` uses the offline bundled roster and a delayed refresh,
  checks the refreshing-to-ready transition and retains both screenshots.
  It does not prove a physical network outage or real multi-home reachability.

Use a disposable simulator and `-only-testing:BosBotUITests/BotRefreshUITests`
with the BosBot scheme. No user data, provider turns, or live server writes
are needed for these checks.

Build 117 validation: seven focused core tests passed and the Debug simulator
app compiled. The initial UI fixture failed: its timed preview was missed
and its row identifier was obsolete. Visual acceptance remains unverified;
the owner requested proceeding directly to the physical phone install.
