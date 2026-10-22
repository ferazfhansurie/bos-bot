import XCTest

final class PhoneCompatibilityUITests: XCTestCase {
    @MainActor
    func testRequiredUpgradeShowsBeforeChatsOrDecodeErrors() {
        let app = XCUIApplication()
        app.launchArguments = ["-phone-update-preview", "-companion.onboarding.introSeen", "YES"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Update the app"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["phone-update-link"].exists)
        XCTAssertTrue(app.staticTexts["This server needs BOS 99.0.0 or later on your phone."].exists)
        XCTAssertFalse(app.staticTexts["The computer sent something this app couldn't read."].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Phone version compatibility gate"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
