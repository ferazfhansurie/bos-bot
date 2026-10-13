import XCTest
@testable import CompanionCore

final class BotConnectionPhaseTests: XCTestCase {
    func testRefreshMasksBothCachedAwakeAndAsleepUntilItSettles() {
        for live in [true, false] {
            XCTAssertEqual(BotConnectionPhase.resolve(refreshing: true, connecting: false, live: live), .checking)
        }
        XCTAssertEqual(BotConnectionPhase.resolve(refreshing: false, connecting: false, live: true), .awake)
        XCTAssertEqual(BotConnectionPhase.resolve(refreshing: false, connecting: false, live: false), .asleep)
    }

    func testColdConnectAndTimeoutRemainCheckingUntilConnectionResolves() {
        XCTAssertEqual(BotConnectionPhase.resolve(refreshing: false, connecting: true, live: false), .checking)
        XCTAssertEqual(BotConnectionPhase.resolve(refreshing: false, connecting: true, live: true), .checking)
    }
}
