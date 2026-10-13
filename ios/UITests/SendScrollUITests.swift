import XCTest
final class SendScrollUITests: XCTestCase {
    @MainActor func testSendingInLongHistoryKeepsMessageAboveKeyboard() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-stream-preview", "-stream-preview-history", "300", "-send-scroll-preview", "-mention-draft", "", "-open-first", "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
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
        XCTAssertTrue(app.keyboards.firstMatch.exists, "sending must keep the keyboard ready")
        input.typeText("next message")
        XCTAssertEqual(input.value as? String, "next message", "the next draft keeps focus after sending")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }
    @MainActor func testTypingWhileReadingOlderMessagesDoesNotJumpToBottom() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-stream-preview", "-stream-preview-autostart", "-stream-preview-history", "300", "-send-scroll-preview", "-mention-draft", "", "-open-first", "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 12))
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        for _ in 0..<3 { top.press(forDuration: 0.05, thenDragTo: bottom) }
        let jump = app.buttons["jump-to-latest"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("checking an earlier message")
        XCTAssertEqual(input.value as? String, "checking an earlier message")
        XCTAssertTrue(jump.exists, "typing must preserve the older reading position")
        jump.tap()
        XCTAssertTrue(jump.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.exists, "jump to latest must preserve keyboard focus")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }

}
