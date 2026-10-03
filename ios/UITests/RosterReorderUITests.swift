import XCTest

/// A chat list that reorders under the finger must still open the chat
/// that was tapped. `-reorder-mid-tap` posts to the bottom chat 100ms after
/// the finger lands, which jumps it to the top and moves every row above it
/// down one, while the finger is still down.
/// `TEST_RUNNER_ORDER_LIVE=1` turns the hold off, to show the test fails
/// without it.
final class RosterReorderUITests: XCTestCase {
    @MainActor
    func testTapOpensTheChatUnderTheFingerWhenTheListReordersMidTap() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "-store-preview", "-room-preview", "-reorder-mid-tap",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ]
        if ProcessInfo.processInfo.environment["ORDER_LIVE"] == "1" { app.launchArguments.append("-roster-order-live") }
        // Rows combine their text into one label: "oracle avatar, oracle, …".
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "oracle ")).firstMatch
        for _ in 0..<4 {
            app.launch()
            if row.waitForExistence(timeout: 12) { break }
            app.terminate()
        }
        XCTAssertTrue(row.exists)
        sleep(2)
        let before = row.frame
        // A held press, under the context menu's threshold, so the reorder lands while the finger is down.
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.3)

        let header = app.buttons.matching(identifier: "chat-options").firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 10), "no chat opened")
        XCTAssertTrue(header.label.hasPrefix("oracle,"), "opened \(header.label) instead of oracle")

        // The reorder did happen: back on the list, oracle has moved down.
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        sleep(3)
        XCTAssertGreaterThan(row.frame.minY, before.minY + 20, "the list never reordered, so the test proved nothing")
    }
}
