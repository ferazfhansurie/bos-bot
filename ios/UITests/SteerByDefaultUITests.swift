import XCTest

/// bos bot 3.0 steer by default: while a bot works, Send folds the words into
/// the running turn and the island says "got it"; "After this" queues them
/// instead. Runs against an isolated control-omb fixture driven by a host
/// script; skipped unless the runner gets TEST_RUNNER_STEER_PAIR_URL. The
/// host and this test meet through flag files in $STEER_DIR (default
/// /tmp/steerdef/ios): this test writes `paired`, `steered` and `queued`; the
/// host writes `busy` (and `bot`, the bot's name) and `finished`.
final class SteerByDefaultUITests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var pairURL: URL!
    private var dir = URL(fileURLWithPath: "/tmp/steerdef/ios")
    private var shots = URL(fileURLWithPath: "/tmp/steerdef/ios/shots")

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["STEER_PAIR_URL"].flatMap(URL.init(string:)) else { throw XCTSkip("no steer fixture") }
        pairURL = url
        if let path = env["STEER_DIR"] { dir = URL(fileURLWithPath: path) }
        shots = dir.appendingPathComponent("shots")
        continueAfterFailure = false
    }

    @MainActor
    func testSendSteersAndAfterThisQueues() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion.onboarding.introSeen", "YES",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES",
            "-companion.prefs.islandIntro", "never"]
        app.launch()
        app.open(pairURL)
        let connect = app.buttons["Connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 30), "pairing confirmation")
        for _ in 0..<10 where connect.exists {
            if connect.isHittable { connect.tap() }
            _ = connect.waitForNonExistence(timeout: 3)
        }
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
        flag("paired")

        // the host starts a long turn on the Mac
        XCTAssertTrue(waitForFlag("busy", timeout: 90), "the bot is working")
        let name = (try? String(contentsOf: dir.appendingPathComponent("bot"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "BOS"
        let island = app.descendants(matching: .any)["v3-island"]
        if !island.waitForExistence(timeout: 4) {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 15), "the bot's chat")
            row.tap()
        }
        XCTAssertTrue(island.waitForExistence(timeout: 20), "the island while it works")
        sleep(2)
        shot("01-working")

        // Send, the default: the words go into the running turn
        open(island, in: app)
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        input.typeText("make it short, 5 bullets")
        XCTAssertTrue(app.buttons["send-priority-steer"].isSelected, "Send is the default while it works")
        shot("02-typed")
        app.buttons["Send message"].tap()
        flag("sent")
        var labels: [String] = []
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline, !(labels.last ?? "").hasSuffix("got it") {
            labels.append(island.exists ? island.label : "<no island>")
        }
        XCTAssertTrue((labels.last ?? "").hasSuffix("got it"), "the island says got it; saw \(Array(Set(labels)))")
        Thread.sleep(forTimeInterval: 0.4) // past the crossfade, inside the 1.6s hold
        shot("03-got-it")
        flag("steered")

        // After this: the words wait in the queue for the next turn
        sleep(2)
        XCTAssertFalse(island.label.hasSuffix("got it"), "the ack lets go")
        open(island, in: app)
        input.typeText("then email it to the team")
        app.buttons["send-priority-queue"].tap()
        app.buttons["Send message"].tap()
        let chip = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Steer queued message now", "Send this into")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 8), "the queued chip")
        sleep(1)
        XCTAssertFalse(island.label.hasSuffix("got it"), "a queued send is not a steer")
        shot("04-queued")
        flag("queued")

        XCTAssertTrue(waitForFlag("finished", timeout: 90), "the turn finished on the Mac")
        sleep(3)
        shot("05-finished")
    }

    /// Opens the composer from the island, unless it is already open.
    private func open(_ island: XCUIElement, in app: XCUIApplication) {
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        if !input.isHittable { island.tap() }
        XCTAssertTrue(input.waitForExistence(timeout: 5), "the composer")
        input.tap()
    }

    private func flag(_ name: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dir.appendingPathComponent(name).path, contents: Data())
    }

    private func waitForFlag(_ name: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    private func shot(_ name: String) {
        try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? png.write(to: shots.appendingPathComponent("\(name).png"))
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
