import XCTest

/// Slice 2 against a real local issuer and room service from
/// `services/cloud/local.ts`. Skipped unless the runner gets
/// TEST_RUNNER_CLOUD_ISSUER_URL and TEST_RUNNER_CLOUD_ROOMS_URL. Only
/// fictional *@example.test accounts; the code comes from the dev-only
/// `/__dev/otp` sink, never email.
final class CloudRoomsLiveUITests: XCTestCase {
    private var issuer: URL!
    private var rooms: URL!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let i = env["CLOUD_ISSUER_URL"].flatMap(URL.init(string:)),
              let r = env["CLOUD_ROOMS_URL"].flatMap(URL.init(string:))
        else { throw XCTSkip("no local cloud fixture") }
        issuer = i; rooms = r
        continueAfterFailure = false
    }

    /// Owner signs in, creates a room and invite, sends; signs out; a second
    /// account signs in, redeems, reads the owner's message and replies; the
    /// owner signs back in and sees the reply.
    @MainActor
    func testTwoAccountsSignInInviteRedeemAndChat() async throws {
        let run = String(UUID().uuidString.prefix(8)).lowercased()
        let alice = "alice-\(run)@example.test"
        let bob = "bob-\(run)@example.test"
        let app = launch()

        try await signIn(alice, in: app)
        let aliceSubject = app.staticTexts["cloud.subject"].label
        shot("owner signed in", app)

        app.buttons["cloud.createRoom"].tap()
        let invite = app.staticTexts["cloud.lastInvite"]
        XCTAssertTrue(invite.waitForExistence(timeout: 15), problem(app))
        let token = invite.label
        XCTAssertFalse(token.isEmpty)
        shot("room created with invite", app)

        openRoom(in: app)
        send("hello from alice \(run)", in: app)
        shot("owner message delivered", app)
        app.navigationBars.buttons.firstMatch.tap()

        signOut(app)
        try await signIn(bob, in: app)
        XCTAssertNotEqual(app.staticTexts["cloud.subject"].label, aliceSubject, "second account must get its own subject")

        let field = app.textFields["cloud.inviteToken"]
        type(token, into: field)
        app.buttons["cloud.redeem"].tap()
        openRoom(in: app)
        XCTAssertTrue(app.staticTexts["hello from alice \(run)"].waitForExistence(timeout: 15), "invitee should read the owner's history")
        send("hi alice, bob here \(run)", in: app)
        shot("invitee read history and replied", app)
        app.navigationBars.buttons.firstMatch.tap()

        signOut(app)
        try await signIn(alice, in: app)
        XCTAssertEqual(app.staticTexts["cloud.subject"].label, aliceSubject, "a new otp session keeps the same subject")
        openRoom(in: app)
        XCTAssertTrue(app.staticTexts["hi alice, bob here \(run)"].waitForExistence(timeout: 15), "owner should see the reply")
        shot("owner sees the reply", app)
        app.navigationBars.buttons.firstMatch.tap()
        signOut(app)
    }

    /// One side of a cross-client exchange, driven from outside. Skipped
    /// unless the runner gets TEST_RUNNER_CLOUD_SCRIPT_B64: base64 of
    /// `{"email": ..., "invite"?: ..., "timeout"?: seconds, "steps": [{"expect": text} | {"send": text}]}`.
    /// With an invite it redeems and joins that room; without one it creates
    /// its own. Texts are exact (unicode and newlines kept). Each step logs a
    /// `CLOUD_INTEROP {json}` line for the driver.
    @MainActor
    func testScriptedExchange() async throws {
        guard let encoded = ProcessInfo.processInfo.environment["CLOUD_SCRIPT_B64"],
              let data = Data(base64Encoded: encoded)
        else { throw XCTSkip("no exchange script") }
        struct Step: Decodable { var expect: String?; var send: String? }
        struct Script: Decodable { var email: String; var invite: String?; var timeout: Double?; var steps: [Step] }
        let script = try JSONDecoder().decode(Script.self, from: data)
        let wait = script.timeout ?? 120
        let app = launch()

        try await signIn(script.email, in: app)
        log(["event": "signedIn", "subject": app.staticTexts["cloud.subject"].label])
        if let invite = script.invite, !invite.isEmpty {
            type(invite, into: app.textFields["cloud.inviteToken"])
            app.buttons["cloud.redeem"].tap()
        } else {
            app.buttons["cloud.createRoom"].tap()
            XCTAssertTrue(app.staticTexts["cloud.lastInvite"].waitForExistence(timeout: 15), problem(app))
        }
        openRoom(in: app)
        log(["event": "joined", "room": app.navigationBars.firstMatch.identifier])

        for (index, step) in script.steps.enumerated() {
            if let text = step.expect {
                let got = message(text, in: app)
                XCTAssertTrue(got.waitForExistence(timeout: wait), "step \(index): expected text never arrived")
                log(["event": "received", "step": "\(index)", "messageId": messageId(got), "text": text])
            } else if let text = step.send {
                let composer = app.textFields["cloud.composer"]
                type(text, into: composer)
                XCTAssertEqual(composer.value as? String, text, "step \(index): composer changed the text")
                app.buttons["cloud.send"].tap()
                let got = message(text, in: app)
                XCTAssertTrue(got.waitForExistence(timeout: 15), "step \(index): not committed: \(problem(app))")
                log(["event": "sent", "step": "\(index)", "messageId": messageId(got), "text": text])
            }
            shot("step \(index)", app)
        }
        app.navigationBars.buttons.firstMatch.tap()
        signOut(app)
    }

    /// Slice 4 offline replay: the room service drops (debug toggle, the
    /// Mac's network stays up), two sends wait in the durable outbox, the app
    /// goes to the background and back, and coming online commits each send
    /// exactly once, in order.
    @MainActor
    func testOfflineSendBackgroundAndReplay() async throws {
        let run = String(UUID().uuidString.prefix(8)).lowercased()
        let app = launch()
        try await signIn("offline-\(run)@example.test", in: app)
        app.buttons["cloud.createRoom"].tap()
        XCTAssertTrue(app.staticTexts["cloud.lastInvite"].waitForExistence(timeout: 15), problem(app))
        openRoom(in: app)
        send("online first \(run)", in: app)

        app.buttons["cloud.offlineToggle"].tap()
        XCTAssertTrue(app.staticTexts["cloud.connecting"].waitForExistence(timeout: 10), "offline drops realtime")
        let first = "offline one \(run)", second = "offline two \(run)"
        for text in [first, second] {
            type(text, into: app.textFields["cloud.composer"])
            app.buttons["cloud.send"].tap()
            XCTAssertTrue(pending(text, in: app).waitForExistence(timeout: 10), "offline send should wait in the outbox: \(problem(app))")
        }
        XCTAssertEqual(messages(first, in: app).count, 0, "nothing commits while offline")
        shot("two sends waiting offline", app)

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.activate()
        XCTAssertTrue(app.textFields["cloud.composer"].waitForExistence(timeout: 10), "room stays open after background")
        XCTAssertTrue(pending(second, in: app).exists, "waiting sends survive the background")

        app.buttons["cloud.offlineToggle"].tap()
        XCTAssertTrue(app.staticTexts["cloud.live"].waitForExistence(timeout: 20), "realtime reconnects")
        for text in [first, second] {
            XCTAssertTrue(message(text, in: app).waitForExistence(timeout: 20), "replayed send should commit: \(problem(app))")
        }
        XCTAssertTrue(waitGone(pendingRows(in: app).firstMatch, timeout: 10), "outbox drains")
        XCTAssertEqual(messages(first, in: app).count, 1, "committed exactly once")
        XCTAssertEqual(messages(second, in: app).count, 1, "committed exactly once")
        XCTAssertLessThan(message(first, in: app).frame.minY, message(second, in: app).frame.minY, "replay keeps send order")
        shot("replayed in order", app)
        app.navigationBars.buttons.firstMatch.tap()
        signOut(app)
    }

    /// A send that was in flight when the app died is looked up after
    /// relaunch and never replayed on its own; the person chooses to resend.
    @MainActor
    func testOfflineSendAfterRelaunchNeedsReview() async throws {
        let run = String(UUID().uuidString.prefix(8)).lowercased()
        let app = launch()
        try await signIn("relaunch-\(run)@example.test", in: app)
        app.buttons["cloud.createRoom"].tap()
        XCTAssertTrue(app.staticTexts["cloud.lastInvite"].waitForExistence(timeout: 15), problem(app))
        openRoom(in: app)

        app.buttons["cloud.offlineToggle"].tap()
        XCTAssertTrue(app.staticTexts["cloud.connecting"].waitForExistence(timeout: 10))
        let text = "before relaunch \(run)"
        type(text, into: app.textFields["cloud.composer"])
        app.buttons["cloud.send"].tap()
        XCTAssertTrue(pending(text, in: app).waitForExistence(timeout: 10), problem(app))

        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["cloud.subject"].waitForExistence(timeout: 20), "account survives relaunch")
        openRoom(in: app)
        let resend = app.buttons["cloud.pending.resend"]
        XCTAssertTrue(resend.waitForExistence(timeout: 20), "uncommitted send waits for review: \(problem(app))")
        XCTAssertEqual(messages(text, in: app).count, 0, "never replayed without the person")
        shot("send waiting for review after relaunch", app)
        resend.tap()
        XCTAssertTrue(message(text, in: app).waitForExistence(timeout: 20), problem(app))
        XCTAssertTrue(waitGone(pendingRows(in: app).firstMatch, timeout: 10))
        XCTAssertEqual(messages(text, in: app).count, 1)
        app.navigationBars.buttons.firstMatch.tap()
        signOut(app)
    }

    /// Owner attaches a text file and a png, sees the scan reject a test
    /// file, sends; the invitee signs in, redeems and opens the text from
    /// the message. Bytes come back from the server, never from disk.
    @MainActor
    func testAttachmentsUploadScanSendAndRecipientDownloads() async throws {
        let run = String(UUID().uuidString.prefix(8)).lowercased()
        let app = launch()
        try await signIn("files-\(run)@example.test", in: app)
        app.buttons["cloud.createRoom"].tap()
        let invite = app.staticTexts["cloud.lastInvite"]
        XCTAssertTrue(invite.waitForExistence(timeout: 15), problem(app))
        let token = invite.label
        openRoom(in: app)

        attach("cloud.attach.eicar", "scan test file", in: app)
        let rejected = app.descendants(matching: .any)["cloud.draft.rejected"]
        XCTAssertTrue(rejected.waitForExistence(timeout: 15), "the fixture scanner rejects the test file: \(problem(app))")
        XCTAssertFalse(app.buttons["cloud.send"].isEnabled, "a rejected attachment blocks send")
        shot("scan rejected", app)
        rejected.buttons["cloud.draft.remove"].tap()
        XCTAssertTrue(waitGone(rejected, timeout: 5))

        attach("cloud.attach.sampleText", "sample text", in: app)
        attach("cloud.attach.samplePNG", "sample png", in: app)
        let ready = app.descendants(matching: .any).matching(identifier: "cloud.draft.ready")
        let deadline = Date().addingTimeInterval(20)
        while ready.count < 2, Date() < deadline { Thread.sleep(forTimeInterval: 0.3) }
        XCTAssertEqual(ready.count, 2, "both attachments reach ready: \(problem(app))")
        shot("two attachments ready", app)
        send("with files \(run)", in: app)
        XCTAssertTrue(waitGone(ready.firstMatch, timeout: 5), "drafts clear after send")
        let chips = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'cloud.attachment.'"))
        XCTAssertEqual(chips.count, 2, "the message carries both attachments")
        app.navigationBars.buttons.firstMatch.tap()
        signOut(app)

        try await signIn("files-b-\(run)@example.test", in: app)
        type(token, into: app.textFields["cloud.inviteToken"])
        app.buttons["cloud.redeem"].tap()
        openRoom(in: app)
        XCTAssertTrue(message("with files \(run)", in: app).waitForExistence(timeout: 15))
        XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: 10))
        var sawText = false, sawImage = false
        for index in 0..<chips.count {
            chips.element(boundBy: index).tap()
            let text = app.staticTexts["cloud.viewer.text"], image = app.images["cloud.viewer.image"]
            let deadline = Date().addingTimeInterval(15)
            while !text.exists, !image.exists, !app.staticTexts["cloud.viewer.problem"].exists, Date() < deadline { Thread.sleep(forTimeInterval: 0.3) }
            if text.exists { XCTAssertEqual(text.label, "fictional attachment text"); sawText = true }
            if image.exists { sawImage = true }
            XCTAssertFalse(app.staticTexts["cloud.viewer.problem"].exists, app.staticTexts["cloud.viewer.problem"].exists ? app.staticTexts["cloud.viewer.problem"].label : "")
            shot("recipient opened attachment \(index)", app)
            app.buttons["cloud.viewer.done"].tap()
            XCTAssertTrue(waitGone(app.buttons["cloud.viewer.done"], timeout: 5))
        }
        XCTAssertTrue(sawText && sawImage, "recipient downloads the text and the image")
        app.navigationBars.buttons.firstMatch.tap()
        signOut(app)
    }

    /// A second session of the same account registers a bot and its host,
    /// mentions the bot and plays the host up to an approval card. The app
    /// shows the card, approves it once; a second decision is refused, and
    /// a card that runs out shows expired with no buttons.
    @MainActor
    func testApprovalCardApproveOnceAndExpiry() async throws {
        let run = String(UUID().uuidString.prefix(8)).lowercased()
        let email = "gate-\(run)@example.test"
        let app = launch()
        try await signIn(email, in: app)
        app.buttons["cloud.createRoom"].tap()
        XCTAssertTrue(app.staticTexts["cloud.lastInvite"].waitForExistence(timeout: 15), problem(app))

        let host = try await CloudHostDriver.signIn(email: email, issuer: issuer, rooms: rooms, otp: otp(for:))
        let room = try await host.firstRoom()
        let bot = "bot\(run)"
        try await host.registerBot(workspace: room.workspace, room: room.room, botId: bot, name: "gate bot")
        let (hostId, credential) = try await host.registerHost(workspace: room.workspace, botIds: [bot])
        let fresh = try await host.firstRoom()
        let mention = try await host.sendMention(workspace: fresh.workspace, room: fresh.room, thread: fresh.thread, policyRevision: fresh.policyRevision, text: "@\(bot) send it", botId: bot)
        let (_, approvalId) = try await host.claimAndRequestApproval(workspace: fresh.workspace, hostId: hostId, credential: credential, title: "send the fictional report \(run)", expiresIn: 300, messageId: mention)

        openRoom(in: app)
        let card = app.descendants(matching: .any)["cloud.card.\(approvalId)"]
        XCTAssertTrue(card.waitForExistence(timeout: 15), "the approval card shows: \(problem(app))")
        XCTAssertTrue(card.staticTexts["send the fictional report \(run)"].exists)
        XCTAssertTrue(card.staticTexts["cloud.card.status.pending"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["cloud.run.state.waiting_for_human"].waitForExistence(timeout: 10), "the run waits for the person")
        shot("approval card pending", app)
        card.buttons["cloud.card.approve"].tap()
        XCTAssertTrue(card.staticTexts["cloud.card.status.approved"].waitForExistence(timeout: 15), "approved: \(problem(app))")
        XCTAssertFalse(card.buttons["cloud.card.approve"].exists, "a decided card has no buttons")
        XCTAssertTrue(app.descendants(matching: .any)["cloud.run.state.running"].waitForExistence(timeout: 10), "approval resumes the run")
        shot("approved once", app)

        let again = try await host.decide(workspace: fresh.workspace, room: fresh.room, approvalId: approvalId, decision: "deny")
        XCTAssertEqual(again.status, 409)
        XCTAssertEqual(again.body["error"] as? String, "approval_decided", "the second decision is refused")
        XCTAssertTrue(card.staticTexts["cloud.card.status.approved"].exists, "the card stays approved")

        // A short card runs out on screen before anyone decides.
        let second = try await host.sendMention(workspace: fresh.workspace, room: fresh.room, thread: fresh.thread, policyRevision: fresh.policyRevision, text: "@\(bot) and this", botId: bot)
        let (_, shortId) = try await host.claimAndRequestApproval(workspace: fresh.workspace, hostId: hostId, credential: credential, title: "short card \(run)", expiresIn: 4, messageId: second)
        let short = app.descendants(matching: .any)["cloud.card.\(shortId)"]
        XCTAssertTrue(short.waitForExistence(timeout: 15), "the second card shows")
        XCTAssertTrue(short.staticTexts["cloud.card.status.expired"].waitForExistence(timeout: 15), "an expired card reads expired")
        XCTAssertFalse(short.buttons["cloud.card.approve"].exists, "an expired card has no buttons")
        let late = try await host.decide(workspace: fresh.workspace, room: fresh.room, approvalId: shortId, decision: "approve")
        XCTAssertEqual(late.status, 409)
        XCTAssertEqual(late.body["error"] as? String, "approval_expired")
        shot("short card expired", app)
        app.navigationBars.buttons.firstMatch.tap()
        signOut(app)
    }

    @MainActor
    private func attach(_ identifier: String, _ label: String, in app: XCUIApplication) {
        // The sheet can still be closing from the last pick; reopen until it shows.
        for _ in 0..<4 {
            app.buttons["cloud.attach"].tap()
            if app.buttons[identifier].waitForExistence(timeout: 3) { break }
        }
        XCTAssertTrue(app.buttons[identifier].exists, "attach sheet shows \(label)")
        app.buttons[identifier].tap()
        XCTAssertTrue(waitGone(app.buttons[identifier], timeout: 5), "attach sheet closes")
    }

    @MainActor
    private func messages(_ text: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'cloud.message.'"))
            .containing(NSPredicate(format: "label == %@", text))
    }

    @MainActor
    private func pendingRows(in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier BEGINSWITH 'cloud.pending.' AND NOT (identifier IN %@)",
            ["cloud.pending.release", "cloud.pending.discard", "cloud.pending.resend", "cloud.pending.giveUp"]))
    }

    @MainActor
    private func pending(_ text: String, in app: XCUIApplication) -> XCUIElement {
        pendingRows(in: app).containing(NSPredicate(format: "label == %@", text)).firstMatch
    }

    private func waitGone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    // MARK: - steps

    /// Independent check-owned fault proxy forwards to the real local issuer.
    /// Revocation calls the issuer sign-out with the actual session captured at
    /// sign-in; no bearer is exposed to XCTest output or attachments.
    @MainActor
    func testRevokedAndUnavailableStates() async throws {
        guard let secret = ProcessInfo.processInfo.environment["CLOUD_CHECK_SECRET"]
        else { throw XCTSkip("no check-owned fault target") }
        let address = "native-state-\(UUID().uuidString.lowercased())@example.test"
        let app = launch()
        XCTAssertTrue(app.textFields["cloud.email"].exists)
        log(["event": "signedOutState"])
        func control(_ path: String, _ value: [String: String]) async throws {
            var request = URLRequest(url: issuer.appendingPathComponent("__check/" + path))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(secret, forHTTPHeaderField: "X-Check-Secret")
            request.httpBody = try JSONSerialization.data(withJSONObject: value)
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            if path == "otp-slot", let json = try JSONSerialization.jsonObject(with: data) as? [String: Double], let at = json["at_ms"] {
                let delay = max(0, at / 1000 - Date().timeIntervalSince1970)
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
        try await control("otp-slot", [:])
        try await signIn(address, in: app)
        signOut(app)
        log(["event": "signOutRendered"])
        try await control("otp-slot", [:])
        try await signIn(address, in: app)
        app.buttons["cloud.createRoom"].tap()
        XCTAssertTrue(app.staticTexts["cloud.lastInvite"].waitForExistence(timeout: 15), problem(app))
        openRoom(in: app)

        try await control("mode", ["mode": "5xx"])
        // A fresh protected action validates authoritatively. Socket closure
        // alone need not carry an identity error to the native client.
        type("fictional issuer outage probe", into: app.textFields["cloud.composer"])
        app.buttons["cloud.send"].tap()
        XCTAssertTrue(app.staticTexts["cloud.problem"].waitForExistence(timeout: 20), problem(app))
        XCTAssertTrue(problem(app).contains("identity unavailable"), "fresh action should render the issuer outage")
        XCTAssertTrue(app.textFields["cloud.composer"].exists, "outage preserves the signed-in room")
        XCTAssertFalse(app.textFields["cloud.email"].exists, "outage must not erase the account")
        log(["event": "unavailableState", "accountPreserved": "true"])
        shot("issuer unavailable", app)
        try await control("mode", ["mode": "normal"])
        // Relaunch only this simulator app to run its documented foreground
        // identity validation and reload the preserved account/room store.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["cloud.subject"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["cloud.identityUnavailable"].exists)
        openRoom(in: app)
        log(["event": "issuerRecovered"])
        try await control("revoke", ["email": address])
        XCTAssertTrue(app.staticTexts["cloud.revoked"].waitForExistence(timeout: 20), problem(app))
        XCTAssertTrue(app.textFields["cloud.email"].exists)
        XCTAssertFalse(app.textFields["cloud.composer"].exists, "revocation removes the cached room")
        log(["event": "revokedState", "roomRemoved": "true"])
        shot("session revoked", app)
    }

    @MainActor
    private func message(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'cloud.message.'"))
            .containing(NSPredicate(format: "label == %@", text)).firstMatch
    }

    private func messageId(_ element: XCUIElement) -> String {
        String(element.identifier.dropFirst("cloud.message.".count))
    }

    private func log(_ fields: [String: String]) {
        let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        print("CLOUD_INTEROP " + String(decoding: data, as: UTF8.self))
    }

    // MARK: - push

    /// Cloud push without APNs. The app registers this installation with the
    /// room service for real; delivery is `xcrun simctl push` through the host
    /// relay in services/cloud/acceptance/run-ios-push.mjs (skipped without
    /// TEST_RUNNER_CLOUD_PUSH_RELAY_URL), which builds each hint and checks it
    /// against PushHintSchema. Tapping the banner opens the room from the
    /// background and from a cold launch; a hint for a room this account
    /// can't see, or one off the schema, opens nothing.
    @MainActor
    func testPushRegistersAndTapOpensTheRoom() async throws {
        guard let relay = ProcessInfo.processInfo.environment["CLOUD_PUSH_RELAY_URL"].flatMap(URL.init(string:))
        else { throw XCTSkip("no simctl push relay") }
        let run = String(UUID().uuidString.prefix(8)).lowercased()
        let email = "push-\(run)@example.test"
        let app = launch()
        try await signIn(email, in: app)
        app.buttons["cloud.createRoom"].tap()
        XCTAssertTrue(app.staticTexts["cloud.lastInvite"].waitForExistence(timeout: 15), problem(app))

        let enable = app.buttons["cloud.push.enable"]
        XCTAssertTrue(reveal(enable, in: app), "notifications section at the end of the list")
        enable.tap()
        let allow = springboard.alerts.firstMatch.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10), "the system asks for notifications")
        allow.tap()
        let status = app.staticTexts["cloud.push.status"]
        XCTAssertTrue(reveal(status, in: app))
        XCTAssertTrue(waitFor(status, "label == 'push registered 1'", timeout: 20), "registered with the room service: \(status.label)")
        XCTAssertFalse(enable.exists, "allowed: no button")
        shot("push registered", app)

        let driver = try await CloudHostDriver.signIn(email: email, issuer: issuer, rooms: rooms, otp: otp(for:))
        let room = try await driver.firstRoom()
        func activity(_ text: String) async throws -> String {
            let cursor = try await driver.cursor(workspace: room.workspace, room: room.room, thread: room.thread)
            _ = try await driver.send(workspace: room.workspace, room: room.room, thread: room.thread, policyRevision: room.policyRevision, text: text)
            return try await driver.eventId(workspace: room.workspace, room: room.room, thread: room.thread, after: cursor)
        }

        // In the background: the banner opens the room.
        let away = "while you were away \(run)"
        let first = try await activity(away)
        XCUIDevice.shared.press(.home)
        try await push(relay, ["workspace_id": room.workspace, "room_id": room.room, "event_id": first])
        tapBanner()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertTrue(app.textFields["cloud.composer"].waitForExistence(timeout: 15), "the tap opens the room: \(problem(app))")
        XCTAssertTrue(message(away, in: app).waitForExistence(timeout: 15), "with the activity in it")
        shot("tap from background opened the room", app)
        app.navigationBars.buttons.firstMatch.tap()

        // Not running at all: the tap launches the app into the room.
        let cold = "after a cold launch \(run)"
        let second = try await activity(cold)
        app.terminate()
        try await push(relay, ["workspace_id": room.workspace, "room_id": room.room, "event_id": second])
        tapBanner()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        XCTAssertTrue(app.textFields["cloud.composer"].waitForExistence(timeout: 20), "the tap opens the room after launch: \(problem(app))")
        XCTAssertTrue(message(cold, in: app).waitForExistence(timeout: 15))
        shot("tap from cold launch opened the room", app)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(reveal(status, in: app))

        // Off the schema (message text in the hint): not a cloud hint, so
        // the tap only brings the app back.
        XCUIDevice.shared.press(.home)
        try await push(relay, ["kind": "room_sync", "workspace_id": room.workspace, "room_id": room.room, "event_id": second, "preview": "New activity", "text": "hello"], raw: true)
        tapBanner()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertFalse(app.textFields["cloud.composer"].waitForExistence(timeout: 4), "an off-schema hint opens nothing")

        // A room this account can't see, in the foreground: still a banner
        // (not the open room); the tap syncs once, then says so.
        try await push(relay, ["workspace_id": room.workspace, "room_id": "r_missing_\(run)", "event_id": second])
        tapBanner()
        let p = app.staticTexts["cloud.problem"]
        XCTAssertTrue(waitFor(p, "label == \"that room isn't available on this account\"", timeout: 15), "unknown room: \(problem(app))")
        XCTAssertFalse(app.textFields["cloud.composer"].exists)
        shot("unknown room refused", app)
        app.swipeDown(); app.swipeDown()
        signOut(app)
        XCTAssertEqual(status.exists, false, "signed out")
    }

    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    /// The generic banner (alert body is the schema's fixed preview).
    @MainActor
    private func tapBanner() {
        let banner = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "New activity")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 15), "the push shows a banner")
        banner.tap()
        _ = waitGone(banner, timeout: 5)
    }

    /// Asks the host relay to `simctl push` one hint to this app. `raw`
    /// sends the object as given, skipping the relay's schema check.
    private func push(_ relay: URL, _ hint: [String: String], raw: Bool = false) async throws {
        var request = URLRequest(url: relay.appendingPathComponent(raw ? "push-raw" : "push"), timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: hint)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertEqual(status, 200, "relay: " + (String(data: data, encoding: .utf8) ?? ""))
    }

    /// The list is lazy: scroll until `element` is on screen.
    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        for _ in 0..<6 {
            if element.waitForExistence(timeout: 2), element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }

    private func waitFor(_ element: XCUIElement, _ format: String, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchEnvironment = [
            "BOS_CLOUD_ROOMS": "1",
            "CLOUD_ISSUER_URL": issuer.absoluteString,
            "CLOUD_ROOMS_URL": rooms.absoluteString,
        ]
        app.launch()
        let email = app.textFields["cloud.email"]
        let signOut = app.buttons["cloud.signOut"]
        let revoked = app.staticTexts["cloud.revoked"]
        _ = email.waitForExistence(timeout: 10) || signOut.exists || revoked.exists
        // A leftover account from an earlier run: sign it out first.
        if signOut.exists { signOut.tap() }
        XCTAssertTrue(email.waitForExistence(timeout: 10), "sign-in screen should show")
        return app
    }

    @MainActor
    private func signIn(_ address: String, in app: XCUIApplication) async throws {
        let email = app.textFields["cloud.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        type(address, into: email)
        app.buttons["cloud.sendCode"].tap()
        let codeField = app.textFields["cloud.code"]
        // The local issuer allows 5 code sends a minute per ip; a full suite
        // signs in more often than that, so wait out one window and resend.
        if !codeField.waitForExistence(timeout: 15), problem(app).contains("unavailable") {
            try await Task.sleep(for: .seconds(61))
            app.buttons["cloud.sendCode"].tap()
        }
        XCTAssertTrue(codeField.waitForExistence(timeout: 15), problem(app))
        let code = try await otp(for: address)
        type(code, into: codeField)
        app.buttons["cloud.verify"].tap()
        XCTAssertTrue(app.staticTexts["cloud.subject"].waitForExistence(timeout: 15), problem(app))
    }

    @MainActor
    private func signOut(_ app: XCUIApplication) {
        let button = app.buttons["cloud.signOut"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
        XCTAssertTrue(app.textFields["cloud.email"].waitForExistence(timeout: 15), "sign out should return to sign-in")
    }

    @MainActor
    private func openRoom(in app: XCUIApplication) {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'cloud.room.'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), problem(app))
        row.tap()
        XCTAssertTrue(app.textFields["cloud.composer"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["cloud.live"].waitForExistence(timeout: 15), "realtime should connect")
    }

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let composer = app.textFields["cloud.composer"]
        type(text, into: composer)
        app.buttons["cloud.send"].tap()
        let delivered = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'cloud.message.'"))
            .containing(NSPredicate(format: "label == %@", text)).firstMatch
        XCTAssertTrue(delivered.waitForExistence(timeout: 15), "message should be committed: \(problem(app))")
    }

    /// The field can still be animating in after a phase change; wait for
    /// focus before typing.
    @MainActor
    private func type(_ text: String, into field: XCUIElement) {
        for _ in 0..<5 {
            field.tap()
            if (field.value(forKey: "hasKeyboardFocus") as? Bool) == true { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        field.typeText(text)
    }

    private func otp(for address: String) async throws -> String {
        var url = URLComponents(url: issuer.appendingPathComponent("__dev/otp"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "email", value: address)]
        struct Body: Decodable { var otp: String }
        for _ in 0..<20 {
            let (data, response) = try await URLSession.shared.data(from: url.url!)
            if (response as? HTTPURLResponse)?.statusCode == 200, let body = try? JSONDecoder().decode(Body.self, from: data) {
                return body.otp
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw XCTSkip("otp sink returned nothing for \(address)")
    }

    @MainActor
    private func problem(_ app: XCUIApplication) -> String {
        let p = app.staticTexts["cloud.problem"]
        return p.exists ? p.label : ""
    }

    @MainActor
    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
