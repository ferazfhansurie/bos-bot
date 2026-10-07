import Foundation
import XCTest
@testable import CompanionCore

final class CloudOutboxTests: XCTestCase {
    private typealias F = CloudFixture
    private let now = CloudFixture.now
    private let alice = CloudFixture.account("alice")

    private func outbox() -> CloudOutbox { CloudOutbox(account: alice) }

    @discardableResult
    private func enqueue(_ outbox: inout CloudOutbox, _ envelope: CloudSendEnvelope, expires: Date = CloudFixture.windowExpiry, replyTo: CloudOperationID? = nil, ephemeral: Bool = false) throws -> [CloudOutboxEffect] {
        try outbox.enqueue(envelope, windowExpiresAt: expires, replyToOperation: replyTo, ephemeral: ephemeral, now: now)
    }

    // MARK: - Dispatch

    func testEnqueuePersistsBeforeSubmit() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        let effects = try enqueue(&box, envelope)
        XCTAssertEqual(effects.first, .persist)
        XCTAssertEqual(effects.last, .submit(envelope))
        let firstPersist = try XCTUnwrap(effects.firstIndex(of: .persist))
        let submit = try XCTUnwrap(effects.firstIndex(of: .submit(envelope)))
        XCTAssertLessThan(firstPersist, submit)
        // transmit persists the frozen state right before the I/O too.
        XCTAssertEqual(effects[submit - 1], .persist)
        let entry = try XCTUnwrap(box.entry(envelope.clientOperationId))
        XCTAssertEqual(entry.status, .sending)
        XCTAssertTrue(entry.dispatched)
        XCTAssertEqual(entry.attempts, 1)
    }

    func testEnqueueSameOperationTwiceIsNoOp() throws {
        var box = outbox()
        try enqueue(&box, F.envelope(1))
        XCTAssertEqual(try enqueue(&box, F.envelope(1, text: "changed")), [])
        XCTAssertEqual(box.entries.count, 1)
        XCTAssertEqual(box.entries[0].envelope.text, "hello")
    }

    func testDigestFrozenAndSameEnvelopeReplayedOnNotFoundWake() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let id = envelope.clientOperationId
        XCTAssertEqual(box.entry(id)?.digest, envelope.digest)
        XCTAssertEqual(box.entry(id)?.autoReplay, true)

        let notFound = box.answered(id, result: .outcome(.notFound), generation: box.generation, now: now)
        XCTAssertEqual(notFound.first, .persist)
        XCTAssertEqual(notFound.wakeDelays.count, 1)
        XCTAssertEqual(box.entry(id)?.status, .checking)
        XCTAssertEqual(box.entry(id)?.notCommitted, true)

        let replay = box.wake(now: now.addingTimeInterval(5))
        XCTAssertEqual(replay, [.persist, .submit(envelope)])
        XCTAssertEqual(replay.submitted.first?.digest, envelope.digest)
        XCTAssertEqual(box.entry(id)?.digest, envelope.digest)
        XCTAssertEqual(box.entry(id)?.status, .sending)
        XCTAssertEqual(box.entry(id)?.attempts, 2)
    }

    func testNotFoundAfterRelaunchKeepsCheckingAndNeverAutoReplays() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let id = envelope.clientOperationId

        let recovery = box.recoverAfterLaunch(now: now)
        XCTAssertEqual(recovery, [.persist, .lookup(id, workspaceId: "w1")])
        XCTAssertEqual(box.entry(id)?.status, .checking)
        XCTAssertEqual(box.entry(id)?.autoReplay, false)

        let effects = box.answered(id, result: .outcome(.notFound), generation: box.generation, now: now)
        XCTAssertTrue(effects.submitted.isEmpty)
        XCTAssertEqual(box.entry(id)?.status, .checking)
        XCTAssertEqual(box.entry(id)?.notCommitted, true)

        XCTAssertEqual(box.wake(now: now.addingTimeInterval(60)), [], "no auto replay after relaunch")
        XCTAssertEqual(box.entry(id)?.status, .checking)

        // Only the person may send it again: the same frozen envelope.
        XCTAssertEqual(box.resend(id, now: now), [.persist, .submit(envelope)])
        XCTAssertEqual(box.entry(id)?.digest, envelope.digest)
    }

    func testRecoveryUnknownNeverSubmitsOrSeals() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let id = envelope.clientOperationId

        XCTAssertEqual(box.answered(id, result: .outcome(.recoveryUnknown), generation: box.generation, now: now), [.persist])
        XCTAssertEqual(box.entry(id)?.status, .recoveryUnknown)
        XCTAssertEqual(box.entry(id)?.status.recoveryRequired, true)
        XCTAssertEqual(box.entry(id)?.status.label, .checking)

        XCTAssertEqual(box.wake(now: now.addingTimeInterval(60)), [])
        XCTAssertEqual(box.resend(id, now: now), [])
        XCTAssertEqual(box.giveUp(id), [])

        // Relaunch: reconcile by lookup only.
        let recovery = box.recoverAfterLaunch(now: now)
        XCTAssertTrue(recovery.submitted.isEmpty)
        XCTAssertTrue(recovery.sealed.isEmpty)
        XCTAssertEqual(box.entry(id)?.status, .recoveryUnknown)
        XCTAssertEqual(box.wake(now: now), [])
        XCTAssertEqual(box.discard(id), [], "an unresolved dispatched send is never dropped")
    }

    func testAcceptanceForDifferentBytesIsRecoveryUnknown() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        var foreign = F.acceptance(for: envelope, messageId: "m1", sequence: 1)
        foreign.digest = F.envelope(1, text: "other bytes").digest
        XCTAssertEqual(box.answered(envelope.clientOperationId, result: .outcome(.accepted(foreign)), generation: box.generation, now: now), [.persist])
        XCTAssertEqual(box.entry(envelope.clientOperationId)?.status, .recoveryUnknown)
    }

    func testGiveUpOnNotFoundSealsOriginalEnvelope() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let id = envelope.clientOperationId
        XCTAssertEqual(box.giveUp(id), [], "nothing to seal while sending")
        _ = box.answered(id, result: .outcome(.notFound), generation: box.generation, now: now)
        XCTAssertEqual(box.giveUp(id), [.seal(envelope)])
    }

    func testIndeterminateChecksThenBacksOff() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let id = envelope.clientOperationId

        XCTAssertEqual(box.answered(id, result: .indeterminate, generation: box.generation, now: now), [.persist, .lookup(id, workspaceId: "w1")])
        XCTAssertEqual(box.entry(id)?.status, .checking)
        XCTAssertEqual(box.entry(id)?.notCommitted, false)

        let second = box.answered(id, result: .indeterminate, generation: box.generation, now: now)
        XCTAssertEqual(second.count, 2)
        XCTAssertEqual(second.first, .persist)
        let delay = try XCTUnwrap(second.wakeDelays.first)
        XCTAssertGreaterThanOrEqual(delay, 0)
        XCTAssertLessThanOrEqual(delay, CloudBackoff.ceiling(attempt: 2))
        XCTAssertEqual(box.entry(id)?.status, .checking)
        XCTAssertEqual(box.entry(id)?.attempts, 2)

        // Waking a checking (not not-found) send re-asks the ledger, never resends.
        XCTAssertEqual(box.wake(now: now), [.lookup(id, workspaceId: "w1")])
    }

    func testRateLimitedWhileSendingReplaysSameEnvelopeLater() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let id = envelope.clientOperationId

        XCTAssertEqual(box.answered(id, result: .rateLimited(retryAfter: 3), generation: box.generation, now: now), [.persist, .scheduleWake(after: 3)])
        XCTAssertEqual(box.entry(id)?.status, .checking)
        XCTAssertEqual(box.entry(id)?.notCommitted, true)

        XCTAssertEqual(box.wake(now: now.addingTimeInterval(3)), [.persist, .submit(envelope)])

        // Rate limited on a lookup only reschedules.
        _ = box.answered(id, result: .indeterminate, generation: box.generation, now: now)
        XCTAssertEqual(box.answered(id, result: .rateLimited(retryAfter: 4), generation: box.generation, now: now), [.scheduleWake(after: 4)])
    }

    func testStaleGenerationAnswerDroppedAfterSwitchAccount() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let id = envelope.clientOperationId
        let oldGeneration = box.generation
        let saved = box.entries

        box.switchAccount(to: F.account("bob"))
        XCTAssertTrue(box.entries.isEmpty)
        box.switchAccount(to: alice, entries: saved)
        XCTAssertEqual(box.generation, oldGeneration + 2)

        let accepted = CloudSubmitResult.outcome(.accepted(F.acceptance(for: envelope, messageId: "m1", sequence: 1)))
        XCTAssertEqual(box.answered(id, result: accepted, generation: oldGeneration, now: now), [])
        XCTAssertEqual(box.entry(id)?.status, .sending)

        XCTAssertEqual(box.answered(id, result: accepted, generation: box.generation, now: now), [.persist])
        XCTAssertEqual(box.entry(id)?.status.label, .accepted)
    }

    func testAnswerForResolvedSendIsDropped() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        let accepted = F.acceptance(for: envelope, messageId: "m1", sequence: 1)
        _ = box.answered(envelope.clientOperationId, result: .outcome(.accepted(accepted)), generation: box.generation, now: now)
        XCTAssertEqual(box.answered(envelope.clientOperationId, result: .outcome(.notFound), generation: box.generation, now: now), [])
        XCTAssertEqual(box.entry(envelope.clientOperationId)?.status, .accepted(accepted))
    }

    func testSequentialPerRoom() throws {
        var box = outbox()
        let first = F.envelope(1)
        let second = F.envelope(2)
        let other = F.envelope(3, room: "r2")

        XCTAssertEqual(try enqueue(&box, first).submitted, [first])
        let secondEffects = try enqueue(&box, second)
        XCTAssertEqual(secondEffects, [.persist])
        XCTAssertEqual(box.entry(second.clientOperationId)?.status, .draft)
        XCTAssertEqual(try enqueue(&box, other).submitted, [other], "another room is not blocked")

        // Still checking: the room stays blocked.
        _ = box.answered(first.clientOperationId, result: .indeterminate, generation: box.generation, now: now)
        XCTAssertTrue(box.dispatch(now: now).submitted.isEmpty)

        let effects = box.answered(first.clientOperationId, result: .outcome(.accepted(F.acceptance(for: first, messageId: "m1", sequence: 1))), generation: box.generation, now: now)
        XCTAssertEqual(effects.first, .persist)
        XCTAssertEqual(effects.submitted, [second])
        XCTAssertEqual(box.entry(second.clientOperationId)?.status, .sending)
    }

    func testRejectedSendUnblocksRoom() throws {
        var box = outbox()
        let first = F.envelope(1)
        let second = F.envelope(2)
        try enqueue(&box, first)
        try enqueue(&box, second)
        let rejection = CloudRejection(clientOperationId: first.clientOperationId.rawValue, digest: first.digest, reason: .policyChanged)
        let effects = box.answered(first.clientOperationId, result: .outcome(.rejected(rejection)), generation: box.generation, now: now)
        XCTAssertEqual(box.entry(first.clientOperationId)?.status, .rejected(rejection))
        XCTAssertEqual(effects.submitted, [second])
    }

    func testReplyWaitsForParentThenTakesItsMessageId() throws {
        var box = outbox()
        let parent = F.envelope(1)
        let reply = F.envelope(2, text: "reply")
        try enqueue(&box, parent)
        XCTAssertTrue(try enqueue(&box, reply, replyTo: parent.clientOperationId).submitted.isEmpty)
        XCTAssertFalse(box.entry(reply.clientOperationId)?.dispatched ?? true)
        XCTAssertNil(box.entry(reply.clientOperationId)?.digest)

        let acceptance = F.acceptance(for: parent, messageId: "m-parent", sequence: 7)
        let effects = box.answered(parent.clientOperationId, result: .outcome(.accepted(acceptance)), generation: box.generation, now: now)
        let sent = try XCTUnwrap(effects.submitted.first)
        XCTAssertEqual(sent.clientOperationId, reply.clientOperationId)
        XCTAssertEqual(sent.replyToMessageId, "m-parent")
        let entry = try XCTUnwrap(box.entry(reply.clientOperationId))
        XCTAssertNil(entry.replyToOperation)
        XCTAssertEqual(entry.envelope.replyToMessageId, "m-parent")
        // Frozen over the envelope that actually went out.
        XCTAssertEqual(entry.digest, sent.digest)
    }

    func testReplyToParentInAnotherRoomWaits() throws {
        var box = outbox()
        let parent = F.envelope(1, room: "r2")
        let reply = F.envelope(2)
        try enqueue(&box, parent)
        let effects = try enqueue(&box, reply, replyTo: parent.clientOperationId)
        XCTAssertTrue(effects.submitted.isEmpty)
        XCTAssertEqual(box.entry(reply.clientOperationId)?.status, .waiting(retryAt: nil))
        let accepted = box.answered(parent.clientOperationId, result: .outcome(.accepted(F.acceptance(for: parent, messageId: "m9", sequence: 9))), generation: box.generation, now: now)
        XCTAssertEqual(accepted.submitted.first?.replyToMessageId, "m9")
    }

    func testParentRejectedHoldsReply() throws {
        var box = outbox()
        let parent = F.envelope(1)
        let reply = F.envelope(2)
        try enqueue(&box, parent)
        try enqueue(&box, reply, replyTo: parent.clientOperationId)
        let rejection = CloudRejection(clientOperationId: parent.clientOperationId.rawValue, digest: parent.digest, reason: .invalidMention)
        let effects = box.answered(parent.clientOperationId, result: .outcome(.rejected(rejection)), generation: box.generation, now: now)
        XCTAssertTrue(effects.submitted.isEmpty)
        XCTAssertEqual(box.entry(reply.clientOperationId)?.status, .held(.parentRejected))
        XCTAssertFalse(box.entry(reply.clientOperationId)?.dispatched ?? true)
    }

    func testExpiredWindowBeforeFirstDispatchRejects() throws {
        var box = outbox()
        let expired = F.envelope(1)
        let next = F.envelope(2)
        let effects = try enqueue(&box, expired, expires: now)
        XCTAssertTrue(effects.submitted.isEmpty)
        XCTAssertEqual(effects.first, .persist)
        guard case .rejected(let rejection)? = box.entry(expired.clientOperationId)?.status else {
            return XCTFail("expected rejected, got \(String(describing: box.entry(expired.clientOperationId)?.status))")
        }
        XCTAssertEqual(rejection.reason, .operationExpired)
        XCTAssertEqual(rejection.clientOperationId, expired.clientOperationId.rawValue)
        XCTAssertFalse(box.entry(expired.clientOperationId)?.dispatched ?? true)
        // The room is free for the next send.
        XCTAssertEqual(try enqueue(&box, next).submitted, [next])
    }

    func testExpiredWindowBlocksResendOfNotFound() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope, expires: now.addingTimeInterval(10))
        _ = box.answered(envelope.clientOperationId, result: .outcome(.notFound), generation: box.generation, now: now)
        XCTAssertEqual(box.wake(now: now.addingTimeInterval(10)), [])
        XCTAssertEqual(box.resend(envelope.clientOperationId, now: now.addingTimeInterval(10)), [])
        XCTAssertEqual(box.giveUp(envelope.clientOperationId), [.seal(envelope)], "seal is still allowed")
    }

    // MARK: - Room and audience changes

    func testAudienceChangedHoldsOnlyNeverDispatchedDrafts() throws {
        var box = outbox()
        let sent = F.envelope(1)
        let draft = F.envelope(2)
        let elsewhere = F.envelope(3, room: "r2")
        try enqueue(&box, sent)
        try enqueue(&box, draft)
        try enqueue(&box, elsewhere)

        XCTAssertEqual(box.audienceChanged(roomId: "r1"), [.persist])
        XCTAssertEqual(box.entry(sent.clientOperationId)?.status, .sending)
        XCTAssertEqual(box.entry(sent.clientOperationId)?.envelope, sent)
        XCTAssertEqual(box.entry(draft.clientOperationId)?.status, .held(.audienceChanged))
        XCTAssertEqual(box.entry(elsewhere.clientOperationId)?.status, .sending)
        XCTAssertEqual(box.audienceChanged(roomId: "r3"), [])

        // Held drafts never go out on their own, even after the room frees.
        let effects = box.answered(sent.clientOperationId, result: .outcome(.accepted(F.acceptance(for: sent, messageId: "m1", sequence: 1))), generation: box.generation, now: now)
        XCTAssertTrue(effects.submitted.isEmpty)
        XCTAssertEqual(box.release(draft.clientOperationId, now: now), [.persist, .persist, .submit(draft)])
    }

    func testRoomRemovedDropsUnsentDraftsKeepsDispatched() throws {
        var box = outbox()
        let sent = F.envelope(1)
        let draft = F.envelope(2)
        let elsewhere = F.envelope(3, room: "r2")
        try enqueue(&box, sent)
        try enqueue(&box, draft)
        try enqueue(&box, elsewhere)

        XCTAssertEqual(box.roomRemoved(roomId: "r1"), [.persist])
        XCTAssertNotNil(box.entry(sent.clientOperationId))
        XCTAssertNil(box.entry(draft.clientOperationId))
        XCTAssertNotNil(box.entry(elsewhere.clientOperationId))
        XCTAssertEqual(box.roomRemoved(roomId: "r1"), [])
    }

    func testDiscardRefusesDispatchedUnresolved() throws {
        var box = outbox()
        let sent = F.envelope(1)
        let draft = F.envelope(2)
        try enqueue(&box, sent)
        try enqueue(&box, draft)

        XCTAssertEqual(box.discard(sent.clientOperationId), [])
        XCTAssertNotNil(box.entry(sent.clientOperationId))
        _ = box.answered(sent.clientOperationId, result: .indeterminate, generation: box.generation, now: now)
        XCTAssertEqual(box.discard(sent.clientOperationId), [])

        XCTAssertEqual(box.discard(draft.clientOperationId), [.persist])
        XCTAssertNil(box.entry(draft.clientOperationId))

        _ = box.answered(sent.clientOperationId, result: .outcome(.accepted(F.acceptance(for: sent, messageId: "m1", sequence: 1))), generation: box.generation, now: now)
        XCTAssertEqual(box.discard(sent.clientOperationId), [.persist])
        XCTAssertTrue(box.entries.isEmpty)
    }

    func testObservedOwnMessageAccepts() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        let next = F.envelope(2)
        try enqueue(&box, envelope)
        try enqueue(&box, next)
        let id = envelope.clientOperationId

        let someoneElse = F.message("m1", sequence: 1, actor: "bob", operation: id.rawValue)
        XCTAssertEqual(box.observed(someoneElse, now: now), [])
        XCTAssertEqual(box.entry(id)?.status, .sending)

        let wrongRoom = F.message("m1", sequence: 1, room: "r2", actor: "alice", operation: id.rawValue)
        XCTAssertEqual(box.observed(wrongRoom, now: now), [])

        let mine = F.message("m1", sequence: 4, actor: "alice", operation: id.rawValue)
        let effects = box.observed(mine, now: now)
        XCTAssertEqual(effects.first, .persist)
        XCTAssertEqual(effects.submitted, [next])
        guard case .accepted(let acceptance)? = box.entry(id)?.status else { return XCTFail("not accepted") }
        XCTAssertEqual(acceptance.messageId, "m1")
        XCTAssertEqual(acceptance.sequence, CloudSequence(4))
        XCTAssertEqual(acceptance.digest, envelope.digest)
        XCTAssertEqual(box.observed(mine, now: now), [], "second sighting is a no-op")
    }

    func testEphemeralEntriesExcludedFromPersisted() throws {
        var box = outbox()
        let durable = F.envelope(1)
        let guest = F.envelope(2, room: "r2")
        try enqueue(&box, durable)
        try enqueue(&box, guest, ephemeral: true)
        XCTAssertEqual(box.entries.count, 2)
        XCTAssertEqual(box.persisted.entries.map(\.id), [durable.clientOperationId])
        XCTAssertEqual(box.persisted.account, alice)
        XCTAssertEqual(box.entries.count, 2, "persisted is a copy")
    }

    func testRecoverAfterLaunchHoldsNeverSentDrafts() throws {
        var box = outbox()
        let sent = F.envelope(1)
        let draft = F.envelope(2)
        try enqueue(&box, sent)
        try enqueue(&box, draft)
        let effects = box.recoverAfterLaunch(now: now.addingTimeInterval(60))
        XCTAssertTrue(effects.submitted.isEmpty)
        XCTAssertEqual(box.entry(draft.clientOperationId)?.status, .held(.relaunched))

        var old = outbox()
        try enqueue(&old, F.envelope(1))
        try enqueue(&old, draft)
        _ = old.recoverAfterLaunch(now: now.addingTimeInterval(CloudOutbox.draftReviewAge + 1))
        XCTAssertEqual(old.entry(draft.clientOperationId)?.status, .held(.stale))
    }

    // MARK: - Validation

    func testValidationRejectsOversizedText() throws {
        XCTAssertNoThrow(try CloudSendValidation.validate(F.envelope(1, text: String(repeating: "a", count: CloudLimits.textBytes))))
        XCTAssertThrowsError(try CloudSendValidation.validate(F.envelope(1, text: String(repeating: "a", count: 65537)))) {
            XCTAssertEqual($0 as? CloudSendValidationError, .textTooLarge(bytes: 65537))
        }
        // Counted in UTF-8 bytes, not characters.
        let wide = String(repeating: "\u{e9}", count: 32769)
        XCTAssertEqual(wide.count, 32769)
        XCTAssertThrowsError(try CloudSendValidation.validate(F.envelope(1, text: wide))) {
            XCTAssertEqual($0 as? CloudSendValidationError, .textTooLarge(bytes: 65538))
        }
        var box = outbox()
        XCTAssertThrowsError(try enqueue(&box, F.envelope(1, text: wide)))
        XCTAssertTrue(box.entries.isEmpty, "nothing queued on a validation failure")
    }

    func testValidationRejectsOverlappingMentions() {
        let ok = F.envelope(1, text: "@bob @carol", mentions: [CloudMention(kind: .human, id: "bob", start: 0, end: 4), CloudMention(kind: .human, id: "carol", start: 5, end: 11)])
        XCTAssertNoThrow(try CloudSendValidation.validate(ok))
        let overlapping = F.envelope(1, text: "@bob @carol", mentions: [CloudMention(kind: .human, id: "bob", start: 0, end: 4), CloudMention(kind: .human, id: "carol", start: 2, end: 8)])
        XCTAssertThrowsError(try CloudSendValidation.validate(overlapping)) {
            XCTAssertEqual($0 as? CloudSendValidationError, .invalidMention(id: "carol"))
        }
        let outOfBounds = F.envelope(1, text: "@bob", mentions: [CloudMention(kind: .human, id: "bob", start: 0, end: 5)])
        XCTAssertThrowsError(try CloudSendValidation.validate(outOfBounds))
        let empty = F.envelope(1, text: "@bob", mentions: [CloudMention(kind: .human, id: "bob", start: 2, end: 2)])
        XCTAssertThrowsError(try CloudSendValidation.validate(empty))
    }

    func testValidationRejectsSurrogateSplit() {
        // "\u{1F44B}" is two UTF-16 units; offsets are UTF-16.
        let text = "\u{1F44B}@bob"
        XCTAssertNoThrow(try CloudSendValidation.validate(F.envelope(1, text: text, mentions: [CloudMention(kind: .human, id: "bob", start: 2, end: 6)])))
        XCTAssertThrowsError(try CloudSendValidation.validate(F.envelope(1, text: text, mentions: [CloudMention(kind: .human, id: "bob", start: 1, end: 6)]))) {
            XCTAssertEqual($0 as? CloudSendValidationError, .invalidMention(id: "bob"))
        }
        XCTAssertThrowsError(try CloudSendValidation.validate(F.envelope(1, text: "@bob\u{1F44B}", mentions: [CloudMention(kind: .human, id: "bob", start: 0, end: 5)])))
    }

    func testValidationRejectsAttachments() {
        var envelope = F.envelope(1)
        envelope.attachmentIds = ["a1"]
        XCTAssertThrowsError(try CloudSendValidation.validate(envelope)) {
            XCTAssertEqual($0 as? CloudSendValidationError, .unsupportedAttachment)
        }
    }

    func testValidationRejectsBadOperationId() {
        for raw in ["window1.short", "window1", ".abcdefghijklmnop", "window1.abcdefghijklmnop.x", "win dow.abcdefghijklmnop", "window1.abcdefghijklmnop!", "w\u{e9}.abcdefghijklmnop", "window1." + String(repeating: "a", count: 129)] {
            var envelope = F.envelope(1)
            envelope.clientOperationId = CloudOperationID(rawValue: raw)
            XCTAssertThrowsError(try CloudSendValidation.validate(envelope), raw) {
                XCTAssertEqual($0 as? CloudSendValidationError, .invalidOperationId, raw)
            }
        }
        XCTAssertTrue(CloudOperationID.isValid("window1.abcdefghijklmnop"))
        XCTAssertTrue(CloudOperationID.isValid("w_1-x.ABCDEFGHIJ_klmn-"))
        XCTAssertTrue(CloudOperationID.isValid(CloudOperationID(windowId: "window1").rawValue))
    }

    // MARK: - Offline

    func testOfflineSendWaitsFrozenAndReplaysOnceInOrderWhenOnline() throws {
        var box = outbox()
        let first = F.envelope(1, text: "one"), second = F.envelope(2, text: "two")
        try enqueue(&box, first)
        try enqueue(&box, second)
        XCTAssertEqual(box.entry(second.clientOperationId)?.status, .draft, "one send at a time per room")

        // No network: the request never left the device.
        let offline = box.answered(first.clientOperationId, result: .offline, generation: box.generation, now: now)
        XCTAssertEqual(offline, [.persist, .scheduleWake(after: CloudBackoff.cap)], "no immediate retry loop while offline")
        let waiting = try XCTUnwrap(box.entry(first.clientOperationId))
        XCTAssertEqual(waiting.status.label, .waiting)
        XCTAssertTrue(waiting.dispatched, "still frozen: never edited, re-keyed or dropped")
        XCTAssertEqual(waiting.digest, first.digest)
        XCTAssertEqual(box.discard(first.clientOperationId), [], "a frozen send cannot be discarded")

        // Still offline on a wake: the same envelope goes again, same key.
        XCTAssertEqual(box.wake(now: now.addingTimeInterval(1)), [.persist, .submit(first)])
        _ = box.answered(first.clientOperationId, result: .offline, generation: box.generation, now: now)

        // Network back: the same envelope, then the next, each exactly once.
        let online = box.wake(now: now.addingTimeInterval(2))
        XCTAssertEqual(online.submitted, [first])
        XCTAssertEqual(box.entry(first.clientOperationId)?.attempts, 3)
        let accepted = box.answered(first.clientOperationId, result: .outcome(.accepted(F.acceptance(for: first, messageId: "m1", sequence: 1))), generation: box.generation, now: now)
        XCTAssertEqual(accepted.submitted, [second])
        _ = box.answered(second.clientOperationId, result: .outcome(.accepted(F.acceptance(for: second, messageId: "m2", sequence: 2))), generation: box.generation, now: now)
        XCTAssertEqual(box.entries.map(\.status.label), [.accepted, .accepted])
        XCTAssertEqual(box.wake(now: now.addingTimeInterval(3)), [], "nothing left to send")
    }

    func testOfflineLookupKeepsCheckingAndRetriesLater() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        _ = box.answered(envelope.clientOperationId, result: .indeterminate, generation: box.generation, now: now)
        XCTAssertEqual(box.entry(envelope.clientOperationId)?.status, .checking)
        XCTAssertEqual(box.answered(envelope.clientOperationId, result: .offline, generation: box.generation, now: now), [.scheduleWake(after: CloudBackoff.cap)])
        XCTAssertEqual(box.entry(envelope.clientOperationId)?.status, .checking, "an offline lookup proves nothing")
    }

    func testOfflineSendAfterRelaunchIsLookedUpNotReplayed() throws {
        var box = outbox()
        let envelope = F.envelope(1)
        try enqueue(&box, envelope)
        _ = box.answered(envelope.clientOperationId, result: .offline, generation: box.generation, now: now)
        var relaunched = try JSONDecoder().decode(CloudOutbox.self, from: JSONEncoder().encode(box.persisted))
        XCTAssertEqual(relaunched.recoverAfterLaunch(now: now), [.persist, .lookup(envelope.clientOperationId, workspaceId: "w1")])
        XCTAssertEqual(relaunched.entry(envelope.clientOperationId)?.autoReplay, false)
    }

    func testNeverSentTransportCodesExcludeTimeouts() {
        XCTAssertTrue(CloudResponseClassifier.neverSent.contains(.notConnectedToInternet))
        XCTAssertFalse(CloudResponseClassifier.neverSent.contains(.timedOut))
        XCTAssertFalse(CloudResponseClassifier.neverSent.contains(.networkConnectionLost))
    }
}
