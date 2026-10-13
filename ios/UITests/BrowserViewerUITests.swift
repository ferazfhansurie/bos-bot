import XCTest

final class BrowserViewerUITests: XCTestCase {
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
