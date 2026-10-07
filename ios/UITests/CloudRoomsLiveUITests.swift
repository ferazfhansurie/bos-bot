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
