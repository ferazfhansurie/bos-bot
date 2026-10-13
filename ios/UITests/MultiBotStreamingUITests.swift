import XCTest

/// Four bots stream at once (two in the HQ room, two in 1:1s) while the
/// person types, scrolls and switches chats. The app writes main-thread
/// wait times to /tmp/bos-typing-probe.json; each test keeps a copy as
/// /tmp/bos-probe-<scenario>.json, and every sample in -raw.json.
/// `TEST_RUNNER_BOT_COUNT=3` on xcodebuild streams three bots instead.
final class MultiBotStreamingUITests: XCTestCase {
    private func launch(opening chat: String) -> XCUIApplication {
        continueAfterFailure = false
        try? FileManager.default.removeItem(atPath: "/tmp/bos-typing-probe.json")
        try? FileManager.default.removeItem(atPath: "/tmp/bos-typing-probe-raw.json")
        let app = XCUIApplication()
        let bots = ProcessInfo.processInfo.environment["BOT_COUNT"] ?? "4"
        app.launchArguments = [
            "-store-preview", "-room-preview", "-stream-preview", "-stream-preview-bots", "-probe-always",
            "-stream-preview-bot-count", bots,
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
        // epoch bounds, to cut the raw samples to the scenario itself
        print("SCENARIO_WINDOW \(scenario) \(started.timeIntervalSince1970) \(Date().timeIntervalSince1970 - 1)")
        let copy = "/tmp/bos-probe-\(scenario).json"
        try? FileManager.default.removeItem(atPath: copy)
        try? FileManager.default.copyItem(atPath: "/tmp/bos-typing-probe.json", toPath: copy)
        let raw = "/tmp/bos-probe-\(scenario)-raw.json"
        try? FileManager.default.removeItem(atPath: raw)
        try? FileManager.default.copyItem(atPath: "/tmp/bos-typing-probe-raw.json", toPath: raw)
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
        XCTAssertEqual(input.value as? String, String(repeating: "the quick brown fox jumps over the lazy dog ", count: 6),
                       "parallel work must not lose or duplicate keystrokes")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
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
            let rowLabel = row.label
            print("SWITCH_RESOLVED \(name) \(Date().timeIntervalSince1970) \(row.frame.minY)")
            let tapped = Date()
            row.tap()
            print("SWITCH_TAPPED \(name) \(Date().timeIntervalSince1970)")
            // A chat that has not opened in 30s is reported, not fatal, so
            // the run still measures the rest.
            let opened = input.waitForExistence(timeout: 30)
            print("SWITCH_SECONDS \(name) \(Date().timeIntervalSince(tapped))\(opened ? "" : " TIMEOUT")")
            // Rows reorder as bots post; count taps that opened another chat.
            // The header is read as the input appears and again a second
            // later, so a header still on its way in is told apart from a
            // tap that really opened the wrong chat.
            let first = header.exists ? header.label : "<none>"
            sleep(1)
            let settled = header.exists ? header.label : "<none>"
            let depth = app.buttons.matching(identifier: "chat-options").count
            if !settled.hasPrefix(name + ",") { misses += 1 }
            print("SWITCH_TAP intended=\(name) row=\"\(rowLabel.prefix(24))\" first=\"\(first)\" settled=\"\(settled)\" headers=\(depth) \(settled.hasPrefix(name + ",") ? "ok" : "MISS")")
        }
        print("SWITCH_MISSES \(misses)")
        keep("switching", started: started)
    }
}
