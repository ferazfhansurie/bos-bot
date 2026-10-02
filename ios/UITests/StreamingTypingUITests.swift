import XCTest

/// Types into the composer while the offline preview streams a long run.
/// The app writes main-thread wait times to /tmp/bos-typing-probe.json.
final class StreamingTypingUITests: XCTestCase {
    @MainActor
    func testTypingWhileAReplyStreams() {
        continueAfterFailure = false
        try? FileManager.default.removeItem(atPath: "/tmp/bos-typing-probe.json")
        let app = XCUIApplication()
        app.launchArguments = [
            "-store-preview", "-threads-preview", "-stream-preview", "-open-first",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ]
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        for _ in 0..<4 {
            app.launch()
            if input.waitForExistence(timeout: 12) { break }
            app.terminate()
        }
        XCTAssertTrue(input.exists)
        sleep(3)
        for _ in 0..<5 where (input.value(forKey: "hasKeyboardFocus") as? Bool) != true {
            input.tap()
            sleep(1)
        }
        input.typeText("x")
        sleep(3)
        let started = Date()
        for _ in 0..<6 { input.typeText("the quick brown fox jumps over the lazy dog ") }
        print("TYPING_SECONDS \(Date().timeIntervalSince(started))")
        sleep(1)
    }
}
