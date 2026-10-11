import XCTest

/// Real native rows with synthetic receipts; no pairing or provider account.
final class SteeringDeliveryUITests: XCTestCase {
    @MainActor
    func testDeliveryLabelsDistinguishClaudeCodexAndUncertainInput() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-steering-preview", "-open-first",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let chat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Pepper,", "Personal assistant")).firstMatch
        if chat.waitForExistence(timeout: 3) { chat.tap() }
        for (index, label) in ["Sent during reply", "Accepted during reply", "Delivery uncertain · check before resending"].enumerated() {
            let status = app.staticTexts["steer-delivery-preview-steer-\(index)"]
            XCTAssertTrue(status.waitForExistence(timeout: 5))
            XCTAssertEqual(status.label, label)
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Claude transport, Codex acknowledgement, uncertain delivery"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    func testRefusedSteerExplainsTheOutcomeAndKeepsQueuedCorrection() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-steering-preview-refusal",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let chat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Pepper,", "Personal assistant")).firstMatch
        if chat.waitForExistence(timeout: 3) { chat.tap() }
        let steer = app.buttons["Steer queued message now"]
        XCTAssertTrue(steer.waitForExistence(timeout: 5))
        steer.tap()
        let explanation = app.staticTexts["This message is queued for the next reply; the running turn did not accept it."]
        XCTAssertTrue(explanation.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Refused steer explains queued outcome"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Keep this queued correction"].exists)
        XCTAssertTrue(steer.exists)
    }
}
