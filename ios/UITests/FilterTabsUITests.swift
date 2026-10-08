import XCTest

/// The chat list's All / Unread / Waiting / Running tabs select on the
/// first tap and change the list.
final class FilterTabsUITests: XCTestCase {
    @MainActor
    func testEachTabSelectsOnFirstTapAndFiltersTheList() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "-store-preview", "-room-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ]
        let filter = app.segmentedControls["conversation-status-filter"]
        for _ in 0..<4 {
            app.launch()
            if filter.waitForExistence(timeout: 12) { break }
            app.terminate()
        }
        XCTAssertTrue(filter.exists)
        sleep(2)
        let jobs = app.buttons["job-inbox-entry"]
        XCTAssertTrue(jobs.exists)

        for tab in ["Unread", "Waiting", "Running", "All"] {
            let button = filter.buttons[tab]
            button.tap()
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = tab
            shot.lifetime = .keepAlways
            add(shot)
            XCTAssertTrue(button.waitForSelected(timeout: 2), "\(tab) didn't select on the first tap")
            if tab == "All" {
                XCTAssertTrue(jobs.waitForExistence(timeout: 2), "All didn't bring the list back")
            } else {
                XCTAssertTrue(jobs.waitForNonExistence(timeout: 2), "\(tab) selected but the list didn't change")
            }
        }
    }
}

private extension XCUIElement {
    func waitForSelected(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isSelected { return true }
            usleep(100_000)
        }
        return isSelected
    }
}
