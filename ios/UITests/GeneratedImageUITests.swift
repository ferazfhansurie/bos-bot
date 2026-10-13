import XCTest

final class GeneratedImageUITests: XCTestCase {
    @MainActor
    func testAgentImageLoadsAndOpensFullScreen() {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-images-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let chat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pepper,")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        chat.tap()
        let image = app.buttons["Image: screenshot.png"]
        let appeared = image.waitForExistence(timeout: 5)
        record("Agent image in transcript", app)
        XCTAssertTrue(appeared)
        guard appeared else { return }
        XCTAssertEqual(app.buttons.matching(identifier: "Image: screenshot.png").count, 1,
                       "A generated image repeated in a transport tag must appear only once")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "<attached-image")).firstMatch.exists)
        let loaded = NSPredicate(format: "enabled == true AND value == %@", "Loaded")
        expectation(for: loaded, evaluatedWith: image)
        waitForExpectations(timeout: 10)
        image.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["Image canvas"].waitForExistence(timeout: 10))
        record("Agent image full screen", app)
        app.buttons["Done"].tap()
        XCTAssertTrue(image.waitForExistence(timeout: 5))
        let file = app.buttons["File: notes.txt"]
        XCTAssertTrue(file.exists)
        if !file.isHittable { app.swipeUp() }
        file.tap()
        XCTAssertTrue(app.staticTexts["These are the delivered notes."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Share notes.txt"].exists)
        record("Bot document opened inside BOS", app)
        app.buttons["Done"].tap()
        // The fixture's earlier covers reply collapses too; this is the last one.
        let expanders = app.buttons.matching(identifier: "Expand bot reply")
        if expanders.count > 0 { expanders.element(boundBy: expanders.count - 1).tap() }
        XCTAssertTrue(app.buttons["Copy code"].waitForExistence(timeout: 3))
        record("Formatted reply in the existing bubble", app)
    }

    @MainActor
    func testMarkdownImagesInABotReplyShowAsImagesWhileCollapsed() {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-images-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let chat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pepper,")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        chat.tap()
        let cover = app.buttons["Image: cover-a.png"]
        for _ in 0..<4 where !(cover.exists && cover.isHittable) { app.swipeDown() }
        XCTAssertTrue(cover.waitForExistence(timeout: 5))
        let loaded = NSPredicate(format: "enabled == true AND value == %@", "Loaded")
        expectation(for: loaded, evaluatedWith: cover)
        expectation(for: loaded, evaluatedWith: app.buttons["Image: cover-b.png"])
        waitForExpectations(timeout: 10)
        XCTAssertEqual(app.buttons.matching(identifier: "Image: cover-a.png").count, 1)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "![")).firstMatch.exists,
                       "An embedded local image must not stay in the prose as Markdown")
        record("Markdown images in a collapsed bot reply", app)
    }

    @MainActor
    private func record(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
