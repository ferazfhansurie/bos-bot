import Foundation
import XCTest
@testable import CompanionCore

final class CloudRoomTests: XCTestCase {
    private typealias F = CloudFixture

    private func room() -> CloudRoomState {
        CloudRoomState(workspaceId: "w1", roomId: "r1", threadId: "t1", me: "alice")
    }

    /// A room primed from a snapshot (m1, m2 by bob) and a live batch (m3).
    private func liveRoom() -> CloudRoomState {
        var state = room()
        state.apply(F.snapshot(messages: [F.message("m1", sequence: 1), F.message("m2", sequence: 2)], watermark: 2, cursor: "c2", snapshotId: "s1"))
        _ = state.receive(F.batch([F.messageEvent(F.message("m3", sequence: 3), sequence: 3)], cursor: "c3", live: true))
        return state
    }

    // MARK: - Reset and subscribe

    func testResetWithSnapshotAppliesItAndResubscribesFromItsCursor() {
        var state = liveRoom()
        let snapshot = F.snapshot(messages: [F.message("m7", sequence: 7), F.message("m6", sequence: 6)], watermark: 9, cursor: "c9", snapshotId: "s9")
        let effects = state.receive(.reset(CloudReset(workspaceId: "w1", roomId: "r1", reason: .cursorInvalid, snapshot: snapshot)))
        XCTAssertEqual(effects, [.persist, .subscribe(cursor: "c9", snapshotId: "s9")])
        XCTAssertEqual(state.messageIds, ["m6", "m7"])
        XCTAssertEqual(state.cursor, "c9")
        XCTAssertEqual(state.snapshotId, "s9")
        XCTAssertEqual(state.watermark, CloudSequence(9))
        XCTAssertFalse(state.live)
        XCTAssertFalse(state.resetRequired)
    }

    func testResetWithSnapshotForAnotherThreadFetchesSnapshot() {
        var state = liveRoom()
        let snapshot = F.snapshot(messages: [F.message("x1", sequence: 9, thread: "t2")], thread: "t2", watermark: 9, cursor: "c9")
        XCTAssertEqual(state.receive(.reset(CloudReset(workspaceId: "w1", roomId: "r1", reason: .overflow, snapshot: snapshot))), [.fetchSnapshot])
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
        XCTAssertEqual(state.cursor, "c3")
    }

    func testResetWithoutSnapshotFetchesAndKeepsMessages() {
        var state = liveRoom()
        XCTAssertTrue(state.live)
        let effects = state.receive(.reset(CloudReset(workspaceId: "w1", roomId: "r1", reason: .overflow, snapshot: nil)))
        XCTAssertEqual(effects, [.fetchSnapshot])
        XCTAssertFalse(state.live)
        XCTAssertTrue(state.resetRequired)
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
        XCTAssertEqual(state.cursor, "c3")
    }

    func testResetForAnotherRoomIgnored() {
        var state = liveRoom()
        XCTAssertEqual(state.receive(.reset(CloudReset(workspaceId: "w1", roomId: "r2", reason: .overflow, snapshot: nil))), [])
        XCTAssertTrue(state.live)
        XCTAssertFalse(state.resetRequired)
    }

    func testResubscribeUsesStoredCursor() {
        var fresh = room()
        XCTAssertEqual(fresh.resubscribe(), [.subscribe(cursor: nil, snapshotId: nil)])

        var state = liveRoom()
        XCTAssertEqual(state.background(), [.closeStream])
        XCTAssertFalse(state.live)
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"], "background keeps the projection")
        XCTAssertEqual(state.resubscribe(), [.subscribe(cursor: "c3", snapshotId: nil)], "live at B: the cursor alone resumes")
    }

