import Foundation
import XCTest
@testable import CompanionCore

/// The acceptance driver provides a private config for its owned local issuer.
/// No stub transport and no app/keychain state are used.
final class CloudIdentityLiveGateTests: XCTestCase {
    func testDroppedValidationResponseKeepsStoredBearerAndRetries() async throws {
        guard let path = ProcessInfo.processInfo.environment["CLOUD_IDENTITY_GATE_CONFIG"] else {
            throw XCTSkip("owned real-issuer config required")
        }
        struct Config: Decodable {
            var issuer: URL
            var rooms: URL
            var bearer: String
            var identity: CloudIdentity
            var receipt: String
        }
        let config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        for url in [config.issuer, config.rooms] {
            XCTAssertEqual(url.scheme, "http")
            XCTAssertEqual(url.host, "127.0.0.1")
        }
        let suite = "cloud-identity-live-gate-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MemoryCredentialStore()
        try store.save(config.bearer, for: config.identity.key)
        defaults.set(try JSONEncoder().encode(config.identity), forKey: "cloud.currentIdentity")
        let coordinator = CloudIdentityCoordinator(issuer: CloudIssuerClient(baseURL: config.issuer),
            roomsURL: config.rooms, store: store, defaults: defaults)
        _ = try await coordinator.restore()
        let lost = await coordinator.validate()
        let kept: CloudIdentity
        let lossState: String
        switch lost {
        case .unavailable(let identity, _): kept = identity; lossState = "unavailable"
        // URLSession can transparently retry an idempotent GET after a TCP
        // reset. That valid retry still must use the stored bearer.
        case .signedIn(let identity): kept = identity; lossState = "signed_in_after_transport_retry"
        default: return XCTFail("response loss must retain the current identity")
        }
        XCTAssertEqual(kept, config.identity)
        let afterLoss = try await coordinator.bearer()
        XCTAssertEqual(afterLoss, config.bearer)
        XCTAssertEqual(try store.bearer(for: kept.key), config.bearer)
        let recovered = await coordinator.validate()
        XCTAssertEqual(recovered, .signedIn(config.identity))
        let afterRetry = try await coordinator.bearer()
        XCTAssertEqual(afterRetry, config.bearer)
        let receipt: [String: Any] = ["native_coordinator": true, "transport": "URLSession",
            "post_loss_state": lossState, "stored_bearer_retained": afterLoss == config.bearer,
            "retry_signed_in": recovered == .signedIn(config.identity), "retry_same_bearer": afterRetry == config.bearer]
        try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: config.receipt), options: .atomic)
    }
}
