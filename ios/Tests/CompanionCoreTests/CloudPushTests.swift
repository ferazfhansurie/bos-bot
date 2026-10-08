import Foundation
import XCTest
@testable import CompanionCore

final class CloudPushTests: XCTestCase {
    private let hint: [String: Any] = ["kind": "room_sync", "workspace_id": "w_1", "room_id": "r-2", "event_id": "e_3", "preview": "New activity"]

    // MARK: - hint

    func testDecodesTheServerHintInsideTheEnvelope() throws {
        let userInfo: [AnyHashable: Any] = ["aps": ["alert": ["body": "New activity"]], "bos_cloud": hint]
        let decoded = try XCTUnwrap(CloudPushHint(userInfo: userInfo))
        XCTAssertEqual(decoded.workspaceId, "w_1")
        XCTAssertEqual(decoded.roomId, "r-2")
        XCTAssertEqual(decoded.eventId, "e_3")
        XCTAssertEqual(decoded.notificationIdentifier, "bos.cloud.w_1.r-2.e_3")
    }

    /// Byte for byte what PushHints.build stores (services/cloud/push.ts).
    func testDecodesBuilderJSON() throws {
        let json = #"{"kind":"room_sync","workspace_id":"ws_Ab-9","room_id":"room_1","event_id":"ev_1","preview":"New activity"}"#
        XCTAssertNotNil(CloudPushHint(json: Data(json.utf8)))
    }

    func testRejectsAnythingOffSchema() {
        var cases: [[String: Any]] = []
        var extra = hint; extra["text"] = "hello bob"; cases.append(extra)
        var kind = hint; kind["kind"] = "message"; cases.append(kind)
        var preview = hint; preview["preview"] = "alice: hello"; cases.append(preview)
        var missing = hint; missing["event_id"] = nil; cases.append(missing)
        var badId = hint; badId["room_id"] = "../r"; cases.append(badId)
        var empty = hint; empty["workspace_id"] = ""; cases.append(empty)
        var long = hint; long["event_id"] = String(repeating: "a", count: 129); cases.append(long)
        var number = hint; number["room_id"] = 7; cases.append(number)
        for raw in cases {
            XCTAssertNil(CloudPushHint(fields: raw), "\(raw)")
        }
        XCTAssertNil(CloudPushHint(userInfo: ["aps": [:], "roomId": "r-2"]), "a companion shared-room push is not a cloud hint")
        XCTAssertNil(CloudPushHint(userInfo: ["bos_cloud": "\(hint)"]))
    }

    func testRouteOpensKnownRoomsAndRefreshesOnce() {
        let hint = CloudPushHint(workspaceId: "w_1", roomId: "r-2", eventId: "e_3")!
        let mine = CloudRoomRef(workspaceId: "w_1", roomId: "r-2", threadId: "t", role: .member)
        let sameRoomOtherWorkspace = CloudRoomRef(workspaceId: "w_9", roomId: "r-2", threadId: "t")
        XCTAssertEqual(CloudPushRoute.resolve(hint, in: [sameRoomOtherWorkspace, mine], synced: false), .open(mine))
        XCTAssertEqual(CloudPushRoute.resolve(hint, in: [sameRoomOtherWorkspace], synced: false), .refresh)
        XCTAssertEqual(CloudPushRoute.resolve(hint, in: [sameRoomOtherWorkspace], synced: true), .unavailable)
    }

    // MARK: - registration

