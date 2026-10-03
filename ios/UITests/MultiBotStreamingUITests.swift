import XCTest

/// Four bots stream at once (two in the HQ room, two in 1:1s) while the
/// person types, scrolls and switches chats. The app writes main-thread
/// wait times to /tmp/bos-typing-probe.json; each test keeps a copy as
/// /tmp/bos-probe-<scenario>.json.
final class MultiBotStreamingUITests: XCTestCase {
    private func launch(opening chat: String) -> XCUIApplication {
        continueAfterFailure = false
        try? FileManager.default.removeItem(atPath: "/tmp/bos-typing-probe.json")
        let app = XCUIApplication()
        app.launchArguments = [
            "-store-preview", "-room-preview", "-stream-preview", "-stream-preview-bots", "-probe-always",
            "-open-chat", chat,
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
        return app
    }

    private func keep(_ scenario: String, started: Date) {
        sleep(1)
        print("SCENARIO_SECONDS \(scenario) \(Date().timeIntervalSince(started))")
        let copy = "/tmp/bos-probe-\(scenario).json"
        try? FileManager.default.removeItem(atPath: copy)
        try? FileManager.default.copyItem(atPath: "/tmp/bos-typing-probe.json", toPath: copy)
    }

    @MainActor
    func testTypingInARoomWhileFourBotsStream() {
        let app = launch(opening: "room-hq")
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        for _ in 0..<5 where (input.value(forKey: "hasKeyboardFocus") as? Bool) != true {
            input.tap()
            sleep(1)
        }
        let started = Date()
        for _ in 0..<6 { input.typeText("the quick brown fox jumps over the lazy dog ") }
        keep("typing", started: started)
    }

    @MainActor
    func testScrollingARoomWhileFourBotsStream() {
        let app = launch(opening: "room-hq")
        let started = Date()
        for _ in 0..<4 {
            app.swipeDown(velocity: .fast)
            app.swipeDown(velocity: .fast)
            app.swipeUp(velocity: .fast)
            app.swipeUp(velocity: .fast)
        }
        keep("scrolling", started: started)
    }

    @MainActor
    func testSwitchingChatsWhileFourBotsStream() {
        let app = launch(opening: "room-hq")
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        let started = Date()
        let list = app.buttons["Your profile and settings"].firstMatch
        let header = app.buttons.matching(identifier: "chat-options").firstMatch
        var misses = 0
        for name in ["bos", "oracle", "HQ", "bos", "oracle", "HQ"] {
            let back = Date()
            // A tap on a row that moved can push a second chat; back out of all of them.
            for _ in 0..<4 where !list.exists {
                app.buttons["Back"].firstMatch.tap()
                _ = list.waitForExistence(timeout: 10)
            }
            XCTAssertTrue(list.exists)
            print("SWITCH_SECONDS back \(Date().timeIntervalSince(back))")
            // Rows combine their text into one label: "bos avatar, bos, …".
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name + " ")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 20))
            let tapped = Date()
            row.tap()
            XCTAssertTrue(input.waitForExistence(timeout: 20))
            print("SWITCH_SECONDS \(name) \(Date().timeIntervalSince(tapped))")
            // Rows reorder as bots post; count taps that opened another chat.
            if !header.label.hasPrefix(name + ",") { misses += 1 }
            sleep(1)
        }
        print("SWITCH_MISSES \(misses)")
        keep("switching", started: started)
    }
}
