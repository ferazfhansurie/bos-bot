import XCTest

/// G08: after cutover this build reads the migrated rooms from the room
/// service with the same messages in the same order. The stack is
/// `services/cloud/local.ts`; services/cloud/acceptance/g08/readback.mjs
/// writes what each room's first discovered thread must show (the snapshot,
/// newest 50, in sequence order). Skipped unless the runner gets
/// TEST_RUNNER_CLOUD_ISSUER_URL, TEST_RUNNER_CLOUD_ROOMS_URL and
/// TEST_RUNNER_G08_EXPECTED.
final class G08MigratedRoomsUITests: XCTestCase {
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
              let path = env["G08_EXPECTED"]
        else { throw XCTSkip("no migrated cloud fixture") }
        issuer = i; rooms = r
        expected = try JSONDecoder().decode(Expected.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        continueAfterFailure = false
    }

    @MainActor
    func testMigratedRoomsShowSourceMessagesInOrder() async throws {
        let app = XCUIApplication()
        app.terminate()
        app.launchEnvironment = ["BOS_CLOUD_ROOMS": "1", "CLOUD_ISSUER_URL": issuer.absoluteString, "CLOUD_ROOMS_URL": rooms.absoluteString]
        app.launch()
        if app.buttons["cloud.signOut"].waitForExistence(timeout: 5) { app.buttons["cloud.signOut"].tap() }
        try await signIn(expected.email, in: app)
        shot("signed in after cutover", app)

        for room in expected.rooms {
            // A room with several threads lists one row per thread under the
            // same identifier; the first is the room's first discovered thread.
            let row = app.descendants(matching: .any).matching(identifier: "cloud.room.\(room.room_id)").firstMatch
            XCTAssertTrue(reveal(row, in: app), "migrated room \(room.room_id) is discovered")
            row.tap()
            XCTAssertTrue(app.textFields["cloud.composer"].waitForExistence(timeout: 15), problem(app))
            // The room opens at the top of what it loaded: the oldest of the snapshot.
            let first = app.descendants(matching: .any)["cloud.message.\(room.message_ids.first!)"]
            XCTAssertTrue(first.waitForExistence(timeout: 20), "oldest loaded migrated message renders first: \(problem(app))")
            let seen = collectInOrder(app, expected: room.message_ids)
            XCTAssertEqual(seen, room.message_ids, "room \(room.room_id): same messages, same order")
            print("G08_NATIVE " + #"{"room":"\#(room.room_id)","expected":\#(room.message_ids.count),"shown":\#(seen.count)}"#)
            shot("room \(room.room_id.prefix(8))", app)
            let back = app.navigationBars.buttons["BackButton"]
            for _ in 0..<3 where back.exists {
                if back.isHittable { back.tap() }
                _ = back.waitForNonExistence(timeout: 3)
            }
            XCTAssertFalse(app.textFields["cloud.composer"].exists, "back on the room list")
        }
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
        for _ in 0..<8 {
            if element.waitForExistence(timeout: 2), element.isHittable { return true }
            app.swipeUp()
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
