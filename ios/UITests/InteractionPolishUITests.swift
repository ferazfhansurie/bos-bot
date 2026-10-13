import XCTest

final class InteractionPolishUITests: XCTestCase {
    @MainActor
    func testCurrentThreadMenuSwitchesWithoutShowingPreviousMessages() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-threads-preview", "-open-chat", "preview-pepper",
            "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["chat-options"].waitForExistence(timeout: 10))
        app.buttons["chat-options"].tap()
        app.buttons["Threads"].tap()
        let thread = app.buttons["thread-preview-icloud"]
        XCTAssertTrue(thread.waitForExistence(timeout: 5))
        thread.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "I am reviewing iCloud here")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "I’m reviewing Gmail here")).firstMatch.exists)
    }

    @MainActor
    func testSlowNewThreadImmediatelyReplacesOldConversationAndKeepsComposerDisabled() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-open-chat", "preview-pepper",
            "-new-thread-delay", "8", "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.terminate()
        app.launch()
        let create = app.buttons["New thread with Pepper"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.tap()
        let skeleton = app.descendants(matching: .any)["conversation-skeleton"]
        XCTAssertTrue(skeleton.waitForExistence(timeout: 1), "Feedback must appear before the deliberately slow response.")
        let input = app.descendants(matching: .any)["message-input"]
        XCTAssertTrue(!input.exists || !input.isEnabled)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "I’m reviewing Gmail here")).firstMatch.exists)
        let pendingImage = XCTAttachment(screenshot: app.screenshot())
        pendingImage.name = "New thread pending with old content hidden"; pendingImage.lifetime = .keepAlways; add(pendingImage)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Thinking")).firstMatch.exists)
        let ready = NSPredicate(format: "exists == false")
        expectation(for: ready, evaluatedWith: skeleton)
        waitForExpectations(timeout: 15)
        XCTAssertTrue(app.descendants(matching: .any)["message-input"].isEnabled)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Created thread after delayed response"; image.lifetime = .keepAlways; add(image)
    }
}
