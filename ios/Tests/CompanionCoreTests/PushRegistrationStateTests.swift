import XCTest
@testable import CompanionCore

final class PushRegistrationStateTests: XCTestCase {
    func testClientUsesDeliveryCapabilityAndAcceptsLegacyEmptyAcknowledgement() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushRegistrationStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "fixture", host: "127.0.0.1", port: 8810), token: "fixture", session: session)
        for (body, expected) in [(#"{"deliveryConfigured":false}"#, PushRegistrationState.deliveryUnavailable), ("", .registered), ("{}", .registered)] {
            PushRegistrationStub.body = Data(body.utf8)
            let response = try await client.registerPushToken("fixture-device-token", environment: "sandbox")
            XCTAssertEqual(response.state, expected)
        }
    }

    func testServerWithoutPushDeliveryNeverClaimsRegistered() throws {
        let response = try JSONDecoder().decode(PushTokenRegistrationResponse.self, from: Data(#"{"ok":true,"deliveryConfigured":false}"#.utf8))
        XCTAssertEqual(response.state, .deliveryUnavailable)
        XCTAssertEqual(PushRegistrationState.summary([response.state]), "Push not set up on this BOS")
        XCTAssertEqual(PushRegistrationState.summary([.registered, response.state]), "Partly registered")
    }

    func testOldServersCanAcknowledgeWithoutAdvertisingDelivery() throws {
        for json in [#"{"ok":true}"#, #"{"ok":true,"deliveryConfigured":true}"#] {
            let response = try JSONDecoder().decode(PushTokenRegistrationResponse.self, from: Data(json.utf8))
            XCTAssertEqual(response.state, .registered)
        }
    }

    func testPermissionWithoutServerAcknowledgementNeverClaimsReady() {
        XCTAssertEqual(PushRegistrationState.summary([]), "Connect a computer")
        XCTAssertEqual(PushRegistrationState.summary([.notRegistered]), "Awaiting registration")
        XCTAssertEqual(PushRegistrationState.summary([.failed]), "Setup needs retry")
    }
    func testEveryComputerMustAcknowledge() {
        XCTAssertEqual(PushRegistrationState.summary([.registered, .failed]), "Partly registered")
        XCTAssertEqual(PushRegistrationState.summary([.registered, .notRegistered]), "Partly registered")
        XCTAssertEqual(PushRegistrationState.summary([.registered, .registered]), "Registered")
        XCTAssertEqual(PushRegistrationState.summary([.registered, .registering]), "Setting up")
    }
}

private final class PushRegistrationStub: URLProtocol {
    static var body = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.body.isEmpty ? 204 : 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
