import XCTest
@testable import CompanionCore

final class ThreadListPolicyTests: XCTestCase {
    func testApprovalOverridesBusyWithoutHidingOtherRunningThreads() {
        var approval = task("approval"); approval.busy = true
        var running = task("running"); running.activity = "running"
        let waiting: Set<String> = ["approval"]
        XCTAssertTrue(ThreadListPolicy.matches(approval, filter: "waiting", waiting: waiting))
        XCTAssertFalse(ThreadListPolicy.matches(approval, filter: "running", waiting: waiting))
        XCTAssertTrue(ThreadListPolicy.matches(running, filter: "running", waiting: waiting))
        XCTAssertFalse(ThreadListPolicy.matches(running, filter: "waiting", waiting: waiting))
    }

    func testServerWaitingStateWorksBeforeApprovalPayloadLoads() {
        var pending = task("pending"); pending.activity = "waiting-on-you"; pending.busy = true
        XCTAssertTrue(ThreadListPolicy.matches(pending, filter: "waiting", waiting: []))
        XCTAssertFalse(ThreadListPolicy.matches(pending, filter: "running", waiting: []))
    }

    func testFilterUsesOnlyTheOwningComputersApprovalSet() {
        var sameID = task("shared-id"); sameID.activity = "working"
        XCTAssertFalse(ThreadListPolicy.matches(sameID, filter: "running", waiting: ["shared-id"]))
        XCTAssertTrue(ThreadListPolicy.matches(sameID, filter: "running", waiting: []))
        XCTAssertFalse(ThreadListPolicy.matches(sameID, filter: "waiting", waiting: []))
    }

    func testUnreadAndIdleDoNotBecomeRunning() {
        var unread = task("unread"); unread.unread = true
        XCTAssertTrue(ThreadListPolicy.matches(unread, filter: "unread", waiting: []))
        XCTAssertFalse(ThreadListPolicy.matches(unread, filter: "running", waiting: []))
        XCTAssertFalse(ThreadListPolicy.matches(task("idle"), filter: "unread", waiting: []))
        XCTAssertTrue(ThreadListPolicy.matches(task("idle"), filter: "all", waiting: []))
        XCTAssertFalse(ThreadListPolicy.matches(task("queued"), filter: "running", waiting: [], queued: ["queued"]))
    }

    func testPinsKeepManualOrderThenActivityThenStableTieBreak() {
        var recent = task("recent", created: 5); recent.lastActivityAt = 100
        let tasks = [task("b", created: 10), recent, task("pin-a"), task("a", created: 10), task("pin-b")]
        let pins = ["absent", "pin-b", "pin-a", "pin-b"]
        let expected = ["pin-b", "pin-a", "recent", "a", "b"]
        XCTAssertEqual(ThreadListPolicy.ordered(tasks, pins: pins).map(\.threadId), expected)
        XCTAssertEqual(ThreadListPolicy.ordered(tasks.reversed(), pins: pins).map(\.threadId), expected)
    }

    private func task(_ id: String, created: Double = 1) -> BotTask {
        BotTask(threadId: id, title: id, createdAt: created)
    }
}
