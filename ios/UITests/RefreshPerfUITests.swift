import XCTest

/// Refresh timing against an isolated fixture server. Skipped unless the
/// runner is given one (never the user's own computer):
///
///   TEST_RUNNER_PERF_URL=http://127.0.0.1:PORT TEST_RUNNER_PERF_CODE=XXXX-XXXX-XXXX \
///   TEST_RUNNER_PERF_BOT=<bot id> TEST_RUNNER_PERF_THREAD=<thread id> \
///   TEST_RUNNER_PERF_BOT_NAME=Atlas xcodebuild … -only-testing:BosBotUITests/RefreshPerfUITests test
///
/// The app (Debug, `-perf-probe`) writes its own marks to Documents/perf.jsonl;
/// these tests only drive the gestures and post `PERF-<n>` messages to the
/// fixture so "fresh" has something concrete to wait for.
final class RefreshPerfUITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var runs: Int { Int(env["PERF_RUNS"] ?? "") ?? 5 }

    private func fixture() throws -> (url: URL, code: String, bot: String, thread: String, name: String) {
        guard let raw = env["PERF_URL"], let url = URL(string: raw), url.host == "127.0.0.1",
              let code = env["PERF_CODE"], let bot = env["PERF_BOT"], let thread = env["PERF_THREAD"] else {
            throw XCTSkip("no isolated PERF_URL fixture")
        }
        return (url, code, bot, thread, env["PERF_BOT_NAME"] ?? "Atlas")
    }

    private func app(_ f: (url: URL, code: String, bot: String, thread: String, name: String)) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-perf-probe",
            "-perf-pair-address", "\(f.url.host!):\(f.url.port!)",
            "-perf-pair-code", f.code,
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES",
            "-companion.onboarding.introSeen", "YES",
        ]
        return app
    }

    /// One fake-engine turn on the fixture; returns once the server has it.
    private func post(_ text: String, _ f: (url: URL, code: String, bot: String, thread: String, name: String)) {
        var request = URLRequest(url: f.url.appendingPathComponent("api/bots/\(f.bot)/messages"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "threadId": f.thread])
        let done = expectation(description: "posted")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
        sleep(2) // let the fake turn settle on the server
    }

    private func marker() -> String { "PERF-\(Int(Date().timeIntervalSince1970 * 1000))" }

    private func row(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.staticTexts[name].firstMatch
    }

    @MainActor func testPullToRefresh() throws {
        let f = try fixture()
        let app = app(f)
        app.launch()
        XCTAssertTrue(row(app, f.name).waitForExistence(timeout: 30))
        sleep(4)
        let surface = app.scrollViews["bos-refresh-surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 10))
        for _ in 0..<runs {
            let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
            // a slow drag held past the threshold: a fast flick after the
            // first refresh is read as a scroll and never fires the control
            start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
            sleep(6)
        }
    }

    @MainActor func testForegroundOpenThread() throws {
        let f = try fixture()
        let app = app(f)
        app.launch()
        let bot = row(app, f.name)
        XCTAssertTrue(bot.waitForExistence(timeout: 30))
        sleep(3)
        bot.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.waitForExistence(timeout: 15))
        sleep(3)
        for _ in 0..<runs {
            XCUIDevice.shared.press(.home)
            sleep(32) // past the 25 s linger, so the stream is really down
            post(marker(), f)
            app.activate()
            sleep(8)
        }
    }

    @MainActor func testColdLaunch() throws {
        let f = try fixture()
        let app = app(f)
        app.launch()
        XCTAssertTrue(row(app, f.name).waitForExistence(timeout: 30))
        sleep(5)
        for _ in 0..<runs {
            app.terminate()
            post(marker(), f)
            app.launch()
            _ = row(app, f.name).waitForExistence(timeout: 30)
            sleep(8)
        }
    }
}
