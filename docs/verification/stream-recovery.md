# Phone stream recovery

User report on 118: an accepted send appears, but further replies remain hidden
until leaving/reopening; bot faces can show asleep. A read-only local SSE probe
observed live bot, message, and runtime frames from the installed server. A phone
console capture was unavailable, so the exact network failure is not established.

The confirmed recovery gap: HTTP acceptance updates the transcript independently
of SSE, and previously never checked that the live connection received the same
message. A stalled socket could remain open until URLSession's long idle timeout.

After an accepted non-queued send, wait one second for its canonical message ID
on SSE. If absent, reconnect from the folded cursor without resending. Already
observed receipts do not reconnect; lifecycle changes cancel the check. Sending
also reconnects an offline or stopped session immediately. An uncancelled stream
that throws CancellationError retries rather than silently ending the runner.

The transport now terminates a stream with no decoded frame for 35 seconds
(two missed 15-second server pings). It cancels both reader and watchdog on exit.

Validation: five real URLSession stream tests pass, including an open silent
socket failing promptly instead of freezing indefinitely. Native UI fixture
opens a stalled stream, accepts a synthetic HTTP send and serves its reply only
on a second stream, asserting visible recovery and one user message. All fixture
traffic is isolated through URLProtocol. The native recovery test passed on iOS 26.4 Simulator, with the reply visible
without leaving the chat and exactly one accepted user message. Device installation
is recorded in the continuation handoff; simulation does not establish physical acceptance.
