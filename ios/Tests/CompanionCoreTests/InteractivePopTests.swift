// The one rule the restored edge-swipe has to keep: never pop the root.
import XCTest
@testable import CompanionCore

final class InteractivePopTests: XCTestCase {
    func testAPushedScreenMaySwipeBack() {
        XCTAssertTrue(InteractivePop.allowsPop(stackDepth: 2))
        XCTAssertTrue(InteractivePop.allowsPop(stackDepth: 5))
    }

    func testTheRootRefusesTheGesture() {
        XCTAssertFalse(InteractivePop.allowsPop(stackDepth: 1))
        // Nothing on screen yet — the holder installs itself before the push.
        XCTAssertFalse(InteractivePop.allowsPop(stackDepth: 0))
    }
}
