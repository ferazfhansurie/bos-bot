import XCTest
@testable import CompanionCore

final class StableOrderTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    func testFirstOrderIsTakenAsIs() {
        var order = StableOrder()
        XCTAssertNil(order.settle(["a", "b", "c"], now: t0))
        XCTAssertEqual(order.shown, ["a", "b", "c"])
    }

    func testOrderDoesNotMoveWhileHeld() {
        var order = StableOrder()
        order.settle(["a", "b", "c"], now: t0)
        order.hold(true)
        let retry = order.settle(["c", "a", "b"], now: t0.addingTimeInterval(10))
        XCTAssertNotNil(retry)
        XCTAssertEqual(order.arrange(["c", "a", "b"]), ["a", "b", "c"])
    }

    func testReleaseWaitsAFullIntervalBeforeMoving() {
        var order = StableOrder(interval: 1.5)
        order.settle(["a", "b", "c"], now: t0)
        order.hold(true)
        order.release(now: t0.addingTimeInterval(5))
        XCTAssertEqual(order.settle(["c", "a", "b"], now: t0.addingTimeInterval(5.5))!, 1.0, accuracy: 0.001)
        XCTAssertEqual(order.shown, ["a", "b", "c"])
        XCTAssertNil(order.settle(["c", "a", "b"], now: t0.addingTimeInterval(6.5)))
        XCTAssertEqual(order.shown, ["c", "a", "b"])
    }

    func testMovesAtMostOncePerInterval() {
        var order = StableOrder(interval: 1.5)
        order.settle(["a", "b", "c"], now: t0)
        XCTAssertNil(order.settle(["b", "a", "c"], now: t0.addingTimeInterval(2)))
        XCTAssertNotNil(order.settle(["c", "b", "a"], now: t0.addingTimeInterval(2.5)))
        XCTAssertEqual(order.shown, ["b", "a", "c"])
    }

    func testNewRowsGoOnTopAndRemovedRowsLeaveWhileHeld() {
        var order = StableOrder()
        order.settle(["a", "b", "c"], now: t0)
        order.hold(true)
        XCTAssertEqual(order.arrange(["d", "c", "a"]), ["d", "a", "c"])
    }
}