    func testRequestEncodesTheServerContract() throws {
        let request = CloudPushRegistrationRequest(installationId: "inst_1", generation: CloudSequence("2")!, tokenVersion: CloudSequence("0")!)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["installation_id", "generation", "token_version", "provider", "environment", "muted", "mentions_only"])
        XCTAssertEqual(object["generation"] as? String, "2", "decimal strings, not numbers")
        XCTAssertEqual(object["token_version"] as? String, "0")
        XCTAssertEqual(object["provider"] as? String, "apns")
        XCTAssertEqual(object["environment"] as? String, "sandbox")
        XCTAssertEqual(object["muted"] as? Bool, false)
        XCTAssertNil(object["token"], "the device token never leaves the phone")
        XCTAssertEqual(CloudRoute.pushRegistrations(workspaceId: "w_1"), "/v2/workspaces/w_1/push-registrations")
        XCTAssertEqual(CloudRoute.pushRegistration(workspaceId: "w_1", registrationId: "a/b"), "/v2/workspaces/w_1/push-registrations/a%2Fb")
    }

    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func registrar() -> CloudPushRegistrar { CloudPushRegistrar(state: CloudPushState(installationId: "inst_1")) }

    private func registerAll(_ r: inout CloudPushRegistrar, _ workspaces: [String], at time: Date, lasting: TimeInterval = 7 * 86400) {
        for action in r.plan(workspaces: workspaces, authorized: true, now: time) {
            guard case .register(let w, let request) = action else { continue }
            r.registered(w, request, CloudPushRegistration(registrationId: "reg_\(w)", expiresAt: ISO8601DateFormatter().string(from: time.addingTimeInterval(lasting))), now: time)
        }
    }

    func testRegistersEachWorkspaceOnceThenHoldsUntilRenewal() {
        var r = registrar()
        XCTAssertEqual(r.plan(workspaces: ["w_a", "w_b"], authorized: false, now: now), [], "nothing without permission")
        let first = r.plan(workspaces: ["w_b", "w_a"], authorized: true, now: now)
        XCTAssertEqual(first.count, 2)
        guard case .register("w_a", let request) = first[0] else { return XCTFail("\(first)") }
        XCTAssertEqual(request.installationId, "inst_1")
        XCTAssertEqual(request.generation.rawValue, "1")
        XCTAssertEqual(request.tokenVersion.rawValue, "0")
        registerAll(&r, ["w_a", "w_b"], at: now)
        XCTAssertEqual(r.plan(workspaces: ["w_a", "w_b"], authorized: true, now: now.addingTimeInterval(60)), [])
        XCTAssertEqual(r.plan(workspaces: ["w_a", "w_b"], authorized: true, now: now.addingTimeInterval(5 * 86400)), [], "days left: hold")
        XCTAssertEqual(r.plan(workspaces: ["w_a", "w_b"], authorized: true, now: now.addingTimeInterval(6.5 * 86400)).count, 2, "under a day left: renew")
        XCTAssertEqual(r.plan(workspaces: ["w_a", "w_b"], authorized: true, now: now.addingTimeInterval(8 * 86400)).count, 2, "expired: renew")
    }

    func testShortGuestRegistrationRenewsAtMostHourly() {
        var r = registrar()
        registerAll(&r, ["w_g"], at: now, lasting: 600)
        XCTAssertEqual(r.plan(workspaces: ["w_g"], authorized: true, now: now.addingTimeInterval(60)), [], "just renewed")
        XCTAssertEqual(r.plan(workspaces: ["w_g"], authorized: true, now: now.addingTimeInterval(700)).count, 1, "ended with the session")
    }

    func testNewSessionAndNewTokenRenewWithHigherVersions() {
        var r = registrar()
        registerAll(&r, ["w_a"], at: now)
        r.tokenReceived(Data([1, 2, 3]))
        guard case .register(_, let afterToken)? = r.plan(workspaces: ["w_a"], authorized: true, now: now).first else { return XCTFail() }
        XCTAssertEqual(afterToken.tokenVersion.rawValue, "1")
        registerAll(&r, ["w_a"], at: now)
        r.tokenReceived(Data([1, 2, 3]))
        XCTAssertEqual(r.plan(workspaces: ["w_a"], authorized: true, now: now), [], "the same token again changes nothing")
        XCTAssertEqual(r.state.tokenDigest?.count, 64, "only a sha-256 digest is kept")

        r.sessionStarted()
        guard case .register(_, let afterSignIn)? = r.plan(workspaces: ["w_a"], authorized: true, now: now).first else { return XCTFail() }
        XCTAssertEqual(afterSignIn.generation.rawValue, "2")
        XCTAssertEqual(afterSignIn.tokenVersion.rawValue, "1")
    }

    func testInFlightRegistrationFromAnOldSessionStillRenews() {
        var r = registrar()
        guard case .register(let w, let stale)? = r.plan(workspaces: ["w_a"], authorized: true, now: now).first else { return XCTFail() }
        r.sessionStarted()
        r.registered(w, stale, CloudPushRegistration(registrationId: "reg", expiresAt: "2027-01-01T00:00:00.000Z"), now: now)
        XCTAssertEqual(r.plan(workspaces: ["w_a"], authorized: true, now: now).count, 1)
    }

    func testConflictStepsPastTheServerGeneration() {
        var r = registrar()
        r.conflicted("w_a")
        guard case .register(_, let request)? = r.plan(workspaces: ["w_a"], authorized: true, now: now).first else { return XCTFail() }
        XCTAssertEqual(request.generation.rawValue, "2")
    }

    func testRevokesWhatIsNoLongerWantedAndEverythingOnSignOut() {
        var r = registrar()
        registerAll(&r, ["w_a", "w_b"], at: now)
        XCTAssertEqual(r.plan(workspaces: ["w_a"], authorized: true, now: now), [.revoke(workspaceId: "w_b", registrationId: "reg_w_b")], "left the workspace")
        XCTAssertEqual(r.plan(workspaces: ["w_a", "w_b"], authorized: false, now: now), [.revoke(workspaceId: "w_a", registrationId: "reg_w_a"), .revoke(workspaceId: "w_b", registrationId: "reg_w_b")], "notifications turned off")
        XCTAssertEqual(r.revokeAll.count, 2)
        r.revoked("w_b")
        XCTAssertEqual(r.revokeAll, [.revoke(workspaceId: "w_a", registrationId: "reg_w_a")])
    }

    func testStateRoundTrips() throws {
        var r = registrar()
        r.tokenReceived(Data([9]))
        registerAll(&r, ["w_a"], at: now)
        let decoded = try JSONDecoder().decode(CloudPushState.self, from: JSONEncoder().encode(r.state))
        XCTAssertEqual(decoded, r.state)
    }
}
