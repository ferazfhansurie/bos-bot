import XCTest

/// The floating down button lands on the newest message in one tap from far
/// up a long transcript, goes away, and following picks back up: rows that
/// keep arriving don't bring the button back.
final class JumpToLatestUITests: XCTestCase {
    private let common = [
        "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        "-companion.prefs.islandIntro", "never",
        "-companion.onboarding.welcomeSeen", "YES",
        "-companion.onboarding.notificationsSeen", "YES"
    ]

    @MainActor
    func testRoomJumpLandsOnLatestAndKeepsFollowing() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-shared-chat-preview", "-shared-chat-preview-long", "-shared-chat-preview-incoming"] + common
        let room = app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Launch crew'")).firstMatch
        for _ in 0..<4 {
            app.launch()
            if room.waitForExistence(timeout: 12) { break }
            app.terminate()
        }
        let opened = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Incoming'")).firstMatch
        sleep(2)
        for _ in 0..<3 where !opened.exists {
            room.tap()
            _ = opened.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(opened.exists, "room didn't open")

        scrollUp(app)
        let jump = app.buttons["Latest messages"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5), "no down button after scrolling up")
        attach(app, "room scrolled up")

        jump.tap()
        XCTAssertTrue(jump.waitForNonExistence(timeout: 3), "down button stayed after the jump")
        XCTAssertTrue(newest(app, prefix: "Incoming").isHittable, "jump didn't land on the newest message")
        attach(app, "room after jump")

        // Maya posts every 3s; still following means still at the end.
        sleep(10)
        XCTAssertFalse(jump.exists, "following didn't pick back up")
        XCTAssertTrue(newest(app, prefix: "Incoming").isHittable)
        attach(app, "room after new messages")
    }

    @MainActor
    func testBotChatJumpLandsOnLatestAndKeepsFollowing() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-store-preview", "-threads-preview", "-stream-preview", "-stream-preview-autostart",
                               "-stream-preview-history", "300", "-open-first"] + common
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        for _ in 0..<4 {
            app.launch()
            if input.waitForExistence(timeout: 12) { break }
            app.terminate()
        }
        sleep(3)

        scrollUp(app)
        let jump = app.buttons["jump-to-latest"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5), "no down button after scrolling up")
        attach(app, "chat scrolled up")

        jump.tap()
        XCTAssertTrue(jump.waitForNonExistence(timeout: 3), "down button stayed after the jump")
        attach(app, "chat after jump")

        // The reply keeps streaming; still following means the button stays away.
        sleep(8)
        XCTAssertFalse(jump.exists, "following didn't pick back up while the reply streams")
        attach(app, "chat while streaming")
    }

    /// Coordinate drags: a long, live room is too big a tree to query for
    /// every swipe.
    private func scrollUp(_ app: XCUIApplication) {
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        for _ in 0..<30 { top.press(forDuration: 0.01, thenDragTo: bottom, withVelocity: .fast, thenHoldForDuration: 0) }
    }

    private func newest(_ app: XCUIApplication, prefix: String) -> XCUIElement {
        let rows = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", prefix)).allElementsBoundByIndex
        let numbered = rows.compactMap { row -> (Int, XCUIElement)? in
            guard let range = row.label.range(of: prefix + " ") else { return nil }
            return Int(row.label[range.upperBound...].prefix { $0.isNumber }).map { ($0, row) }
        }
        return numbered.max { $0.0 < $1.0 }?.1 ?? app.staticTexts["missing-newest"]
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
