import XCTest

/// Native conversation interactions using only bundled, authenticated fixture media.
final class ChatGPTConversationUITests: XCTestCase {
    @MainActor
    private func launch(_ row: String, style: String) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-chatgpt-preview", "-open-chat", "preview-bos",
            "-scroll-to", row, "-companion.prefs.appearance", style.lowercased(),
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        return app
    }

    @MainActor
    private func record(_ name: String, _ app: XCUIApplication) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    func testWorkedTurnAndChangesInBothThemes() {
        for style in ["Dark", "Light"] {
            let app = launch("worked.a1", style: style)
            let worked = app.buttons["worked-a1"]
            XCTAssertTrue(worked.waitForExistence(timeout: 10))
            expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: worked)
            waitForExpectations(timeout: 8)
            XCTAssertFalse(app.staticTexts["Looking at the auth flow first."].exists)
            record("worked-closed-" + style, app)
            worked.tap()
            XCTAssertTrue(app.staticTexts["Looking at the auth flow first."].waitForExistence(timeout: 5))
            record("worked-expanded-" + style, app)
            worked.tap()
            let copy = app.buttons["Copy code"]
            for _ in 0..<5 where !copy.isHittable { app.swipeUp() }
            XCTAssertTrue(copy.isHittable)
            copy.tap()
            record("code-table-" + style, app)
            let changes = app.buttons["View changes"]
            for _ in 0..<5 where !changes.isHittable { app.swipeUp() }
            XCTAssertTrue(changes.isHittable)
            record("edited-files-" + style, app)
            changes.tap()
            XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
            record("change-details-" + style, app)
            app.terminate()
        }
    }

    @MainActor
    func testGalleryPagesAndClosesInBothThemes() {
        for style in ["Dark", "Light"] {
            let app = launch("a3", style: style)
            let image = app.buttons["Image 1: var-a.jpg"]
            XCTAssertTrue(image.waitForExistence(timeout: 10))
            for _ in 0..<3 where !image.isHittable { app.swipeUp() }
            XCTAssertTrue(image.isHittable)
            record("gallery-" + style, app)
            image.tap()
            XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.staticTexts["1 of 3"].exists)
            app.swipeLeft()
            XCTAssertTrue(app.staticTexts["2 of 3"].waitForExistence(timeout: 5))
            record("lightbox-page-two-" + style, app)
            app.buttons["Close"].tap()
            XCTAssertTrue(image.waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    @MainActor
    func testVideoAudioAndDocumentsInBothThemes() {
        for style in ["Dark", "Light"] {
            let app = launch("a4", style: style)
            let video = app.buttons["Video: login-fix-demo.mp4"]
            XCTAssertTrue(video.waitForExistence(timeout: 10))
            for _ in 0..<3 where !video.isHittable { app.swipeUp() }
            expectation(for: NSPredicate(format: "value == %@", "Loaded"), evaluatedWith: video)
            waitForExpectations(timeout: 10)
            video.tap()
            XCTAssertTrue(app.buttons["Close video player"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["Close video player"].exists)
            record("video-player-" + style, app)
            app.buttons["Close video player"].tap()
            let play = app.buttons["Play walkthrough.m4a"]
            for _ in 0..<3 where !play.isHittable { app.swipeUp() }
            XCTAssertTrue(play.isHittable)
            play.tap()
            let pause = app.buttons["Pause walkthrough.m4a"]
            XCTAssertTrue(pause.waitForExistence(timeout: 10))
            record("audio-playing-" + style, app)
            pause.tap()
            XCTAssertTrue(play.waitForExistence(timeout: 5))
            let pdf = app.buttons["PDF: login-fix-report.pdf"]
            for _ in 0..<5 where !pdf.isHittable { app.swipeUp() }
            XCTAssertTrue(pdf.isHittable)
            XCTAssertTrue(app.buttons["Document: release-notes.docx"].exists)
            XCTAssertTrue(app.buttons["Spreadsheet: test-results.xlsx"].exists)
            record("documents-" + style, app)
            pdf.tap()
            XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "System document rendering")], timeout: 5)
            record("pdf-preview-" + style, app)
            app.buttons["Done"].tap()
            for (label, name) in [("Document: release-notes.docx", "docx"), ("Spreadsheet: test-results.xlsx", "xlsx")] {
                let file = app.buttons[label]
                XCTAssertTrue(file.isHittable)
                file.tap()
                XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
                _ = XCTWaiter.wait(for: [XCTestExpectation(description: "System document rendering")], timeout: 5)
                record(name + "-preview-" + style, app)
                app.buttons["Done"].tap()
            }
            app.terminate()
        }
    }
}
