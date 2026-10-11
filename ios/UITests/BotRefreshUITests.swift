import XCTest

final class BotRefreshUITests: XCTestCase {
    @MainActor func testPullCompletesCheckingAndReturnsToTheSameRosterPosition() {
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-refresh-ui-test",
                               "-companion.prefs.islandIntro", "never",
                               "-companion.onboarding.welcomeSeen", "YES",
                               "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let surface = app.scrollViews["bos-refresh-surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 12))
        let row = app.staticTexts["Pepper"]
        XCTAssertTrue(row.exists)
        let before = row.frame.minY
        let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.1, thenDragTo: end)
        // The debug receipt proves the delayed check ran without cancellation;
        // XCTest may wait for it to settle before returning from the gesture.
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Ready, checked"), object: surface)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 12), .completed)
        XCTAssertTrue(row.exists)
        XCTAssertEqual(row.frame.minY, before, accuracy: 2)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Bots settled after completed refresh"
        image.lifetime = .keepAlways
        add(image)
    }
}
