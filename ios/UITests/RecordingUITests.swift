import XCTest

final class RecordingUITests: XCTestCase {
    @MainActor
    func testMeetingSurvivesBackgroundAndAudioSurvivesTermination() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-open-first", "-recording-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["Start dictation"].waitForExistence(timeout: 15))
        app.buttons["Start dictation"].press(forDuration: 0.6)
        XCTAssertTrue(app.staticTexts["Voice draft"].waitForExistence(timeout: 5))
        let meeting = app.buttons["Meeting mode"]
        meeting.tap()
        XCTAssertEqual(meeting.value as? String, "1")
        XCTAssertTrue(app.staticTexts["Meeting recording"].exists)
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Take your time. The meeting starts slowly."].waitForExistence(timeout: 5))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["More"].waitForExistence(timeout: 10))
        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Saved recordings")).firstMatch.waitForExistence(timeout: 5))
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Saved recordings")).firstMatch.tap()
        XCTAssertTrue(app.buttons["Play audio"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["Play audio"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["recording-playback-status"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testLockedRecordingSavesTranscriptAndPlayableAudio() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-open-first", "-recording-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let mic = app.buttons["Start dictation"]
        XCTAssertTrue(mic.waitForExistence(timeout: 15))
        mic.press(forDuration: 0.6)
        XCTAssertTrue(app.staticTexts["Voice draft"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Take your time. The meeting starts slowly."].waitForExistence(timeout: 8))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Locked recording with live transcript"
        capture.lifetime = .keepAlways
        add(capture)
        app.buttons["recording-pause"].tap()
        XCTAssertTrue(app.staticTexts["Saved on this iPhone"].waitForExistence(timeout: 5))
        app.buttons["Recordings"].tap()
        XCTAssertTrue(app.buttons["Play audio"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["Play audio"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["recording-playback-status"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Couldn't play this recording."].exists)
        XCTAssertTrue(app.buttons["Share transcript"].firstMatch.exists)
        XCTAssertTrue(app.buttons["Share audio"].firstMatch.exists)
        app.buttons["Done"].firstMatch.tap()
        app.buttons["Done"].firstMatch.tap()
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertTrue((input.value as? String)?.contains("The meeting starts slowly.") == true)
    }
}
