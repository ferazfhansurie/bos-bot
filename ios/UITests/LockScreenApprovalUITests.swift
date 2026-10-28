import XCTest

/// bos bot 3.0 step 9: a task starts on the Mac, the phone is locked, the
/// tool approval lands on the lock screen, Allow is tapped there, and the
/// task finishes back on the Mac. Runs against an isolated control-omb
/// fixture driven by a host script; skipped unless the runner gets
/// TEST_RUNNER_STEP9_PAIR_URL. The host and this test meet through flag
/// files in $STEP9_DIR (default /tmp/step9): this test writes `paired`,
/// `locked` and `answered`; the host writes `pushed` and `finished`.
final class LockScreenApprovalUITests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var pairURL: URL!
    private var dir = URL(fileURLWithPath: "/tmp/step9")
    private var shots = URL(fileURLWithPath: "/tmp/step9/shots")

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["STEP9_PAIR_URL"].flatMap(URL.init(string:)) else { throw XCTSkip("no step 9 fixture") }
        pairURL = url
        if let path = env["STEP9_DIR"] { dir = URL(fileURLWithPath: path) }
        shots = dir.appendingPathComponent("shots")
        continueAfterFailure = false
    }

    @MainActor
    func testApproveFromTheLockScreen() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion.onboarding.introSeen", "YES"]
        app.launch()
        app.open(pairURL)
        let connect = app.buttons["Connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 30), "pairing confirmation")
        for _ in 0..<10 where connect.exists {
            if connect.isHittable { connect.tap() }
            _ = connect.waitForNonExistence(timeout: 3)
        }
        allowNotifications(app)
        // the lock-screen ask needs notifications on
        let enable = app.buttons["Enable notifications"]
        if enable.waitForExistence(timeout: 10) { enable.tap() }
        allowNotifications(app)
        flag("paired")

        // the host starts the task on the Mac; it shows up working here
        sleep(4)
        shot("01-working-in-app")

        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(1)
        flag("locked")
        XCTAssertTrue(waitForFlag("pushed", timeout: 90), "the host sent the approval push")
        // the push lights the lock screen; a home press would unlock a
        // passcode-less simulator, so the screen is left as the push woke it
        sleep(4)
        shot("02-lock-screen-approval")

        // first run: iOS asks once whether BOS may show live activities
        let dontAllow = springboard.buttons["Don’t Allow"]
        if dontAllow.waitForExistence(timeout: 4) {
            lowestAllow()?.tap()
            sleep(2)
        }
        shot("03-lock-screen-live-ask")

        // the live ask on the lock screen carries Allow and Deny; when it is
        // absent the notification's long-press actions are the way in
        var allow = lowestAllow()
        if allow == nil {
            let note = springboard.otherElements.matching(NSPredicate(format: "label CONTAINS[c] 'git push'")).firstMatch
            XCTAssertTrue(note.waitForExistence(timeout: 8), "the approval is on the lock screen")
            note.press(forDuration: 1.4)
            sleep(2)
            allow = lowestAllow()
        }
        guard let allow else { return XCTFail("the lock screen offers Allow") }
        allow.tap()
        sleep(3)
        shot("04-after-allow")
        flag("answered")

        XCTAssertTrue(waitForFlag("finished", timeout: 90), "the task finished on the Mac")
        app.activate()
        sleep(3)
        shot("05-finished-in-app")
    }

    /// The Allow button nearest the bottom: the live ask sits above the
    /// system's one-time prompt, the notification action below its banner.
    private func lowestAllow() -> XCUIElement? {
        let buttons = springboard.buttons.matching(identifier: "Allow").allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
        return buttons.max { $0.frame.minY < $1.frame.minY }
    }

    private func allowNotifications(_ app: XCUIApplication) {
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 8) { allow.tap() }
    }

    private func flag(_ name: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dir.appendingPathComponent(name).path, contents: Data())
    }

    private func waitForFlag(_ name: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    private func shot(_ name: String) {
        try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? png.write(to: shots.appendingPathComponent("\(name).png"))
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
