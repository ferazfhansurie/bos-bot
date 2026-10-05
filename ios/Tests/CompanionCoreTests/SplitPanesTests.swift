// The wide-screen split: how far the divider may go, and when the roster
// steps aside.
import XCTest
@testable import CompanionCore

final class SplitPanesTests: XCTestCase {
    func testAFractionInsideTheMinimumsIsKept() {
        XCTAssertEqual(SplitPanes.clamp(0.5, in: 1012), 0.5)
        XCTAssertEqual(SplitPanes.clamp(0.6, in: 1012), 0.6, accuracy: 0.0001)
    }

    func testNeitherPaneDropsBelowItsMinimum() {
        let width = 1012.0
        for fraction in [-1.0, 0, 0.05, 0.95, 1, 2] {
            let panes = SplitPanes.paneWidths(fraction, in: width)
            XCTAssertGreaterThanOrEqual(panes.primary, SplitPanes.minimumPaneWidth - 0.5)
            XCTAssertGreaterThanOrEqual(panes.side, SplitPanes.minimumPaneWidth - 0.5)
            XCTAssertEqual(panes.primary + panes.side, width - SplitPanes.handleWidth, accuracy: 0.0001)
        }
    }

    func testTooNarrowOrGarbageFallsBackToEven() {
        XCTAssertEqual(SplitPanes.clamp(0.8, in: 500), SplitPanes.defaultFraction)
        XCTAssertEqual(SplitPanes.clamp(.nan, in: 1012), SplitPanes.defaultFraction)
        XCTAssertEqual(SplitPanes.clamp(.infinity, in: 1012), SplitPanes.defaultFraction)
        XCTAssertEqual(SplitPanes.clamp(0.3, in: 0), SplitPanes.defaultFraction)
    }

    func testDraggingMovesByTheShareOfUsableWidth() {
        // 1012 wide leaves 1000 for the panes: 100pt is a tenth.
        XCTAssertEqual(SplitPanes.dragged(from: 0.5, by: 100, in: 1012), 0.6, accuracy: 0.0001)
        XCTAssertEqual(SplitPanes.dragged(from: 0.5, by: -100, in: 1012), 0.4, accuracy: 0.0001)
        // and stops at the far pane's minimum
        XCTAssertEqual(SplitPanes.dragged(from: 0.5, by: 900, in: 1012), 1 - 320.0 / 1000, accuracy: 0.0001)
    }

    func testTwoPanesNeedRoomForBothMinimums() {
        XCTAssertTrue(SplitPanes.fitsTwoPanes(in: 652))
        XCTAssertFalse(SplitPanes.fitsTwoPanes(in: 651))
    }

    func testTheRosterShowsWhenNothingIsOpen() {
        XCTAssertTrue(SplitPanes.showsSidebar(in: 400, panes: 0))
    }

    func testTheRosterStepsAsideBeforeAPaneIsSqueezed() {
        // iPad portrait: roster beside one chat, not beside two
        XCTAssertTrue(SplitPanes.showsSidebar(in: 820, panes: 1))
        XCTAssertFalse(SplitPanes.showsSidebar(in: 820, panes: 2))
        // iPad landscape: room for all three
        XCTAssertTrue(SplitPanes.showsSidebar(in: 1180, panes: 2))
        XCTAssertFalse(SplitPanes.showsSidebar(in: 600, panes: 1))
    }
}
