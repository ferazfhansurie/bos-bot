import XCTest

/// Cloud rooms scroll back past the newest 50, on a migrated copy. The stack
/// is `services/cloud/local.ts` after real-migration/run.mjs;
/// services/cloud/acceptance/ios-paging/expected.mjs writes every room's
/// first thread in sequence order. A long thread opens on its newest 50, pages
/// in older messages (the button, then scrolling up into the top) until the
/// start of the thread, and then shows every message in order. A short
/// thread says it is the start straight away. Skipped unless the runner gets
/// TEST_RUNNER_CLOUD_ISSUER_URL, TEST_RUNNER_CLOUD_ROOMS_URL and
/// TEST_RUNNER_PAGING_EXPECTED.
final class CloudHistoryPagingUITests: XCTestCase {
    private struct Expected: Decodable {
        struct Room: Decodable { var room_id: String; var message_ids: [String] }
        var email: String
        var rooms: [Room]
    }

    private var issuer: URL!
    private var rooms: URL!
    private var expected: Expected!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let i = env["CLOUD_ISSUER_URL"].flatMap(URL.init(string:)),
              let r = env["CLOUD_ROOMS_URL"].flatMap(URL.init(string:)),
              let path = env["PAGING_EXPECTED"]
        else { throw XCTSkip("no migrated cloud fixture") }
        issuer = i; rooms = r
        expected = try JSONDecoder().decode(Expected.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        continueAfterFailure = false
    }

