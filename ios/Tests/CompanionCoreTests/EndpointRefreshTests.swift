import Foundation
import XCTest
@testable import CompanionCore

private final class EndpointRefreshRequestStub: URLProtocol {
    static let lock = NSLock()
    static var responseBody = Data()
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.capturedRequest = request
        let body = Self.responseBody
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func reset(body: Data) {
        lock.lock()
        responseBody = body
        capturedRequest = nil
        lock.unlock()
    }

    static func captured() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequest
    }
}

final class EndpointRefreshTests: XCTestCase {
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EndpointRefreshRequestStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        super.tearDown()
    }

    func testFetchesTheAuthenticatedEndpointSnapshot() async throws {
        EndpointRefreshRequestStub.reset(body: Self.fullMetadata)
        let client = CompanionClient(
            connection: Connection(name: "Mac", host: "192.168.1.42", port: 8810),
            token: "paired-token",
            session: session
        )

        let metadata = try await client.connectionMetadata()

        XCTAssertEqual(metadata.serverName, "Milind's computer")
        XCTAssertEqual(metadata.endpoints.map(\.kind), [.hosted, .tailnet, .lan])
        let request = try XCTUnwrap(EndpointRefreshRequestStub.captured())
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/companion/endpoints")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
    }

    func testRejectsAReplacementSnapshotWithNoUsableEndpoint() throws {
        let body = Data(#"{"serverName":"Mac","endpoints":[{"url":"http://public.example","kind":"tailnet","priority":0}]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(CompanionConnectionMetadata.self, from: body))
    }

    func testProtectedConnectionDoesNotDowngradeWhenHostedIsWithdrawn() throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let lan = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        var connection = Connection(
            name: "Mac",
            host: hosted.host,
            port: hosted.port,
            activeEndpoint: hosted,
            endpoints: [hosted, lan]
        )
        let metadata = try JSONDecoder().decode(
            CompanionConnectionMetadata.self,
            from: Data(#"{"serverName":"Mac","hosts":["192.168.1.42"],"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200}]}"#.utf8)
        )

        connection.reconcile(metadata)

        XCTAssertEqual(connection.activeEndpoint, hosted)
        XCTAssertEqual(connection.orderedEndpoints.map(\.url), [hosted.url, lan.url])
        XCTAssertEqual(connection.automaticEndpoints, [hosted])
    }

    func testExistingLocalPairingLearnsHostedWithoutRepairing() throws {
        let local = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        var connection = Connection(
            name: "Mac",
            host: local.host,
            port: local.port,
            activeEndpoint: local,
            endpoints: [local]
        )
        let metadata = try JSONDecoder().decode(
            CompanionConnectionMetadata.self,
            from: Self.fullMetadata
        )

        connection.reconcile(metadata)

        XCTAssertEqual(connection.activeEndpoint, local, "the live local stream is not switched underneath itself")
        XCTAssertEqual(connection.orderedEndpoints.first?.kind, .hosted, "the next launch upgrades to hosted HTTPS")

        var liveRotation = CandidateRotation(
            endpoints: [local] + connection.orderedEndpoints.filter { $0.url != local.url }
        )
        XCTAssertEqual(liveRotation.currentEndpoint, local)
        XCTAssertEqual(
            liveRotation.advanceEndpoint(after: URLError(.timedOut))?.kind,
            .hosted,
            "the current session can upgrade after its explicitly chosen local route fails"
        )
        XCTAssertTrue(liveRotation.endpoints.allSatisfy(\.protectsCredentials))
    }

    func testHostedInviteFiltersPairResponseAndRefreshToHTTPSOnly() throws {
        let routes = try Self.routes()
        var connection = Connection(
            name: "Mac",
            host: routes.hosted.host,
            port: routes.hosted.port,
            activeEndpoint: routes.hosted,
            endpoints: [routes.hosted]
        )
        connection.establishRoutePolicyFromInvite()

        connection.applyPairingAdvertisement(
            hosts: [routes.tailnet.host, routes.local.host],
            endpoints: [routes.hosted, routes.tailnet, routes.local]
        )
        XCTAssertEqual(connection.allowedRouteKinds, [.hosted])
        XCTAssertEqual(connection.allowedLocalRouteURLs, [])
        XCTAssertEqual(connection.orderedEndpoints.map(\.kind), [.hosted])
        XCTAssertEqual(connection.hosts, [])

        connection.reconcile(try Self.metadata())
        XCTAssertEqual(connection.orderedEndpoints.map(\.kind), [.hosted])
        XCTAssertEqual(connection.automaticEndpoints.map(\.kind), [.hosted])
        XCTAssertEqual(connection.hosts, [])
    }

    func testExplicitTailscaleInviteAllowsTailnetAndHostedAfterRefresh() throws {
        let routes = try Self.routes()
        var connection = Connection(
            name: "Mac",
            host: routes.tailnet.host,
            port: routes.tailnet.port,
            activeEndpoint: routes.tailnet,
            endpoints: [routes.tailnet, routes.hosted]
        )
        connection.establishRoutePolicyFromInvite()

        connection.applyPairingAdvertisement(
            hosts: [routes.tailnet.host, routes.local.host],
            endpoints: [routes.hosted, routes.tailnet, routes.local]
        )
        connection.reconcile(try Self.metadata())

        XCTAssertEqual(connection.allowedRouteKinds, [.tailnet, .hosted])
        XCTAssertEqual(connection.allowedLocalRouteURLs, [])
        XCTAssertEqual(connection.orderedEndpoints.map(\.kind), [.hosted, .tailnet])
        XCTAssertEqual(connection.automaticEndpoints.map(\.kind), [.hosted, .tailnet])
        XCTAssertEqual(connection.hosts, [routes.tailnet.host])
    }

    func testExplicitLocalInviteNeverLearnsTailscaleOrAnotherLANOrigin() throws {
        let routes = try Self.routes()
        var connection = Connection(
            name: "Mac",
            host: routes.local.host,
            port: routes.local.port,
            activeEndpoint: routes.local,
            endpoints: [routes.local, routes.tailnet, routes.hosted, routes.otherLocal]
        )
        connection.establishRoutePolicyFromInvite()

        connection.applyPairingAdvertisement(
            hosts: [routes.tailnet.host, routes.local.host],
            endpoints: [routes.hosted, routes.tailnet, routes.otherLocal, routes.local]
        )
        let refreshed = try JSONDecoder().decode(
            CompanionConnectionMetadata.self,
            from: Data(#"{"serverName":"Mac","hosts":["192.168.1.99","192.168.1.42","mac.tail1234.ts.net"],"endpoints":[{"url":"http://192.168.1.99:8810","kind":"lan","priority":50},{"url":"http://mac.tail1234.ts.net:8810","kind":"tailnet","priority":100},{"url":"http://192.168.1.42:8810","kind":"lan","priority":200},{"url":"https://mac.companion.example","kind":"hosted","priority":0}]}"#.utf8)
        )
        connection.reconcile(refreshed)

        XCTAssertEqual(connection.allowedRouteKinds, [.lan, .hosted])
        XCTAssertEqual(connection.allowedLocalRouteURLs, [routes.local.url])
        XCTAssertFalse(connection.orderedEndpoints.contains { $0.kind == .tailnet })
        XCTAssertEqual(connection.orderedEndpoints.map(\.kind), [.hosted, .lan])
        XCTAssertFalse(connection.orderedEndpoints.contains { $0.url == routes.otherLocal.url })
        XCTAssertEqual(connection.hosts, [routes.local.host])
    }

    func testSavedConnectionWithoutPolicyRetainsLegacyProtectedFailover() throws {
        let data = Data(#"""
        {
          "id":"legacy","name":"Mac","host":"mac.companion.example","port":443,
          "activeEndpoint":{"url":"https://mac.companion.example","kind":"hosted","priority":0},
          "endpoints":[
            {"url":"https://mac.companion.example","kind":"hosted","priority":0},
            {"url":"http://mac.tail1234.ts.net:8810","kind":"tailnet","priority":100}
          ]
        }
        """#.utf8)
        var connection = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertNil(connection.allowedRouteKinds)
        XCTAssertNil(connection.allowedLocalRouteURLs)

        connection.reconcile(try Self.metadata())

        XCTAssertEqual(connection.automaticEndpoints.map(\.kind), [.hosted, .tailnet])
    }

    private static func metadata() throws -> CompanionConnectionMetadata {
        try JSONDecoder().decode(CompanionConnectionMetadata.self, from: fullMetadata)
    }

    private static func routes() throws -> (
        hosted: CompanionEndpoint,
        tailnet: CompanionEndpoint,
        local: CompanionEndpoint,
        otherLocal: CompanionEndpoint
    ) {
        (
            try XCTUnwrap(CompanionEndpoint(
                url: "https://mac.companion.example", kind: .hosted, priority: 0
            )),
            try XCTUnwrap(CompanionEndpoint(
                url: "http://mac.tail1234.ts.net:8810", kind: .tailnet, priority: 100
            )),
            try XCTUnwrap(CompanionEndpoint(
                url: "http://192.168.1.42:8810", kind: .lan, priority: 200
            )),
            try XCTUnwrap(CompanionEndpoint(
                url: "http://192.168.1.99:8810", kind: .lan, priority: 150
            ))
        )
    }

    private static let fullMetadata = Data(
        #"{"serverName":"Milind's computer","hosts":["mac.tail1234.ts.net","192.168.1.42"],"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200},{"url":"http://not-a-tailnet.example:8810","kind":"tailnet","priority":50},{"url":"http://mac.tail1234.ts.net:8810","kind":"tailnet","priority":100},{"url":"https://mac.companion.example","kind":"hosted","priority":0}]}"#.utf8
    )
}
