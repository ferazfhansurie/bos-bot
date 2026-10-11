# Immediate phone steering and stable roster refresh

Direct chats default to Steer. This uses the existing `priority: block`
contract: stop this thread's active turn and resume with the correction.
Queue remains an explicit choice and stays selected when chosen. The phone
sends that choice even when its cached busy flag is stale. Rooms retain
their existing default and member-routing behavior.

A local pending bubble appears before upload or HTTP acknowledgement. Stable
send/queue identities reconcile it against the canonical message; an accepted
HTTP send receipt is applied without waiting for its duplicate stream frame.
The durable draft and retry identity remain intact on failure.

For an already queued direct correction, `interrupt: true` opts into the same
preemption semantics. The server holds the undelivered queue through stopping,
serializes against other sends, then restores and drains it once. Its receipt
reports interruption and canonical messages, not provider/model consumption.
Older callers retain native live steering. This queued action requires the
updated desktop server; fresh phone sends use its existing block contract.

The physical refresh recording exposed a cancelled stream falling through its
normal end and incorrectly marking the replacement offline. Cancellation now
exits before that publication. A refresh does not insert a connection banner
that changes the scroll inset. Faces stay checking through the landing phase.

The native regression also exposed cancellation of SwiftUI's refresh action
when the new checking environment redraws. A debug-only probe measured 36ms
from start to cancellation, despite a five-second fixture delay. The refresh
model now owns and coalesces a separate task; view redraw cannot cancel the
connection check or its minimum visible beat.

Validation so far:
- 28 focused phone-core/client tests passed, including canonical send identity and
  interrupted receipt reconciliation without duplicate stream messages.
- Held-tool interruption test passed before releasing the fixture tool result;
  repeat steering did not append or interrupt a second time.
- Five direct/room priority and retry-identity tests passed.
- The broader steering run had 36 passes, three skips and four existing fake
  ACP unavailable-provider failures in the unchanged queue fixture.
- Server typecheck passed.
- Native iOS UI regression passed: the real pull gesture completes the five-second
  checking fixture and restores the roster position within two points. Video
  inspection confirmed a stable checking face and smooth return without a sleep flash.
- Release installation is recorded in the continuation handoff. No production
  model turns or database fixtures were used.
