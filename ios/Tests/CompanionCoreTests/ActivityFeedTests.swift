import Foundation
import XCTest
@testable import CompanionCore

private final class ActivityFeedRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ActivityFeedTests: XCTestCase {
    private func entry(_ bot: String, _ thread: String, _ state: ActivityFeedState, since: Double,
                       room: String? = nil, tool: String? = nil) -> ActivityFeedEntry {
        ActivityFeedEntry(botId: bot, threadId: thread, roomId: room, state: state, since: since, toolName: tool)
    }

    private func decode(_ json: String) throws -> ActivityFeedEntry {
        try JSONDecoder().decode(ActivityFeedEntry.self, from: Data(json.utf8))
    }

    // MARK: - Decoding

    func testDecodesAnEntryWithEpochMillisecondsAndARoom() throws {
        let decoded = try decode(#"{"botId":"b1","threadId":"t1","roomId":"g1","state":"tool","since":1788603055630}"#)
        XCTAssertEqual(decoded, entry("b1", "t1", .tool, since: 1788603055630, room: "g1"))
    }

    func testDecodesISO8601SinceWithAndWithoutFractionalSeconds() throws {
        let fractional = try decode(#"{"botId":"b","threadId":"t","state":"thinking","since":"2026-10-06T12:00:00.250Z"}"#)
        let whole = try decode(#"{"botId":"b","threadId":"t","state":"thinking","since":"2026-10-06T12:00:00Z"}"#)
        XCTAssertEqual(whole.since, 1_791_288_000_000)
        XCTAssertEqual(fractional.since, 1_791_288_000_250)
    }

    func testEpochAndISOSinceAgree() throws {
        let epoch = try decode(#"{"botId":"b","threadId":"t","state":"typing","since":1791288000000}"#)
        let iso = try decode(#"{"botId":"b","threadId":"t","state":"typing","since":"2026-10-06T12:00:00Z"}"#)
        let seconds = try decode(#"{"botId":"b","threadId":"t","state":"typing","since":1791288000}"#)
        let numericText = try decode(#"{"botId":"b","threadId":"t","state":"typing","since":"1791288000000"}"#)
        XCTAssertEqual(epoch.since, iso.since)
        XCTAssertEqual(seconds.since, epoch.since, "a seconds timestamp is normalised to milliseconds")
        XCTAssertEqual(numericText.since, epoch.since)
    }

    func testUnknownOrMissingStateDecodesToIdleRatherThanFailing() throws {
        XCTAssertEqual(try decode(#"{"botId":"b","threadId":"t","state":"juggling","since":1}"#).state, .idle)
        XCTAssertEqual(try decode(#"{"botId":"b","threadId":"t","since":1}"#).state, .idle)
        XCTAssertEqual(try decode(#"{"botId":"b","threadId":"t","state":42,"since":1}"#).state, .idle)
        XCTAssertEqual(try decode(#"{"botId":"b","threadId":"t","state":"WAITING","since":1}"#).state, .waiting)
    }

    func testMissingOrNullRoomAndUnreadableSinceAreTolerated() throws {
        let decoded = try decode(#"{"botId":"b","threadId":"t","roomId":null,"state":"failed","since":"not a date"}"#)
        XCTAssertNil(decoded.roomId)
        XCTAssertEqual(decoded.since, 0)
        XCTAssertEqual(decoded.state, .failed)
        XCTAssertNil(try decode(#"{"botId":"b","threadId":"t","state":"idle"}"#).roomId)
    }

    func testAnEntryWithoutItsIdentityIsRejected() {
        XCTAssertThrowsError(try decode(#"{"threadId":"t","state":"thinking","since":1}"#))
        XCTAssertThrowsError(try decode(#"{"botId":"b","state":"thinking","since":1}"#))
    }

    func testSnapshotAcceptsABareListOrAWrappedOneAndDropsBadLines() throws {
        let bare = try JSONDecoder().decode(ActivityFeedSnapshot.self, from: Data(#"""
        [{"botId":"b","threadId":"t","state":"thinking","since":1}, {"nope":true}]
        """#.utf8))
        XCTAssertEqual(bare.entries.map(\.botId), ["b"])
        let wrapped = try JSONDecoder().decode(ActivityFeedSnapshot.self, from: Data(#"""
        {"entries":[{"botId":"b","threadId":"t","state":"tool","since":1},{"botId":"c","threadId":"u","state":"typing","since":2}]}
        """#.utf8))
        XCTAssertEqual(wrapped.entries.map(\.state), [.tool, .typing])
        let activity = try JSONDecoder().decode(ActivityFeedSnapshot.self, from: Data(#"{"activity":[{"botId":"b","threadId":"t"}]}"#.utf8))
        XCTAssertEqual(activity.entries.count, 1)
        let items = try JSONDecoder().decode(ActivityFeedSnapshot.self, from: Data(#"""
        {"items":[{"botId":"b","threadId":"t","roomId":"g","state":"waiting","since":1791288000001,"turnId":"turn-1"}]}
        """#.utf8))
        XCTAssertEqual(items.entries, [ActivityFeedEntry(botId: "b", threadId: "t", roomId: "g", state: .waiting, since: 1_791_288_000_001)])
        let empty = try JSONDecoder().decode(ActivityFeedSnapshot.self, from: Data(#"{"something":"else"}"#.utf8))
        XCTAssertTrue(empty.entries.isEmpty)
    }

    func testActivityFramesDecodeInEveryPlausibleShape() throws {
        func frame(_ json: String) throws -> Frame {
            try JSONDecoder().decode(StreamFrame.self, from: Data(json.utf8)).frame
        }
        let kind = activityFeedEventName
        let shapes = [
            #"{"kind":"\#(kind)","seq":4,"botId":"b","threadId":"t","state":"thinking","since":1791288000005}"#,
            #"{"kind":"\#(kind)","seq":4,"entry":{"botId":"b","threadId":"t","state":"thinking","since":1791288000005}}"#,
            #"{"kind":"\#(kind)","seq":4,"activity":{"botId":"b","threadId":"t","state":"thinking","since":1791288000005}}"#,
        ]
        for json in shapes {
            guard case let .activity(entries, replace) = try frame(json) else { return XCTFail("not an activity frame: \(json)") }
            XCTAssertEqual(entries, [entry("b", "t", .thinking, since: 1_791_288_000_005)], json)
            XCTAssertFalse(replace, json)
        }
        let lists = [
            #"{"kind":"\#(kind)","seq":4,"items":[{"botId":"b","threadId":"t","roomId":null,"state":"thinking","since":1791288000005,"turnId":"x"}]}"#,
            #"{"kind":"\#(kind)","seq":4,"entries":[{"botId":"b","threadId":"t","state":"thinking","since":1791288000005}]}"#,
        ]
        for json in lists {
            guard case let .activity(entries, replace) = try frame(json) else { return XCTFail("not an activity frame: \(json)") }
            XCTAssertEqual(entries, [entry("b", "t", .thinking, since: 1_791_288_000_005)], json)
            XCTAssertTrue(replace, "a list is the server's full replacement: \(json)")
        }
        guard case let .activity(none, noneReplace) = try frame(#"{"kind":"\#(kind)","garbage":1}"#) else {
            return XCTFail("an unreadable activity payload is an empty update, not a dropped frame")
        }
        XCTAssertTrue(none.isEmpty)
        XCTAssertFalse(noneReplace)
        guard case let .activity(junk, junkReplace) = try frame(#"{"kind":"\#(kind)","items":[{"nope":1}]}"#) else {
            return XCTFail("not an activity frame")
        }
        XCTAssertTrue(junk.isEmpty)
        XCTAssertFalse(junkReplace, "lines that do not read must not wipe the feed")
    }

    func testAPushedReplacementDropsLanesItOmits() {
        var state = CompanionState()
        state.apply(.activity([entry("b", "t", .thinking, since: 1), entry("b", "u", .tool, since: 2)], replace: true))
        state.apply(.activity([entry("b", "u", .typing, since: 3)], replace: true))
        XCTAssertNil(state.activityFeed.state(bot: "b", thread: "t"))
        XCTAssertEqual(state.activityFeed.state(bot: "b", thread: "u"), .typing)
        state.apply(.activity([], replace: true))
        XCTAssertTrue(state.activityFeed.isEmpty, "an empty replacement means nothing is running")
    }

    // MARK: - Folding

    func testAnUpdateOlderThanTheStoredEntryIsIgnored() {
        var feed = ActivityFeed()
        XCTAssertTrue(feed.apply(update: entry("b", "t", .tool, since: 200)))
        XCTAssertFalse(feed.apply(update: entry("b", "t", .thinking, since: 100)))
        XCTAssertEqual(feed.state(bot: "b", thread: "t"), .tool)
        XCTAssertTrue(feed.apply(update: entry("b", "t", .idle, since: 200)), "an equal since is a later push and wins")
        XCTAssertEqual(feed.state(bot: "b", thread: "t"), .idle)
        XCTAssertTrue(feed.apply(update: entry("b", "t", .typing, since: 300)))
        XCTAssertEqual(feed.state(bot: "b", thread: "t"), .typing)
    }

    func testAStaleFrameDoesNotRewindTheStateTheStoreHolds() {
        var state = CompanionState()
        state.apply(.activity([entry("b", "t", .waiting, since: 50)], replace: false))
        state.apply(.activity([entry("b", "t", .thinking, since: 10)], replace: false))
        XCTAssertEqual(state.activityFeed.state(bot: "b", thread: "t"), .waiting)
    }

    func testSnapshotReplacesTheFeedButKeepsNewerEntries() {
        var feed = ActivityFeed()
        feed.apply(update: entry("b", "gone", .thinking, since: 10))
        feed.apply(update: entry("b", "t", .tool, since: 500))
        feed.apply(snapshot: [entry("b", "t", .thinking, since: 400), entry("c", "u", .waiting, since: 1)])
        XCTAssertNil(feed.state(bot: "b", thread: "gone"), "a thread the snapshot omits is idle")
        XCTAssertEqual(feed.state(bot: "b", thread: "t"), .tool, "the newer push outlives an older snapshot line")
        XCTAssertEqual(feed.state(bot: "c", thread: "u"), .waiting)
    }

    func testPushesReceivedDuringASnapshotFetchSurviveIt() {
        var feed = ActivityFeed()
        feed.apply(update: entry("b", "old", .thinking, since: 1))
        let mark = feed.revision
        feed.apply(update: entry("b", "new", .tool, since: 2))
        feed.apply(snapshot: [], preservingUpdatesAfter: mark)
        XCTAssertNil(feed.state(bot: "b", thread: "old"))
        XCTAssertEqual(feed.state(bot: "b", thread: "new"), .tool)
    }

    func testADeletedBotLeavesTheFeed() {
        var state = CompanionState()
        state.apply(.activity([entry("b", "t", .thinking, since: 1)], replace: false))
        state.apply(.botDeleted(botId: "b"))
        XCTAssertNil(state.activityFeed.busiest(bot: "b"))
    }

    // MARK: - Scoping and aggregation

    func testABotBusyInOneThreadDoesNotMarkAnother() {
        var feed = ActivityFeed()
        feed.apply(update: entry("b", "A", .tool, since: 1))
        feed.apply(update: entry("b", "B", .idle, since: 1))
        XCTAssertEqual(feed.state(bot: "b", thread: "A"), .tool)
        XCTAssertEqual(feed.state(bot: "b", thread: "B"), .idle)
        XCTAssertNil(feed.state(bot: "b", thread: "C"), "a thread the feed never named has no state")
        XCTAssertNil(feed.state(bot: "other", thread: "A"))
        XCTAssertFalse(feed.state(bot: "b", thread: "B")?.animates ?? false)
        XCTAssertNil(feed.busiest(thread: "C"))
        XCTAssertEqual(feed.busiest(thread: "A")?.botId, "b")
    }

    func testBusiestFollowsTheDesktopPrecedenceThenRecency() {
        var feed = ActivityFeed()
        feed.apply(update: entry("b", "1", .failed, since: 9))
        feed.apply(update: entry("b", "2", .typing, since: 1))
        XCTAssertEqual(feed.busiest(bot: "b")?.threadId, "2", "anything live outranks a settled failure")
        feed.apply(update: entry("b", "3", .thinking, since: 1))
        XCTAssertEqual(feed.busiest(bot: "b")?.state, .thinking)
        feed.apply(update: entry("b", "4", .tool, since: 1))
        XCTAssertEqual(feed.busiest(bot: "b")?.state, .tool)
        feed.apply(update: entry("b", "5", .waiting, since: 1))
        XCTAssertEqual(feed.busiest(bot: "b")?.threadId, "5", "a wait on the person wins")
        feed.apply(update: entry("b", "6", .waiting, since: 7))
        XCTAssertEqual(feed.busiest(bot: "b")?.threadId, "6", "the most recent of equals")
        XCTAssertNil(feed.busiest(bot: "unknown"))
    }

    func testBusiestAmongSettledThreadsPrefersTheMoreNotableRest() {
        var feed = ActivityFeed()
        feed.apply(update: entry("b", "1", .idle, since: 9))
        feed.apply(update: entry("b", "2", .stopped, since: 1))
        XCTAssertEqual(feed.busiest(bot: "b")?.state, .stopped)
        feed.apply(update: entry("b", "3", .failed, since: 1))
        XCTAssertEqual(feed.busiest(bot: "b")?.state, .failed)
        XCTAssertFalse(feed.busiest(bot: "b")!.state.animates)
    }

    func testRoomLookupsMatchByRoomOrThread() {
        var feed = ActivityFeed()
        feed.apply(update: entry("b", "t1", .thinking, since: 1, room: "g"))
        feed.apply(update: entry("c", "gt", .tool, since: 1))
        feed.apply(update: entry("b", "t9", .tool, since: 1, room: "elsewhere"))
        XCTAssertEqual(feed.busiest(room: "g")?.botId, "b")
        XCTAssertEqual(feed.busiest(room: "g", thread: "gt")?.botId, "c")
        XCTAssertEqual(feed.busiest(bot: "b", room: "g")?.threadId, "t1")
        XCTAssertNil(feed.busiest(bot: "c", room: "g"))
    }

    // MARK: - Mapping

    func testFeedStatesMapToTheDesktopGestures() {
        XCTAssertEqual(ActivityFeedState.thinking.mascotActivity(), .thinking)
        XCTAssertEqual(ActivityFeedState.typing.mascotActivity(), .thinking, "the answer streaming keeps the thinking gesture")
        XCTAssertEqual(ActivityFeedState.tool.mascotActivity(), .working)
        XCTAssertEqual(ActivityFeedState.tool.mascotActivity(toolName: "Web_Search"), .searching)
        XCTAssertEqual(ActivityFeedState.waiting.mascotActivity(), .waiting)
        for settled: ActivityFeedState in [.idle, .failed, .stopped] {
            XCTAssertEqual(settled.mascotActivity(), .idle)
            XCTAssertFalse(settled.animates)
            XCTAssertNil(MascotActivityChoreography.nextFrameDelayIfMoving(settled.mascotActivity(), elapsed: 0),
                         "\(settled) settles: no frame loop")
        }
        XCTAssertTrue(ActivityFeedState.waiting.animates)
        XCTAssertFalse(ActivityFeedState.waiting.isBusy)
    }

    func testAToolNameFromTheWireCanMakeTheMascotSearch() throws {
        let decoded = try decode(#"{"botId":"b","threadId":"t","state":"tool","since":1,"tool":"search_query"}"#)
        XCTAssertEqual(decoded.mascotActivity, .searching)
    }

    // MARK: - Snapshot route

    private func client() -> (CompanionClient, URLSession) {
        ActivityFeedRequestStub.capturedRequest = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ActivityFeedRequestStub.self]
        let session = URLSession(configuration: configuration)
        return (CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810),
                                token: "paired-token", session: session), session)
    }

    func testFetchesTheSnapshotFromTheActivityRoute() async throws {
        let (client, session) = client()
        defer { session.invalidateAndCancel() }
        ActivityFeedRequestStub.statusCode = 200
        ActivityFeedRequestStub.responseBody = Data(#"{"items":[{"botId":"b","threadId":"t","roomId":null,"state":"tool","since":1791288000003}]}"#.utf8)
        let entries = try await client.activityFeedSnapshot()
        XCTAssertEqual(ActivityFeedRequestStub.capturedRequest?.url?.path, activityFeedSnapshotPath)
        XCTAssertEqual(entries, [entry("b", "t", .tool, since: 1_791_288_000_003)])
    }

    func testAServerWithoutTheFeedReadsAsNoFeed() async throws {
        let (client, session) = client()
        defer { session.invalidateAndCancel() }
        ActivityFeedRequestStub.statusCode = 404
        ActivityFeedRequestStub.responseBody = Data(#"{"error":"not found"}"#.utf8)
        let entries = try await client.activityFeedSnapshot()
        XCTAssertNil(entries)
    }
}
