import XCTest
@testable import CompanionCore

final class SectionSelectionTests: XCTestCase {
    func testStaleDwellCannotCommitAfterCandidateChanges() {
        var selection = SectionSelection()
        let stale = selection.beginDrag(over: "a")!
        let current = selection.moveDrag(over: "b")!

        XCTAssertEqual(selection.commit(stale), .unchanged)
        XCTAssertEqual(selection.commit(current), .added("b"))
        XCTAssertEqual(selection.selectedIDs, ["b"])
    }

    func testStableCellCommitsOnlyOnceUntilFingerLeaves() {
        var selection = SectionSelection()
        let candidate = selection.beginDrag(over: "a")!

        XCTAssertEqual(selection.commit(candidate), .added("a"))
        XCTAssertNil(selection.moveDrag(over: "a"))
        XCTAssertEqual(selection.commit(candidate), .unchanged)
        XCTAssertEqual(selection.selectedIDs, ["a"])
    }

    func testGapAndEndCancelOutstandingDwell() {
        var selection = SectionSelection()
        let gapStale = selection.beginDrag(over: "a")!
        XCTAssertNil(selection.moveDrag(over: nil))
        XCTAssertEqual(selection.commit(gapStale), .unchanged)

        let endStale = selection.moveDrag(over: "b")!
        selection.endDrag()
        XCTAssertEqual(selection.commit(endStale), .unchanged)
        XCTAssertTrue(selection.selectedIDs.isEmpty)
        XCTAssertTrue(selection.gestureTrail.isEmpty)
    }

    func testReturningToEarlierCellBacktracksOnlyTheGestureTail() {
        var selection = SectionSelection()
        commit("a", into: &selection, beginning: true)
        commit("b", into: &selection)
        commit("c", into: &selection)

        _ = selection.moveDrag(over: nil)
        let backtrack = selection.moveDrag(over: "a")!
        XCTAssertEqual(selection.commit(backtrack), .backtracked(removed: ["b", "c"]))
        XCTAssertEqual(selection.selectedIDs, ["a"])
        XCTAssertEqual(selection.gestureTrail, ["a"])
    }

    func testPreselectedBotsAreNotDuplicatedOrRemovedByBacktracking() {
        var selection = SectionSelection(selectedIDs: ["kept", "also-kept", "kept"])
        let kept = selection.beginDrag(over: "kept")!
        XCTAssertEqual(selection.commit(kept), .visited("kept"))
        commit("new-1", into: &selection)
        commit("new-2", into: &selection)

        _ = selection.moveDrag(over: nil)
        let backtrack = selection.moveDrag(over: "kept")!
        XCTAssertEqual(selection.commit(backtrack), .backtracked(removed: ["new-1", "new-2"]))
        XCTAssertEqual(selection.selectedIDs, ["kept", "also-kept"])
    }

    func testTapFallbackSelectAllAndClearKeepStableOrder() {
        var selection = SectionSelection()
        selection.toggle("b")
        selection.toggle("a")
        selection.toggle("b")
        XCTAssertEqual(selection.selectedIDs, ["a"])

        selection.selectAll(["c", "a", "c", "b"])
        XCTAssertEqual(selection.selectedIDs, ["c", "a", "b"])
        selection.clear()
        XCTAssertTrue(selection.selectedIDs.isEmpty)
    }

    func testSelectionLimitAppliesToInitialTapSelectAllAndDragPaths() {
        var selection = SectionSelection(selectedIDs: ["a", "b", "c"], maximumCount: 2)
        XCTAssertEqual(selection.selectedIDs, ["a", "b"])
        XCTAssertFalse(selection.toggle("c"))

        XCTAssertTrue(selection.toggle("a"))
        XCTAssertTrue(selection.toggle("c"))
        selection.selectAll(["d", "e", "f"])
        XCTAssertEqual(selection.selectedIDs, ["d", "e"])

        let candidate = selection.beginDrag(over: "f")!
        XCTAssertEqual(selection.commit(candidate), .limitReached("f"))
        XCTAssertEqual(selection.selectedIDs, ["d", "e"])
    }

    func testHitTestingFindsCellsAndLeavesGridGapsEmpty() {
        let frames = [
            SectionGridCellFrame(id: "left", minX: 0, minY: 0, maxX: 40, maxY: 40),
            SectionGridCellFrame(id: "right", minX: 50, minY: 0, maxX: 90, maxY: 40),
        ]

        XCTAssertEqual(SectionGridHitTesting.cellID(at: .init(x: 20, y: 20), in: frames), "left")
        XCTAssertNil(SectionGridHitTesting.cellID(at: .init(x: 45, y: 20), in: frames))
        XCTAssertEqual(SectionGridHitTesting.cellID(at: .init(x: 50, y: 20), in: frames), "right")
        XCTAssertNil(SectionGridHitTesting.cellID(at: .init(x: 90, y: 20), in: frames))
    }

    func testHitTestingIgnoresEmptyFramesAndUsesFirstOverlap() {
        let frames = [
            SectionGridCellFrame(id: "empty", minX: 10, minY: 10, maxX: 10, maxY: 30),
            SectionGridCellFrame(id: "front", minX: 0, minY: 0, maxX: 30, maxY: 30),
            SectionGridCellFrame(id: "back", minX: 0, minY: 0, maxX: 30, maxY: 30),
        ]
        XCTAssertEqual(SectionGridHitTesting.cellID(at: .init(x: 12, y: 12), in: frames), "front")
    }

    private func commit(
        _ id: String,
        into selection: inout SectionSelection,
        beginning: Bool = false
    ) {
        let candidate = beginning
            ? selection.beginDrag(over: id)!
            : selection.moveDrag(over: id)!
        XCTAssertTrue(selection.commit(candidate).givesFeedback)
    }
}
