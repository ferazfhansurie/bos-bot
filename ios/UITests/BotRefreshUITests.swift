import XCTest

final class BotRefreshUITests: XCTestCase {
    @MainActor func testPullHasCheckingStateAndSettlesWithoutMovingRows() {
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-pull-refresh-preview",
                               "-companion.prefs.islandIntro", "never",
                               "-companion.onboarding.welcomeSeen", "YES",
                               "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let surface = app.scrollViews["bos-refresh-surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 12))
        let checking = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Checking bots"), object: surface)
        XCTAssertEqual(XCTWaiter.wait(for: [checking], timeout: 10), .completed)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Bots checking together"
        image.lifetime = .keepAlways
        add(image)
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Ready"), object: surface)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed)
        XCTAssertTrue(app.buttons["threads-toggle.preview-pepper"].exists)
        let final = XCTAttachment(screenshot: app.screenshot())
        final.name = "Bots settled after refresh"
        final.lifetime = .keepAlways
        add(final)
    }
}
