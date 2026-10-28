import XCTest

/// A pinned bot is mostly face, and a row's face is the first thing a thumb
/// lands on: tapping either must open the chat, not just make the face hop.
final class PinnedTapUITests: XCTestCase {
    @MainActor func testTappingPinnedFaceAndRowFaceOpensTheChat() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-companion.prefs.islandIntro", "never",
                               "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let row = app.buttons["bot-chat.preview-pepper"]
        let pinned = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pepper, pinned chat")).firstMatch
        if row.waitForExistence(timeout: 15) {
            // the face sits at the row's leading edge
            row.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 48, dy: 0)).tap()
            XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 5), "tapping a row's face did not open the chat")
            app.buttons["Back"].tap()
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            row.press(forDuration: 0.8)
            XCTAssertTrue(app.buttons["Pin chat"].waitForExistence(timeout: 5))
            app.buttons["Pin chat"].tap()
        }
        XCTAssertTrue(pinned.waitForExistence(timeout: 5))
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Pinned"; shot.lifetime = .keepAlways; add(shot)
        pinned.tap()
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 5), "tapping a pinned bot did not open the chat")
        app.buttons["Back"].tap()
        XCTAssertTrue(pinned.waitForExistence(timeout: 5))
        pinned.press(forDuration: 0.8)
        app.buttons["Unpin chat"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
    }
}
