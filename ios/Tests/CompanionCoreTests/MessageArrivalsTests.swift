import XCTest
@testable import CompanionCore

final class MessageArrivalsTests: XCTestCase {
    func testWhatWasOnScreenWhenTheChatOpenedStaysStill() {
        let arrivals = MessageArrivals()
        arrivals.track(threadId: "t1", messages: [("a", 1), ("b", 2)], now: 10)
        XCTAssertFalse(arrivals.isArriving("a"))
        XCTAssertFalse(arrivals.isArriving("b"))
    }

    func testANewMessageArrivesUntilTheWindowPasses() {
        let arrivals = MessageArrivals()
        arrivals.track(threadId: "t1", messages: [("a", 1)], now: 10)
        arrivals.track(threadId: "t1", messages: [("a", 1), ("b", 2)], now: 10.01)
        XCTAssertTrue(arrivals.isArriving("b"))
        arrivals.track(threadId: "t1", messages: [("a", 1), ("b", 2)], now: 10.01 + MessageArrivals.window - 0.001)
        XCTAssertTrue(arrivals.isArriving("b"))
        arrivals.track(threadId: "t1", messages: [("a", 1), ("b", 2)], now: 10.01 + MessageArrivals.window)
        XCTAssertFalse(arrivals.isArriving("b"))
    }

    func testOlderPagesLoadedAboveStayStill() {
        let arrivals = MessageArrivals()
        arrivals.track(threadId: "t1", messages: [("c", 10)], now: 10)
        arrivals.track(threadId: "t1", messages: [("a", 1), ("b", 2), ("c", 10)], now: 10.01)
        XCTAssertFalse(arrivals.isArriving("a"))
        XCTAssertFalse(arrivals.isArriving("b"))
    }

    func testSwitchingThreadsStartsFresh() {
        let arrivals = MessageArrivals()
        arrivals.track(threadId: "t1", messages: [("a", 1)], now: 10)
        arrivals.track(threadId: "t2", messages: [("x", 5)], now: 10.01)
        XCTAssertFalse(arrivals.isArriving("x"))
    }
}
