import XCTest

final class HoldThreadPickerUITests: XCTestCase {
    @MainActor func testHoldBotChoosesExactThreadWithoutChangingHomeLayout() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let row = app.buttons["bot-chat.preview-pepper"]
        let pinned = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pepper, pinned chat")).firstMatch
        let bot = row.waitForExistence(timeout: 5) ? row : pinned
        XCTAssertTrue(bot.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["roster-sort-show"].exists)
        XCTAssertFalse(app.segmentedControls["conversation-status-filter"].exists)
        bot.press(forDuration: 0.8)
        let thread = app.buttons["hold-thread.preview-icloud"]
        XCTAssertTrue(thread.waitForExistence(timeout: 5))
        if app.buttons["Pin chat"].exists {
            app.buttons["Pin chat"].tap()
            XCTAssertTrue(pinned.waitForExistence(timeout: 5))
            pinned.press(forDuration: 0.8)
            XCTAssertTrue(thread.waitForExistence(timeout: 5))
        }
        let menu = XCTAttachment(screenshot: app.screenshot()); menu.lifetime = .keepAlways; add(menu)
        thread.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I am reviewing iCloud here")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["thread-switcher"].exists)
        app.buttons["Back"].tap()
        XCTAssertTrue(pinned.waitForExistence(timeout: 5))
        pinned.press(forDuration: 0.8)
        app.buttons["Unpin chat"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
    }
    @MainActor func testGlassSettingsInDarkAppearance() { checkSettings(appearance: "dark") }
    @MainActor func testGlassSettingsInLightAppearance() { checkSettings(appearance: "light") }

    @MainActor private func checkSettings(appearance: String) {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-companion.prefs.appearance", appearance,
                               "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES",
                               "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let profile = app.buttons["Your profile and settings"]
        XCTAssertTrue(profile.waitForExistence(timeout: 15))
        let home = XCTAttachment(screenshot: app.screenshot()); home.name = "Home - " + appearance; home.lifetime = .keepAlways; add(home)
        profile.tap()
        let settings = app.buttons["Settings & computers"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Settings - " + appearance; screenshot.lifetime = .keepAlways; add(screenshot)
    }

}
