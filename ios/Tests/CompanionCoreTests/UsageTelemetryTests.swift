import XCTest
@testable import CompanionCore

@MainActor final class UsageTelemetryTests: XCTestCase {
    func testLifecyclePayloadAndDurableIdentity() async throws {
        var stored: Data?
        var bodies: [Data] = []
        let make = { UsageTelemetry(version: "2.1.3", load: { stored }, save: { stored = $0 }, authorize: { .allowed }, post: { bodies.append($0); return true }) }
        let telemetry = make()
        telemetry.foreground()
        telemetry.foreground()
        await telemetry.flush()
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["install_id", "version", "platform", "events"])
        XCTAssertEqual(body["platform"] as? String, "ios")
        let events = try XCTUnwrap(body["events"] as? [[String: Any]])
        XCTAssertEqual(events.compactMap { $0["name"] as? String }, ["install", "open"])
        XCTAssertTrue(events.allSatisfy { ($0["props"] as? [String: String]) == [:] && ISO8601DateFormatter().date(from: $0["at"] as? String ?? "") != nil })
        let next = make()
        next.foreground()
        await next.flush()
        let second = try XCTUnwrap(JSONSerialization.jsonObject(with: bodies[1]) as? [String: Any])
        XCTAssertEqual(body["install_id"] as? String, second["install_id"] as? String)
        XCTAssertEqual((second["events"] as? [[String: Any]])?.count, 1)
    }
    func testOptOutAndUnavailablePolicyNeverPost() async {
        var posts = 0
        var policy = UsageTelemetryPolicy.unavailable
        let telemetry = UsageTelemetry(version: "test", load: { nil }, save: { _ in }, authorize: { policy }, post: { _ in posts += 1; return true })
        telemetry.foreground()
        await telemetry.flush()
        XCTAssertEqual(posts, 0)
        policy = .denied
        await telemetry.flush()
        policy = .allowed
        await telemetry.flush()
        XCTAssertEqual(posts, 0, "server opt-out purges queued events")
        telemetry.setEnabled(false)
        telemetry.record(.pairSuccess)
        await telemetry.flush()
        XCTAssertEqual(posts, 0)
    }
    func testBoundedOfflineQueueAndFiftyEventBatches() async throws {
        var succeed = false
        var counts: [Int] = []
        let telemetry = UsageTelemetry(version: "test", load: { nil }, save: { _ in }, authorize: { .allowed }, post: { body in
            let json = try! JSONSerialization.jsonObject(with: body) as! [String: Any]
            counts.append((json["events"] as! [Any]).count)
            return succeed
        })
        for _ in 0..<300 { telemetry.record(.pairSuccess) }
        await telemetry.flush()
        XCTAssertEqual(counts, [50])
        succeed = true
        for _ in 0..<5 { await telemetry.flush() }
        XCTAssertEqual(counts, [50, 50, 50, 50, 50])
    }
    func testEnvironmentAndServerPolicyFailClosed() throws {
        for json in ["{}", "{\"enabled\":false}", "{\"enabled\":true,\"disabledByEnv\":true}"] {
            XCTAssertFalse(try JSONDecoder().decode(AnonymousUsagePolicy.self, from: Data(json.utf8)).allowsTelemetry)
        }
        XCTAssertTrue(try JSONDecoder().decode(AnonymousUsagePolicy.self, from: Data("{\"enabled\":true,\"disabledByEnv\":false}".utf8)).allowsTelemetry)
        XCTAssertFalse(UsageTelemetry.environmentAllows(["BOS_NO_PING": "1"]))
    }

    func testBackgroundFlushAndNextForegroundOpen() async throws {
        var names: [[String]] = []
        let telemetry = UsageTelemetry(version: "test", load: { nil }, save: { _ in }, authorize: { .allowed }, post: { data in
            let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            names.append((body["events"] as! [[String: Any]]).map { $0["name"] as! String })
            return true
        })
        telemetry.foreground()
        await telemetry.background()
        telemetry.foreground()
        await telemetry.background()
        XCTAssertEqual(names, [["install", "open"], ["open"]])
    }

    func testDisabledEnvironmentNeverAuthorizesOrPosts() async {
        var attempts = 0
        let telemetry = UsageTelemetry(version: "test", load: { nil }, save: { _ in }, environment: ["BOS_NO_PING": "1"], authorize: { attempts += 1; return .allowed }, post: { _ in attempts += 1; return true })
        telemetry.foreground()
        telemetry.setEnabled(true)
        telemetry.record(.pairSuccess)
        await telemetry.background()
        XCTAssertEqual(attempts, 0)
    }

    func testPushReceiptRequiresDeliveryConfiguration() throws {
        let receipt = try JSONDecoder().decode(CompanionClient.PushRegistrationReceipt.self, from: Data("{\"registered\":true,\"deliveryConfigured\":false}".utf8))
        XCTAssertEqual(receipt.registered, true)
        XCTAssertEqual(receipt.deliveryConfigured, false)
        let legacy = try JSONDecoder().decode(CompanionClient.PushRegistrationReceipt.self, from: Data("{}".utf8))
        XCTAssertNil(legacy.deliveryConfigured)
    }

    func testQueueOverflowDuringSendKeepsNewEvents() async {
        var sends = 0
        var telemetry: UsageTelemetry!
        telemetry = UsageTelemetry(version: "test", load: { nil }, save: { _ in }, authorize: { .allowed }, post: { _ in
            sends += 1
            if sends == 1 { for _ in 0..<300 { telemetry.record(.pairSuccess) } }
            return true
        })
        telemetry.record(.pairSuccess)
        for _ in 0..<6 { await telemetry.flush() }
        XCTAssertEqual(sends, 5, "in-flight success must not remove new events after overflow")
    }
}
