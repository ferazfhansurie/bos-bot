import XCTest
final class StreamRecoveryUITests: XCTestCase {
    @MainActor func testAcceptedSendRepairsStalledStreamWithoutLeavingChat() {
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-stream-recovery-preview", "-open-first", "-companion.prefs.islandIntro", "never", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Live reply recovered without reopening"].waitForExistence(timeout: 12))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "recover this live stream")).count, 1)
    }
}