    func testCatchUpKeepsSnapshotIdUntilLive() {
        var state = room()
        state.apply(F.snapshot(messages: [F.message("m1", sequence: 1)], watermark: 1, cursor: "c1", snapshotId: "s1"))
        XCTAssertEqual(state.resubscribe(), [.subscribe(cursor: "c1", snapshotId: "s1")])
        _ = state.receive(.batch(CloudEventBatch(workspaceId: "w1", roomId: "r1", events: [], cursor: "c2", scannedSequence: CloudSequence(2), frontier: CloudSequence(5), live: false)))
        XCTAssertEqual(state.resubscribe(), [.subscribe(cursor: "c2", snapshotId: "s1")])
        _ = state.receive(.batch(CloudEventBatch(workspaceId: "w1", roomId: "r1", events: [], cursor: "c5", scannedSequence: CloudSequence(5), frontier: CloudSequence(5), live: true)))
        XCTAssertEqual(state.resubscribe(), [.subscribe(cursor: "c5", snapshotId: nil)])
    }

    func testUpgradeRequiredErrorBlocksResubscribe() {
        var state = liveRoom()
        XCTAssertEqual(state.receive(.error(.upgradeRequired)), [.closeStream, .persist])
        XCTAssertTrue(state.upgradeRequired)
        XCTAssertFalse(state.live)
        XCTAssertEqual(state.resubscribe(), [])
        // Batches are ignored while blocked; cursor stays put.
        XCTAssertEqual(state.receive(F.batch([F.messageEvent(F.message("m4", sequence: 4), sequence: 4)], cursor: "c4")), [])
        XCTAssertEqual(state.cursor, "c3")
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
    }

    func testUnknownRequiredEventBlocksWholeBatch() {
        var state = liveRoom()
        let good = F.messageEvent(F.message("m4", sequence: 4), sequence: 4)
        let unknown = CloudEvent(workspaceId: "w1", roomId: "r1", eventId: "ev5", sequence: CloudSequence(5), kind: "run.started", required: true, payload: [:])
        XCTAssertEqual(state.receive(F.batch([good, unknown], cursor: "c5")), [.closeStream, .persist])
        XCTAssertTrue(state.upgradeRequired)
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
        XCTAssertEqual(state.cursor, "c3")
    }

    func testCursorErrorsRequestSnapshot() {
        for code in [CloudErrorCode.cursorInvalid, .snapshotExpired, .visibilityChanged] {
            var state = liveRoom()
            XCTAssertEqual(state.receive(.error(code)), [.fetchSnapshot], code.rawValue)
            XCTAssertTrue(state.resetRequired, code.rawValue)
            XCTAssertFalse(state.live, code.rawValue)
        }
        var state = liveRoom()
        XCTAssertEqual(state.receive(.error(.unavailable)), [.closeStream])
        XCTAssertEqual(state.receive(.heartbeat), [])
    }

    // MARK: - Batches

    func testBatchFromAnotherRoomIgnored() {
        var state = liveRoom()
        let foreign = F.messageEvent(F.message("x1", sequence: 4, room: "r2"), sequence: 4)
        XCTAssertEqual(state.receive(F.batch([foreign], room: "r2", cursor: "other")), [])
        XCTAssertEqual(state.cursor, "c3")
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
    }

    func testEmptyBatchAdvancesCursor() {
        var state = liveRoom()
        XCTAssertEqual(state.receive(F.batch([], cursor: "c10", live: false)), [.persist])
        XCTAssertEqual(state.cursor, "c10")
        XCTAssertFalse(state.live)
    }

    func testEventsAtOrBelowWatermarkIgnored() {
        var state = room()
        state.apply(F.snapshot(messages: [F.message("m2", sequence: 2, text: "snap")], watermark: 2, cursor: "c2"))
        let replayed = F.messageEvent(F.message("m2", sequence: 2, version: 3, text: "stale replay"), sequence: 2, kind: CloudEventKind.messageUpdated)
        _ = state.receive(F.batch([replayed], cursor: "c2b"))
        XCTAssertEqual(state.messages.first?.text, "snap")
        XCTAssertEqual(state.cursor, "c2b")
    }

