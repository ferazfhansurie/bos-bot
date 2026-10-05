import XCTest
@testable import CompanionCore

final class MascotActivityChoreographyTests: XCTestCase {
    func testDeterministicTimingAndPausedRestWindows() {
        XCTAssertEqual(MascotActivityChoreography.period(.thinking), 4.6, accuracy: 0.0001)
        XCTAssertEqual(MascotActivityChoreography.period(.searching), 3.7, accuracy: 0.0001)
        XCTAssertEqual(MascotActivityChoreography.period(.working), 4.6, accuracy: 0.0001)
        XCTAssertEqual(MascotActivityChoreography.pose(.thinking, elapsed: 2), .idle)
        XCTAssertGreaterThan(MascotActivityChoreography.nextFrameDelay(.thinking, elapsed: 2), 2)
        XCTAssertEqual(MascotActivityChoreography.pose(.finished, elapsed: 1), .idle)
        XCTAssertNil(MascotActivityChoreography.nextFrameDelayIfMoving(.idle, elapsed: 0))
    }
    func testWaitingWinsEvenWhenWireAlsoSaysBusy() {
        XCTAssertEqual(MascotActivityChoreography.activity(runtime: "working", busy: true, waitingOnTeammate: true, pendingRequest: false, toolName: "web_search"), .waiting)
        XCTAssertEqual(MascotActivityChoreography.activity(runtime: "waiting-on-you", busy: true, waitingOnTeammate: false, pendingRequest: false, toolName: nil), .waiting)
        XCTAssertEqual(MascotActivityChoreography.activity(runtime: "working", busy: true, waitingOnTeammate: false, pendingRequest: false, toolName: "web_search"), .searching)
    }
    func testAdapterUsesDecodedTaskRuntimeInsteadOfRoleNames() throws {
        let task = try JSONDecoder().decode(BotTask.self, from: Data(#"{"threadId":"t","title":"search expert","createdAt":1,"busy":true,"activity":"working","waitingOnTeammate":true}"#.utf8))
        XCTAssertEqual(MascotActivityChoreography.activity(task: task, last: nil), .waiting)
        var idle = task
        idle.busy = false; idle.activity = "idle"; idle.waitingOnTeammate = false
        XCTAssertEqual(MascotActivityChoreography.activity(task: idle, last: nil), .idle)
    }
    func testFinishOncePerObservedTurnAndNeverReplayHydration() {
        var ledger = MascotCompletionLedger()
        XCTAssertFalse(ledger.observe(turnID: "old", active: false, completed: true, hydration: true))
        XCTAssertFalse(ledger.observe(turnID: "new", active: true, completed: false, hydration: false))
        XCTAssertTrue(ledger.observe(turnID: "new", active: false, completed: true, hydration: false))
        XCTAssertFalse(ledger.observe(turnID: "new", active: false, completed: true, hydration: true))
        XCTAssertFalse(ledger.observe(turnID: "new", active: false, completed: true, hydration: false))
        XCTAssertFalse(ledger.observe(turnID: nil, active: false, completed: true, hydration: false))
    }
    func testOriginalCatalogRingIsFiniteAndTransitionStartsFromCurrentPose() {
        for body in FlatMascotBodies.all {
            let ring = MascotActivityGeometry.ring(body.id)
            XCTAssertEqual(ring.count, 128)
            XCTAssertTrue(ring.allSatisfy { $0.x.isFinite && $0.y.isFinite }, body.id)
        }
        let before = MascotActivityChoreography.pose(.working, elapsed: 0.6)
        XCTAssertEqual(before.interpolated(to: .idle, progress: 0), before)
        XCTAssertEqual(before.interpolated(to: .idle, progress: 1), .idle)
        XCTAssertGreaterThan(before.split, 0.5)
        XCTAssertGreaterThan(MascotActivityChoreography.pose(.thinking, elapsed: 1).curl, 0.5)
    }
}
