import XCTest
@testable import CompanionCore

final class NotificationPolicyTests: XCTestCase {
    func testVisibleConversationStaysQuietAndBlockingRemainsListed() {
        XCTAssertEqual(NotificationPresentation.resolve(enabled: true, visible: true, blocking: false), .quiet)
        XCTAssertEqual(NotificationPresentation.resolve(enabled: true, visible: true, blocking: true), .list)
        XCTAssertEqual(NotificationPresentation.resolve(enabled: true, visible: false, blocking: true), .alert)
        XCTAssertEqual(NotificationPresentation.resolve(enabled: false, visible: false, blocking: true), .quiet)
    }

    func testAccountScopeAndRequestIdentitySurvivePayload() throws {
        let target = try XCTUnwrap(NotificationTarget(payload: ["botId": "bot", "threadId": "thread", "connectionId": "home-a", "requestId": "request", "messageId": "message", "kind": "approval"]))
        XCTAssertTrue(target.belongs(to: "home-a"))
        XCTAssertFalse(target.belongs(to: "home-b"))
        XCTAssertEqual(target.requestId, "request")
        XCTAssertEqual(target.messageId, "message")
        XCTAssertTrue(target.isBlocking)
        XCTAssertFalse(try XCTUnwrap(NotificationTarget(botId: "bot", threadId: "thread")).belongs(to: "home-a"))
    }

    func testReplayLedgerAndBatchCoalescingKeepBlocking() {
        var ledger = NotificationReplayLedger(limit: 2)
        XCTAssertTrue(ledger.insert("a"))
        XCTAssertFalse(ledger.insert("a"))
        XCTAssertTrue(ledger.insert("b"))
        XCTAssertTrue(ledger.insert("c"))
        XCTAssertEqual(ledger.ids, ["b", "c"])
        XCTAssertEqual(NotificationPresentation.coalescedIndices([("one", false), ("one", true), ("one", false), ("two", false)]), [1, 3])
    }

    func testOldRequestCannotOpenNewPendingRequestAndSettledIsExplicit() throws {
        let pending = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"message","role":"bot","kind":"options","at":1,"card":{"title":"review","subtitle":"","options":["Allow","Deny"],"requestId":"new-request"}}"#.utf8))
        let old = try XCTUnwrap(NotificationTarget(botId: "bot", threadId: "thread", requestId: "old-request", messageId: "message", kind: "approval"))
        XCTAssertEqual(old.requestState(in: [pending]), .unavailable)
        let current = try XCTUnwrap(NotificationTarget(botId: "bot", threadId: "thread", requestId: "new-request", messageId: "message", kind: "approval"))
        XCTAssertEqual(current.requestState(in: [pending]), .pending("message"))
        var settled = pending
        settled.card?.answered = "Deny"
        XCTAssertEqual(current.requestState(in: [settled]), .settled)
        XCTAssertEqual(try XCTUnwrap(NotificationTarget(botId: "bot", threadId: "thread", kind: "approval")).requestState(in: [pending]), .unavailable)
    }
}