    func testMessageUpdatedHigherVersionReplacesLowerIgnored() {
        var state = liveRoom()
        let edited = F.message("m1", sequence: 1, version: 2, text: "edited")
        _ = state.receive(F.batch([F.messageEvent(edited, sequence: 4, kind: CloudEventKind.messageUpdated)], cursor: "c4"))
        XCTAssertEqual(state.messages.first, edited)

        let older = F.message("m1", sequence: 1, version: 1, text: "older")
        _ = state.receive(F.batch([F.messageEvent(older, sequence: 5, kind: CloudEventKind.messageUpdated)], cursor: "c5"))
        XCTAssertEqual(state.messages.first?.text, "edited")
        XCTAssertEqual(state.messages.first?.version, 2)
        XCTAssertEqual(state.cursor, "c5")
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])

        let tombstone = F.message("m1", sequence: 1, version: 3, text: "", deleted: true)
        _ = state.receive(F.batch([F.messageEvent(tombstone, sequence: 6, kind: CloudEventKind.messageDeleted)], cursor: "c6"))
        XCTAssertEqual(state.messages.first?.deleted, true)
    }

    func testOwnMessageInAnotherThreadObservedButNotShown() {
        var state = liveRoom()
        let mine = F.message("m4", sequence: 4, thread: "t2", actor: "alice", operation: "window1.nonce00000000001")
        let effects = state.receive(F.batch([F.messageEvent(mine, sequence: 4)], cursor: "c4"))
        XCTAssertEqual(effects, [.persist, .observedOwnSend(mine)])
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
        XCTAssertEqual(state.threadId, "t1")
        XCTAssertEqual(state.cursor, "c4")

        let theirs = F.message("m5", sequence: 5, thread: "t2", actor: "bob")
        XCTAssertEqual(state.receive(F.batch([F.messageEvent(theirs, sequence: 5)], cursor: "c5")), [.persist])
    }

    func testMembershipChangedRequestsAudienceReviewAndDiscovery() {
        var state = liveRoom()
        let event = CloudEvent(workspaceId: "w1", roomId: "r1", eventId: "ev4", sequence: CloudSequence(4), kind: CloudEventKind.membershipChanged, payload: [:])
        let effects = state.receive(F.batch([event], cursor: "c4"))
        XCTAssertTrue(effects.contains(.audienceChanged))
        XCTAssertTrue(effects.contains(.resyncDiscovery))

        let policy = CloudEvent(workspaceId: "w1", roomId: "r1", eventId: "ev5", sequence: CloudSequence(5), kind: CloudEventKind.policyChanged, payload: ["policy_revision": .string("3")])
        let policyEffects = state.receive(F.batch([policy], cursor: "c5"))
        XCTAssertTrue(policyEffects.contains(.audienceChanged))
        XCTAssertFalse(policyEffects.contains(.resyncDiscovery))
        XCTAssertEqual(state.policyRevision, CloudSequence(3))
    }

    // MARK: - Authority changed

    private func authorityEvent(_ sequence: Int, epoch: String = "e2", workspace: String = "w1", reason: String = "migration_cutover") -> CloudEvent {
        CloudEvent(workspaceId: "w1", roomId: "r1", eventId: "ev\(sequence)", sequence: CloudSequence(sequence), kind: CloudEventKind.authorityChanged,
                   payload: ["workspace_id": .string(workspace), "epoch": .string(epoch), "reason": .string(reason)])
    }

    func testAuthorityChangedDropsCursorAndSkipsTheRestOfTheBatch() {
        var state = liveRoom()
        let after = F.messageEvent(F.message("m5", sequence: 5), sequence: 5)
        let effects = state.receive(F.batch([authorityEvent(4), after], cursor: "c5"))
        XCTAssertEqual(effects, [.persist, .authorityChanged(epoch: "e2")])
        XCTAssertEqual(state.authorityEpoch, "e2")
        XCTAssertNil(state.cursor)
        XCTAssertNil(state.snapshotId)
        XCTAssertNil(state.watermark)
        XCTAssertFalse(state.live)
        XCTAssertTrue(state.resetRequired)
        XCTAssertTrue(state.awaitingAuthoritySnapshot)
        // The old cache stays on screen until the new snapshot; m5 rode the old cursor.
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
        XCTAssertEqual(state.resubscribe(), [.subscribe(cursor: nil, snapshotId: nil)])
    }

    func testAfterAuthorityChangedOldCursorBatchesWaitForTheNewSnapshot() {
        var state = liveRoom()
        _ = state.receive(F.batch([authorityEvent(4)], cursor: "c4"))
        XCTAssertEqual(state.receive(F.batch([F.messageEvent(F.message("m6", sequence: 6), sequence: 6)], cursor: "c6")), [])
        XCTAssertEqual(state.messageIds, ["m1", "m2", "m3"])
        XCTAssertNil(state.cursor)

        // The reset with a fresh snapshot replaces everything and streams resume.
        let snapshot = F.snapshot(messages: [F.message("n1", sequence: 1)], watermark: 1, cursor: "e2c1", snapshotId: "e2s1")
        XCTAssertEqual(state.receive(.reset(CloudReset(workspaceId: "w1", roomId: "r1", reason: .cursorInvalid, snapshot: snapshot))),
                       [.persist, .subscribe(cursor: "e2c1", snapshotId: "e2s1")])
        XCTAssertEqual(state.messageIds, ["n1"])
        XCTAssertFalse(state.awaitingAuthoritySnapshot)
        XCTAssertEqual(state.authorityEpoch, "e2")
        XCTAssertEqual(state.receive(F.batch([F.messageEvent(F.message("n2", sequence: 2), sequence: 2)], cursor: "e2c2")), [.persist])
        XCTAssertEqual(state.messageIds, ["n1", "n2"])
    }

    func testAuthorityChangedForTheSameEpochIsNotRepeated() {
        var state = liveRoom()
        _ = state.receive(F.batch([authorityEvent(4)], cursor: "c4"))
        state.apply(F.snapshot(messages: [F.message("n1", sequence: 1)], watermark: 1, cursor: "e2c1", snapshotId: "e2s1"))
        XCTAssertEqual(state.receive(F.batch([authorityEvent(2)], cursor: "e2c2")), [.persist])
        XCTAssertEqual(state.cursor, "e2c2")
    }

    func testMalformedAuthorityChangedIsUnreadable() {
        for bad in [authorityEvent(4, workspace: "w2"), authorityEvent(4, reason: "other"), authorityEvent(4, epoch: "")] {
            var state = liveRoom()
            XCTAssertEqual(state.receive(F.batch([bad], cursor: "c4")), [.closeStream, .persist])
            XCTAssertTrue(state.upgradeRequired)
            XCTAssertEqual(state.cursor, "c3")
            XCTAssertNil(state.authorityEpoch)
        }
    }

    func testAuthorityEpochSurvivesTheCache() throws {
        var state = liveRoom()
        _ = state.receive(F.batch([authorityEvent(4)], cursor: "c4"))
        let decoded = try JSONDecoder().decode(CloudRoomState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(decoded.authorityEpoch, "e2")
        XCTAssertTrue(decoded.awaitingAuthoritySnapshot)
    }

    func testCacheCappedAt500() {
        var state = room()
        var sequence = 0
        for page in 0..<6 {
            let events = (0..<100).map { _ -> CloudEvent in
                sequence += 1
                return F.messageEvent(F.message("m\(sequence)", sequence: sequence), sequence: sequence)
            }
            _ = state.receive(F.batch(events, cursor: "c\(page)"))
        }
        XCTAssertEqual(CloudRoomState.cachedMessageLimit, 500)
        XCTAssertEqual(state.messages.count, 500)
        XCTAssertEqual(state.messages.first?.messageId, "m101")
        XCTAssertEqual(state.messages.last?.messageId, "m600")

        var snapped = room()
        snapped.apply(F.snapshot(messages: (1...501).map { F.message("s\($0)", sequence: $0) }, watermark: 501))
        XCTAssertEqual(snapped.messages.count, 500)
        XCTAssertEqual(snapped.messages.first?.messageId, "s2")
    }

    // MARK: - Older history

    /// A full snapshot page (s51...s100), so the start isn't loaded yet.
    private func pagedRoom() -> CloudRoomState {
        var state = room()
        state.apply(F.snapshot(messages: (51...100).map { F.message("s\($0)", sequence: $0) }, watermark: 100))
        return state
    }

    func testOlderPagesJoinInFrontAndStopAtTheStart() throws {
        var state = pagedRoom()
        XCTAssertFalse(state.startLoaded)
        let before = try XCTUnwrap(state.requestOlder())
        XCTAssertEqual(before, CloudSequence(51))
        XCTAssertNil(state.requestOlder(), "one page at a time")
        XCTAssertNil(state.olderCursor)

        // A newer version of a loaded message and another thread's message ride along.
        let page = CloudHistoryPage(messages: (11...50).map { F.message("s\($0)", sequence: $0) } + [F.message("x", sequence: 49, thread: "t2"), F.message("s60", sequence: 60, version: 2, text: "edited")], nextBefore: CloudSequence(11))
        XCTAssertEqual(state.apply(page, before: before), [.persist])
        XCTAssertEqual(state.messageIds, (11...100).map { "s\($0)" })
        XCTAssertEqual(state.messages.first { $0.messageId == "s60" }?.version, 1, "only messages before the cursor join")
        XCTAssertFalse(state.startLoaded)
        XCTAssertNil(state.olderBefore)

        let next = try XCTUnwrap(state.requestOlder())
        XCTAssertEqual(next, CloudSequence(11))
        state.apply(CloudHistoryPage(messages: (1...10).map { F.message("s\($0)", sequence: $0) }, nextBefore: nil), before: next)
        XCTAssertEqual(state.messageIds, (1...100).map { "s\($0)" })
        XCTAssertTrue(state.startLoaded)
        XCTAssertNil(state.olderCursor, "nothing older to ask for")
    }

    func testEmptyPageAtTheExactBoundaryReachesTheStart() throws {
        var state = pagedRoom()
        let before = try XCTUnwrap(state.requestOlder())
        state.apply(CloudHistoryPage(messages: [], nextBefore: nil), before: before)
        XCTAssertTrue(state.startLoaded)
        XCTAssertEqual(state.messages.count, 50)
    }

    func testShortSnapshotIsTheWholeThread() {
        var state = room()
        state.apply(F.snapshot(messages: [F.message("m1", sequence: 1)], watermark: 1))
        XCTAssertTrue(state.startLoaded)
        XCTAssertNil(state.requestOlder())
    }

    func testPageAskedBeforeASnapshotIsDropped() throws {
        var state = pagedRoom()
        let before = try XCTUnwrap(state.requestOlder())
        state.apply(F.snapshot(messages: (61...110).map { F.message("s\($0)", sequence: $0) }, watermark: 110, cursor: "c-new", snapshotId: "s2"))
        XCTAssertNil(state.olderBefore, "the reset forgets the request")
        XCTAssertEqual(state.apply(CloudHistoryPage(messages: [F.message("s50", sequence: 50)], nextBefore: CloudSequence(50)), before: before), [])
        XCTAssertEqual(state.messages.first?.messageId, "s61")
    }

    func testFailedPageRetries() throws {
        var state = pagedRoom()
        let before = try XCTUnwrap(state.requestOlder())
        state.olderFailed(before: before)
        XCTAssertTrue(state.olderFailed)
        XCTAssertNil(state.olderBefore)
        XCTAssertEqual(state.requestOlder(), before)
        XCTAssertFalse(state.olderFailed)
    }

    func testPagedHistoryIsNotTrimmedByLiveMessages() throws {
        var state = room()
        state.apply(F.snapshot(messages: (501...550).map { F.message("s\($0)", sequence: $0) }, watermark: 550))
        var before = try XCTUnwrap(state.requestOlder())
        // 50 + 5 pages of 100: 550 loaded, past the cache cap.
        for page in 0..<5 {
            let low = 501 - (page + 1) * 100
            let messages = (low..<(low + 100)).map { F.message("o\($0)", sequence: $0) }
            state.apply(CloudHistoryPage(messages: messages, nextBefore: messages.first?.sequence), before: before)
            if page < 4 { before = try XCTUnwrap(state.requestOlder()) }
        }
        XCTAssertEqual(state.messages.count, 550)
        _ = state.receive(F.batch([F.messageEvent(F.message("live", sequence: 2000), sequence: 2000)], cursor: "c-live"))
        XCTAssertEqual(state.messages.count, 551)
        XCTAssertEqual(state.messages.last?.messageId, "live")

        // Once a snapshot replaces it, live inserts trim again and the start is no longer loaded.
        var trimmed = room()
        trimmed.apply(F.snapshot(messages: [F.message("m1", sequence: 1)], watermark: 1))
        XCTAssertTrue(trimmed.startLoaded)
        let events = (2...501).map { F.messageEvent(F.message("m\($0)", sequence: $0), sequence: $0) }
        _ = trimmed.receive(F.batch(events, cursor: "c501"))
        XCTAssertEqual(trimmed.messages.count, 500)
        XCTAssertFalse(trimmed.startLoaded)
        XCTAssertEqual(trimmed.olderCursor, CloudSequence(2))
    }

    func testStartLoadedSurvivesTheCacheAndOlderCachesDecode() throws {
        var state = room()
        state.apply(F.snapshot(messages: [F.message("m1", sequence: 1)], watermark: 1))
        let data = try JSONEncoder().encode(state)
        XCTAssertTrue(try JSONDecoder().decode(CloudRoomState.self, from: data).startLoaded)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object["startStore"] = nil
        let old = try JSONDecoder().decode(CloudRoomState.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertFalse(old.startLoaded)
    }

    func testHistoryPageDecodes() throws {
        let json = #"{"messages":[],"next_before":null}"#
        let page = try JSONDecoder().decode(CloudHistoryPage.self, from: Data(json.utf8))
        XCTAssertNil(page.nextBefore)
        XCTAssertEqual(CloudRoute.history(workspaceId: "w 1", roomId: "r1"), "/v2/workspaces/w%201/rooms/r1/history")
    }

    // MARK: - Read state

    func testUnreadCountIgnoresOwnDeletedAndCovered() {
        var state = room()
        let messages = [
            F.message("m1", sequence: 1),
            F.message("m2", sequence: 2),
            F.message("m3", sequence: 3),
            F.message("m4", sequence: 4),
            F.message("m5", sequence: 5),
            F.message("m6", sequence: 6, actor: "alice"),
            F.message("m7", sequence: 7, deleted: true),
        ]
        state.apply(F.snapshot(messages: messages, watermark: 7))
        XCTAssertEqual(state.unreadCount, 5)

        let coverage = CloudReadCoverage(prefix: CloudSequence(2), intervals: [CloudReadInterval(CloudSequence(4), CloudSequence(4))])
        XCTAssertEqual(state.apply(coverage), [.persist])
        XCTAssertEqual(state.read, coverage)
        // m3 and m5 remain.
        XCTAssertEqual(state.unreadCount, 2)
        XCTAssertEqual(coverage.unreadCount(in: messages + [messages[2]], me: "alice"), 2, "duplicates count once")
    }

    func testViewedRunsNeverBridgeLoadedInvisibleMessage() {
        let loaded = (1...5).map { F.message("m\($0)", sequence: $0) }
        XCTAssertEqual(CloudReadCoverage.viewedRuns(visible: ["m1", "m2", "m4", "m5"], loaded: loaded), [
            CloudReadInterval(CloudSequence(1), CloudSequence(2)),
            CloudReadInterval(CloudSequence(4), CloudSequence(5)),
        ])
        XCTAssertEqual(CloudReadCoverage.viewedRuns(visible: ["m3"], loaded: loaded), [CloudReadInterval(CloudSequence(3), CloudSequence(3))])
        XCTAssertEqual(CloudReadCoverage.viewedRuns(visible: [], loaded: loaded), [])
        // Contiguously loaded neighbours with a sequence gap (other threads,
        // filtered events) form one run.
        let gapped = [F.message("a", sequence: 10), F.message("b", sequence: 14)]
        XCTAssertEqual(CloudReadCoverage.viewedRuns(visible: ["a", "b"], loaded: gapped), [CloudReadInterval(CloudSequence(10), CloudSequence(14))])
    }
}
