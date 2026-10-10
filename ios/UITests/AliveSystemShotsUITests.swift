import XCTest

/// Screenshots of the bots outside the app: the island, a bot notification
/// expanded to its live face, and the bots widget on the home screen. Runs
/// on the DEBUG demo (`-demoActivity`, `-demoNotification`), no pairing.
/// Shots land in $ALIVE_SHOTS (default /tmp/alive-system-shots).
final class AliveSystemShotsUITests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var dir: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["ALIVE_SHOTS"] ?? "/tmp/alive-system-shots")
    }

    private func shot(_ name: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? png.write(to: dir.appendingPathComponent("\(name).png"))
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func allowNotifications() {
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 6) { allow.tap() }
    }

    @MainActor
    func testIslandAndNotification() {
        let app = XCUIApplication()
        app.launchArguments = ["-demoActivity", "working", "-demoNotification", "finished"]
        app.launch()
        allowNotifications()
        sleep(2)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot("01-island-compact")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.025)).press(forDuration: 1.2)
        sleep(2)
        shot("02-island-expanded")
        XCUIDevice.shared.press(.home)
        // the notification fires 8s after launch
        sleep(5)
        shot("03-notification-banner")
        // notification centre: the lock screen's live activity and the notification
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.005))
        top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.7)))
        sleep(2)
        shot("04-lock-screen")
        let note = springboard.otherElements.matching(NSPredicate(format: "label CONTAINS[c] 'shipped build'")).firstMatch
        if note.waitForExistence(timeout: 4) {
            note.press(forDuration: 1.2)
        } else {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2)
        }
        sleep(3)
        shot("05-notification-expanded")
    }

    @MainActor
    func testDoneCelebrates() {
        let app = XCUIApplication()
        app.launchArguments = ["-demoActivity", "done"]
        app.launch()
        allowNotifications()
        XCUIDevice.shared.press(.home)
        sleep(1)
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.025)).press(forDuration: 1.0)
        sleep(1)
        shot("06-island-celebrate")
        sleep(3)
        shot("07-island-done-settled")
    }

    @MainActor
    func testWidgetOnHomeScreen() {
        let app = XCUIApplication()
        app.launchArguments = ["-demoActivity", "working"]
        app.launch()
        allowNotifications()
        sleep(2)
        XCUIDevice.shared.press(.home)
        sleep(1)
        // edit the home screen, add the BOS bots widget
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 2.0)
        sleep(1)
        let edit = springboard.buttons["Edit"]
        if edit.waitForExistence(timeout: 3) {
            edit.tap()
            let add = springboard.buttons["Add Widget"]
            if add.waitForExistence(timeout: 3) { add.tap() }
        } else {
            let plus = springboard.buttons["Add Widget"]
            if plus.waitForExistence(timeout: 3) { plus.tap() }
        }
        sleep(2)
        let search = springboard.searchFields.firstMatch
        if search.waitForExistence(timeout: 4) {
            search.tap()
            search.typeText("BOS")
            sleep(2)
        }
        shot("08-widget-search")
        let bos = springboard.cells.matching(NSPredicate(format: "label CONTAINS[c] 'BOS'")).firstMatch
        if bos.waitForExistence(timeout: 4) { bos.tap() }
        else { springboard.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'BOS'")).firstMatch.tap() }
        sleep(2)
        shot("09-widget-gallery")
        // the second size is medium
        springboard.swipeLeft()
        sleep(1)
        shot("10-widget-gallery-medium")
        let addWidget = springboard.buttons["Add Widget"]
        if addWidget.waitForExistence(timeout: 3) { addWidget.tap() }
        sleep(2)
        let done = springboard.buttons["Done"]
        if done.waitForExistence(timeout: 3) { done.tap() }
        sleep(2)
        shot("11-widget-home")
    }
}