    @MainActor
    func testLongThreadsPageBackToTheStart() async throws {
        let long = expected.rooms.filter { $0.message_ids.count > 50 }.sorted { $0.message_ids.count > $1.message_ids.count }
        let short = try XCTUnwrap(expected.rooms.filter { (2..<50).contains($0.message_ids.count) }.max { $0.message_ids.count < $1.message_ids.count })
        XCTAssertFalse(long.isEmpty, "the copy has a thread longer than one snapshot")
        let app = XCUIApplication()
        app.terminate()
        app.launchEnvironment = ["BOS_CLOUD_ROOMS": "1", "CLOUD_ISSUER_URL": issuer.absoluteString, "CLOUD_ROOMS_URL": rooms.absoluteString]
        app.launch()
        if app.buttons["cloud.signOut"].waitForExistence(timeout: 5) { app.buttons["cloud.signOut"].tap() }
        try await signIn(expected.email, in: app)

        for room in long.prefix(2) {
            let ids = room.message_ids
            try open(room.room_id, in: app)
            // Opens on the snapshot: the newest 50, the oldest of them on top.
            let snapshotFirst = app.descendants(matching: .any)["cloud.message.\(ids[ids.count - 50])"]
            XCTAssertTrue(snapshotFirst.waitForExistence(timeout: 20), problem(app))
            XCTAssertFalse(app.descendants(matching: .any)["cloud.message.\(ids[ids.count - 51])"].exists, "nothing older before paging")
            XCTAssertTrue(app.buttons["cloud.older.load"].waitForExistence(timeout: 5), "a long thread offers earlier messages")
            shot("room \(room.room_id.prefix(8)) newest 50", app)

            // The first page by the button: the reader stays on the message that was on top.
            app.buttons["cloud.older.load"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["cloud.message.\(ids[ids.count - 51])"].waitForExistence(timeout: 15), "the page lands: \(problem(app))")
            XCTAssertTrue(snapshotFirst.isHittable, "the page lands above the reader, who stays put")
            shot("room \(room.room_id.prefix(8)) after one page", app)
            // The rest only by scrolling up into the top. Migrated messages
            // can be a screen tall, so fling.
            var swipes = 0
            for _ in 0..<200 where !app.staticTexts["cloud.older.start"].exists {
                app.swipeDown(velocity: .fast); swipes += 1
                _ = app.staticTexts["cloud.older.start"].waitForExistence(timeout: 1)
            }
            guard app.staticTexts["cloud.older.start"].exists else {
                shot("room \(room.room_id.prefix(8)) stuck", app)
                XCTFail("paged back to the start of the thread: \(problem(app))")
                throw XCTSkip("stuck")
            }
            XCTAssertTrue(app.descendants(matching: .any)["cloud.message.\(ids[0])"].waitForExistence(timeout: 5), "the first message of the thread")
            shot("room \(room.room_id.prefix(8)) start", app)
            let seen = collectInOrder(app, expected: ids)
            XCTAssertEqual(seen, ids, "room \(room.room_id): every message, in order")
            print("IOS_PAGING " + #"{"room":"\#(room.room_id)","expected":\#(ids.count),"shown":\#(seen.count),"swipes":\#(swipes)}"#)
            back(app)
        }

        try open(short.room_id, in: app)
        XCTAssertTrue(app.descendants(matching: .any)["cloud.message.\(short.message_ids[0])"].waitForExistence(timeout: 20), problem(app))
        XCTAssertTrue(app.staticTexts["cloud.older.start"].waitForExistence(timeout: 5), "a short thread is the whole thread")
        XCTAssertFalse(app.buttons["cloud.older.load"].exists)
        print("IOS_PAGING " + #"{"room":"\#(short.room_id)","expected":\#(short.message_ids.count),"start_shown":true}"#)
        shot("room \(short.room_id.prefix(8)) short", app)
        back(app)
    }

    @MainActor
    private func open(_ roomId: String, in app: XCUIApplication) throws {
        let row = app.descendants(matching: .any).matching(identifier: "cloud.room.\(roomId)").firstMatch
        // The migrated workspace lists one row per thread (hundreds); these sit near the end.
        guard reveal(row, in: app) else { XCTFail("room \(roomId) is discovered"); throw XCTSkip("room not found") }
        row.tap()
        XCTAssertTrue(app.textFields["cloud.composer"].waitForExistence(timeout: 15), problem(app))
    }

    @MainActor
    private func back(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons["BackButton"]
        for _ in 0..<3 where back.exists {
            if back.isHittable { back.tap() }
            _ = back.waitForNonExistence(timeout: 3)
        }
        XCTAssertFalse(app.textFields["cloud.composer"].exists, "back on the room list")
    }

    /// The transcript is lazy: walk from the top down to the newest,
    /// keeping each screen's ids in on-screen order. Every screen must agree
    /// with the expected order; the union must be all of it.
    @MainActor
    private func collectInOrder(_ app: XCUIApplication, expected ids: [String]) -> [String] {
        let rank = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0) })
        var seen = Set<String>()
        var stale = 0
        while stale < 8 && seen.count < ids.count {
            let visible = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'cloud.message.'"))
                .allElementsBoundByIndex
                .filter { $0.exists && !$0.frame.isEmpty }
                .sorted { $0.frame.minY < $1.frame.minY }
                .map { String($0.identifier.dropFirst("cloud.message.".count)) }
            let ranks = visible.map { rank[$0] ?? -1 }
            XCTAssertFalse(ranks.contains(-1), "only migrated messages are shown")
            XCTAssertEqual(ranks, ranks.sorted(), "on-screen order matches source order")
            let before = seen.count
            seen.formUnion(visible)
            stale = seen.count == before ? stale + 1 : 0
            app.swipeUp()
        }
        return ids.filter(seen.contains)
    }

    @MainActor
    private func signIn(_ address: String, in app: XCUIApplication) async throws {
        let email = app.textFields["cloud.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        type(address, into: email)
        app.buttons["cloud.sendCode"].tap()
        let codeField = app.textFields["cloud.code"]
        XCTAssertTrue(codeField.waitForExistence(timeout: 15), problem(app))
        let code = try await otp(for: address)
        type(code, into: codeField)
        app.buttons["cloud.verify"].tap()
        XCTAssertTrue(app.staticTexts["cloud.subject"].waitForExistence(timeout: 15), problem(app))
    }

    @MainActor
    private func type(_ text: String, into field: XCUIElement) {
        for _ in 0..<5 {
            field.tap()
            if (field.value(forKey: "hasKeyboardFocus") as? Bool) == true { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        field.typeText(text)
    }

    private func otp(for address: String) async throws -> String {
        var url = URLComponents(url: issuer.appendingPathComponent("__dev/otp"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "email", value: address)]
        struct Body: Decodable { var otp: String }
        for _ in 0..<20 {
            let (data, response) = try await URLSession.shared.data(from: url.url!)
            if (response as? HTTPURLResponse)?.statusCode == 200, let body = try? JSONDecoder().decode(Body.self, from: data) {
                return body.otp
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw XCTSkip("otp sink returned nothing for \(address)")
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        for _ in 0..<3 where !app.staticTexts["cloud.subject"].isHittable { app.swipeDown() }
        for _ in 0..<150 {
            if element.exists, element.isHittable { return true }
            app.swipeUp(velocity: .fast)
        }
        return element.exists && element.isHittable
    }

    @MainActor
    private func problem(_ app: XCUIApplication) -> String {
        let p = app.staticTexts["cloud.problem"]
        return p.exists ? p.label : ""
    }

    @MainActor
    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
