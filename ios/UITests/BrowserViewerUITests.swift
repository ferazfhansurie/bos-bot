import XCTest

final class BrowserViewerUITests: XCTestCase {
    @MainActor
    func testComputerPickerSavesAndReadsBackThreadSelection() throws {
        guard let raw = ProcessInfo.processInfo.environment["BOS_PHONE_VIEW_FIXTURE_URL"] else { throw XCTSkip("start the phone-view fixture") }
        let app = XCUIApplication()
        app.launchArguments = ["-computer-preview", "-browser-preview-url", raw]
        app.launch()
        let switcher = app.buttons["switch-thread-computer"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 15))
        switcher.tap()
        let picker = app.buttons["thread-computer-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        picker.tap()
        app.buttons["Browser"].tap()
        let use = app.buttons["Use Browser"]
        XCTAssertTrue(use.waitForExistence(timeout: 5))
        use.tap()
        let readback = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Browser"), object: picker)
        XCTAssertEqual(XCTWaiter.wait(for: [readback], timeout: 10), .completed, "server readback is displayed")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Thread computer selection"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["Done"].tap()
        XCTAssertTrue(switcher.waitForExistence(timeout: 5))
    }

    @MainActor
    func testFramesStayCurrentWhileAcknowledgementIsSlow() async throws {
        guard let raw = ProcessInfo.processInfo.environment["BOS_PHONE_VIEW_FIXTURE_URL"] else { throw XCTSkip("start the phone-view fixture") }
        let app = XCUIApplication()
        app.launchArguments = ["-browser-preview", "-browser-preview-url", raw]
        app.launch()
        XCTAssertTrue(app.images["Live browser page"].waitForExistence(timeout: 15))
        for _ in 0..<12 {
            XCTAssertFalse(app.staticTexts["waiting for a frame"].exists, "displayed frames stay current during slow ACKs")
            XCTAssertTrue(app.buttons["take control"].isEnabled)
            try await Task.sleep(for: .milliseconds(200))
        }
        var request = URLRequest(url: URL(string: raw)!.appendingPathComponent("fixture/stats"))
        request.setValue("Bearer browser-fixture-token", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: request)
        let stats = try JSONSerialization.jsonObject(with: data) as? [String: Int]
        XCTAssertGreaterThanOrEqual(stats?["acknowledgements"] ?? 0, 3, "multiple slow frames were exercised")
    }

    @MainActor
    func testComputerRequestsPreviewWithoutBotActivityAndShowsRefusal() async throws {
        guard let raw = ProcessInfo.processInfo.environment["BOS_PHONE_VIEW_FIXTURE_URL"], let url = URL(string: raw) else { throw XCTSkip("start the phone-view fixture") }
        let app = XCUIApplication()
        app.launchArguments = ["-computer-preview", "-browser-preview-url", raw]
        app.launch()
        XCTAssertTrue(app.images["Live computer preview"].waitForExistence(timeout: 15), "idle computer can be watched without waiting for a tool call")
        var request = URLRequest(url: url.appendingPathComponent("fixture/deny-preview"))
        request.httpMethod = "POST"
        request.setValue("Bearer browser-fixture-token", forHTTPHeaderField: "Authorization")
        _ = try await URLSession.shared.data(for: request)
        XCTAssertTrue(app.staticTexts["Enable computer viewing for this phone in BOS settings."].waitForExistence(timeout: 15))
        XCTAssertTrue(app.images["Live computer preview"].exists, "last frame remains labeled offline")
        XCTAssertTrue(app.staticTexts["offline · last frame"].exists)
    }

    @MainActor
    func testLiveSessionAndExclusiveControl() async throws {
        guard let raw = ProcessInfo.processInfo.environment["BOS_BROWSER_FIXTURE_URL"], let url = URL(string: raw), url.host == "127.0.0.1", url.port != nil else {
            throw XCTSkip("start scripts/verify-mobile-browser.ts and supply its loopback fixture url")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-browser-preview", "-browser-preview-url", raw]
        app.launch()
        guard app.images["Live browser page"].waitForExistence(timeout: 25) else { XCTFail("live browser frame never appeared"); return }
        XCTAssertTrue(app.buttons["Browser tabs"].exists)
        let initial = XCTAttachment(screenshot: app.screenshot()); initial.name = "mobile browser watching"; initial.lifetime = .keepAlways; add(initial)
        app.buttons["take control"].tap()
        XCTAssertTrue(app.buttons["give back"].waitForExistence(timeout: 10))
        var request = URLRequest(url: url.appendingPathComponent("fixture/agent-change"))
        request.httpMethod = "POST"
        request.setValue("Bearer browser-fixture-token", forHTTPHeaderField: "Authorization")
        let (_, refused) = try await URLSession.shared.data(for: request)
        XCTAssertGreaterThanOrEqual((refused as? HTTPURLResponse)?.statusCode ?? 0, 400, "agent cannot act during phone control")
        app.buttons["Browser tabs"].tap()
        XCTAssertTrue(app.navigationBars["browser tabs"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.cells.firstMatch.exists, "the shared session has a tab in the native switcher")
        app.buttons["done"].tap()
        app.buttons["give back"].tap()
        XCTAssertTrue(app.buttons["take control"].waitForExistence(timeout: 10))
        let (body, accepted) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((accepted as? HTTPURLResponse)?.statusCode, 200)
        let result = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertNotEqual(result?["isError"] as? Bool, true)
        let updated = XCTAttachment(screenshot: app.screenshot()); updated.name = "same browser after agent change"; updated.lifetime = .keepAlways; add(updated)
    }
}
