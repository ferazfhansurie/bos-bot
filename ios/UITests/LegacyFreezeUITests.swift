import XCTest

/// G08: an installed app reopened against a computer whose workspace moved
/// to BOS cloud. The computer's legacy server runs on a migrated copy
/// (services/cloud/acceptance/g08/run-native.mjs) and refuses every write
/// with 409 authority_moved. Skipped unless the runner gets
/// TEST_RUNNER_LEGACY_PAIR_URL. The same file runs against the pre-2.0 1.9.x
/// build (LEGACY_EXPECT=raw) and this build (LEGACY_EXPECT=banner).
final class LegacyFreezeUITests: XCTestCase {
    private var pairURL: URL!
    private var chatName = ""
    private var banner = true

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["LEGACY_PAIR_URL"].flatMap(URL.init(string:)), let name = env["LEGACY_CHAT_NAME"]
        else { throw XCTSkip("no frozen legacy fixture") }
        pairURL = url; chatName = name
        banner = env["LEGACY_EXPECT"] != "raw"
        continueAfterFailure = false
    }

    /// Pair, reopen the list and a room's history, try one write: refused,
    /// draft kept, nothing blank. This build also says why, before any write
    /// on the next launch.
    @MainActor
    func testReopenAfterMigrationReadsButRefusesWrites() throws {
        let app = XCUIApplication()
        app.launch()
        app.open(pairURL)
        let connect = app.buttons["Connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 20), "pairing confirmation")
        // The launch splash can still cover the sheet for a few seconds.
        for _ in 0..<10 where connect.exists {
            if connect.isHittable { connect.tap() }
            _ = connect.waitForNonExistence(timeout: 3)
        }
        let notNow = app.buttons["Not now"]
        if notNow.waitForExistence(timeout: 10) { notNow.tap() }

        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", chatName + ",")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the chat list loads from the frozen computer")
        shot("list after migration", app)
        row.tap()

        let composer = app.descendants(matching: .any)["message-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "the room opens")
        XCTAssertTrue(waitForText(in: app, minimum: 4, timeout: 20), "history renders, not a blank room")
        shot("history after migration", app)

        let probe = "g08 frozen write probe"
        composer.tap()
        composer.typeText(probe)
        app.buttons["Send message"].tap()
        let refusal = banner ? "moved to BOS cloud" : "authority_moved"
        let shown = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", refusal)).firstMatch
        XCTAssertTrue(shown.waitForExistence(timeout: 20), "the refused write says so")
        XCTAssertEqual(composer.value as? String, probe, "the draft is kept")
        if banner { XCTAssertTrue(app.descendants(matching: .any)["legacy.archived.banner"].waitForExistence(timeout: 5)) }
        shot("write refused", app)
        print("G08_LEGACY " + #"{"event":"writeRefused","shown":"\#(refusal)"}"#)

        guard banner else { return }
        app.terminate()
        app.launch()
        let moved = app.descendants(matching: .any)["legacy.archived.banner"]
        XCTAssertTrue(moved.waitForExistence(timeout: 20), "moved state shows on reopen, before any write")
        // Past the launch splash, so the shot shows what a person sees.
        let deadline = Date().addingTimeInterval(15)
        while !moved.isHittable && Date() < deadline { Thread.sleep(forTimeInterval: 0.5) }
        XCTAssertTrue(moved.isHittable, "the moved banner is on screen")
        XCTAssertTrue(row.waitForExistence(timeout: 20) || composer.waitForExistence(timeout: 5), "and the chats still load")
        shot("reopened: moved banner", app)
    }

    @MainActor
    private func waitForText(in app: XCUIApplication, minimum: Int, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.staticTexts.count >= minimum { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    @MainActor
    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
