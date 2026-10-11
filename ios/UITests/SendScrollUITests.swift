import XCTest
final class SendScrollUITests: XCTestCase {
    @MainActor func testSendingInLongHistoryKeepsMessageAboveKeyboard() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-stream-preview", "-stream-preview-history", "300", "-send-scroll-preview", "-open-first", "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 12))
        input.tap()
        input.typeText("keep this message visible")
        app.buttons["Send message"].tap()
        let message = app.staticTexts["keep this message visible"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 4))
        for _ in 0..<5 {
            XCTAssertTrue(message.isHittable, "sent message scrolled into blank space")
            XCTAssertLessThan(message.frame.maxY, app.keyboards.firstMatch.frame.minY)
            Thread.sleep(forTimeInterval: 0.2)
        }
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }
}
