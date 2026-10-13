import XCTest

final class ChatAddMenuUITests: XCTestCase {
    @MainActor
    func testComputerPreviewStopsWaitingAndOffersBrowser() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-open-first",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
                               "-companion.prefs.islandIntro", "never",
                               "-companion.onboarding.welcomeSeen", "YES",
                               "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["chat-options"].waitForExistence(timeout: 15))
        app.buttons["chat-options"].tap()
        app.buttons["Watch computer"].tap()
        XCTAssertTrue(app.staticTexts["Waiting for screen activity…"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["preview-open-browser"].exists)
        XCTAssertTrue(app.staticTexts["No screen activity yet"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["Waiting for screen activity…"].exists)
        XCTAssertEqual(app.progressIndicators.count, 0)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "preview without screen activity"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["preview-open-browser"].tap()
        XCTAssertTrue(app.buttons["Reconnect browser"].waitForExistence(timeout: 10))
    }

    @MainActor
    func testCompactAddMenuAndHeaderActions() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-open-first", "-open-plus",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
                               "-companion.prefs.islandIntro", "never",
                               "-companion.onboarding.welcomeSeen", "YES",
                               "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["chat-add-photos"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["chat-add-files"].exists)
        XCTAssertTrue(app.buttons["chat-add-audio"].exists)
        let additions = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-add-"))
        XCTAssertEqual(additions.count, 3)
        let menu = app.otherElements["chat-add-menu"]
        XCTAssertLessThan(menu.frame.height, 240, "additions should fit in a compact card")
        XCTAssertGreaterThan(menu.frame.minY, 50)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "compact additions"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["chat-add-audio"].tap()
        XCTAssertTrue(app.buttons["Record audio"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Saved recordings"].exists)
        // Dismiss the native submenu without starting the microphone.
        app.tapCoordinateOutsideMenu()
        app.buttons["Close"].firstMatch.tap()
        app.buttons["chat-options"].tap()
        XCTAssertTrue(app.buttons["Threads"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Watch computer"].exists)
        XCTAssertTrue(app.buttons["Conversation settings"].exists)
        XCTAssertTrue(app.buttons["Share chat"].exists)
        XCTAssertFalse(app.buttons["Share transcript"].exists)
        app.buttons["Share chat"].tap()
        XCTAssertTrue(app.buttons["Share transcript"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Export JSON"].exists)
    }
}

private extension XCUIApplication {
    @MainActor func tapCoordinateOutsideMenu() {
        coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.25)).tap()
    }
}
