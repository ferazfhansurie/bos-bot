import Foundation
import XCTest
@testable import CompanionCore

private final class CompanionStatusStub: URLProtocol {
    static let lock = NSLock()
    static var statusCode = 200
    static var body = Data()
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.capturedRequest = request
        let code = Self.statusCode
        let body = Self.body
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: code,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func reset(status: Int, body: String) {
        lock.lock()
        statusCode = status
        self.body = Data(body.utf8)
        capturedRequest = nil
        lock.unlock()
    }

    static func captured() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequest
    }
}

final class CompanionStatusTests: XCTestCase {
    private func decode(_ json: String) throws -> CompanionStatus {
        try JSONDecoder().decode(CompanionStatus.self, from: Data(json.utf8))
    }

    func testReadyCarriesItsHostedURL() throws {
        let status = try decode(#"{"hosted":{"status":"ready","url":"https://Mac.Example.com/"},"keepAwake":true}"#)
        XCTAssertEqual(status.hosted?.state, .ready)
        XCTAssertEqual(status.hosted?.url, "https://mac.example.com")
        XCTAssertEqual(status.hostedDisplayHost, "mac.example.com")
        XCTAssertEqual(status.keepAwake, true)
    }

    func testEveryKnownStateDecodes() throws {
        for (raw, state) in [
            ("off", CompanionStatus.HostedState.off),
            ("provisioning", .provisioning),
            ("error", .error),
        ] {
            let status = try decode(#"{"hosted":{"status":"\#(raw)"},"keepAwake":false}"#)
            XCTAssertEqual(status.hosted?.state, state)
            XCTAssertNil(status.hosted?.url)
            XCTAssertEqual(status.keepAwake, false)
        }
    }

    func testUnknownStateDegradesInsteadOfFailing() throws {
        let status = try decode(#"{"hosted":{"status":"migrating"},"keepAwake":true}"#)
        XCTAssertEqual(status.hosted?.state, .unknown)
        XCTAssertEqual(status.keepAwake, true)
    }

    func testMissingAndMistypedFieldsAreTolerated() throws {
        XCTAssertEqual(try decode("{}"), CompanionStatus())
        let partial = try decode(#"{"hosted":{"url":42},"keepAwake":"yes"}"#)
        XCTAssertEqual(partial.hosted?.state, .unknown)
        XCTAssertNil(partial.hosted?.url)
        XCTAssertNil(partial.keepAwake)
        XCTAssertNil(try decode(#"{"hosted":"ready"}"#).hosted)
    }

    func testCleartextHostedURLIsNotShown() throws {
        let status = try decode(#"{"hosted":{"status":"ready","url":"http://mac.example.com"}}"#)
        XCTAssertEqual(status.hosted?.state, .ready)
        XCTAssertNil(status.hosted?.url)
    }

    // MARK: - Client

    private func client() -> CompanionClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CompanionStatusStub.self]
        return CompanionClient(
            connection: Connection(name: "Mac", host: "192.168.1.42", port: 8810),
            token: "paired-token",
            session: URLSession(configuration: configuration)
        )
    }

    func testClientFetchesTheAuthenticatedStatus() async throws {
        CompanionStatusStub.reset(status: 200, body: #"{"hosted":{"status":"provisioning"},"keepAwake":true}"#)
        let status = try await client().companionStatus()
        XCTAssertEqual(status?.hosted?.state, .provisioning)
        let request = try XCTUnwrap(CompanionStatusStub.captured())
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/companion/status")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
    }

    func testOlderDesktopIsUnknownRatherThanAnError() async throws {
        CompanionStatusStub.reset(status: 404, body: #"{"error":"Not found"}"#)
        let status = try await client().companionStatus()
        XCTAssertNil(status)
    }

    func testOtherFailuresStillThrow() async {
        CompanionStatusStub.reset(status: 500, body: #"{"error":"boom"}"#)
        do {
            _ = try await client().companionStatus()
            XCTFail("expected a thrown status")
        } catch let APIError.status(code, _) {
            XCTAssertEqual(code, 500)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

final class NetworkAwareRotationTests: XCTestCase {
    private let hosted = CompanionEndpoint(url: "https://mac.companion.example", kind: .hosted, priority: 0)!
    private let tailnet = CompanionEndpoint(url: "http://mac.tail1234.ts.net:8810", kind: .tailnet, priority: 100)!
    private let lan = CompanionEndpoint(url: "http://192.168.1.42:8810", kind: .lan, priority: 0)!

    func testLocalNetworkKeepsTheExplicitLocalRouteFirst() {
        let rotation = CandidateRotation(endpoints: [lan, hosted, tailnet], onLocalNetwork: true)
        XCTAssertEqual(rotation.endpoints, [lan, hosted, tailnet])
    }

    func testOffTheLocalNetworkProtectedRoutesLeadAndCleartextIsDropped() {
        let rotation = CandidateRotation(endpoints: [lan, hosted, tailnet], onLocalNetwork: false)
        XCTAssertEqual(rotation.currentEndpoint, hosted)
        XCTAssertEqual(rotation.endpoints, [hosted, tailnet])
    }

    func testOffTheLocalNetworkWithOnlyALocalRouteStillTriesIt() {
        let rotation = CandidateRotation(endpoints: [lan], onLocalNetwork: false)
        XCTAssertEqual(rotation.endpoints, [lan])
    }
}

final class CachedRosterTests: XCTestCase {
    private func fixtureBot() throws -> Bot {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-full", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-full", withExtension: "json")
        )
        return try XCTUnwrap(JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url)).bots.first)
    }

    private func message(_ index: Int, png: String? = nil) throws -> Message {
        var json: [String: Any] = ["id": "m\(index)", "role": "bot", "kind": "text", "at": Double(index), "text": "line \(index)"]
        if let png { json["kind"] = "screen"; json["png"] = png }
        return try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testRoundTripKeepsATranscriptTailWithoutRunState() throws {
        var bot = try fixtureBot()
        bot.busy = true
        bot.waitingOnTeammate = true
        bot.tasks = bot.tasks?.map { task in
            var task = task
            task.busy = true
            task.activity = "waiting-on-you"
            return task
        }
        var state = CompanionState()
        state.hydrate(Fleet(bots: [bot], groups: []))
        state.messages[bot.threadId] = try (0..<30).map { try message($0) } + [message(30, png: "iVBORw0KGgo=")]

        let data = try JSONEncoder().encode(CachedRoster(state: state))
        let restored = try JSONDecoder().decode(CachedRoster.self, from: data)
        var cold = CompanionState()
        cold.hydrate(restored.fleet)

        XCTAssertTrue(cold.rosterLoaded)
        XCTAssertEqual(cold.bots.map(\.id), [bot.id])
        let cachedBot = try XCTUnwrap(cold.bots.first)
        XCTAssertNil(cachedBot.busy)
        XCTAssertNil(cachedBot.waitingOnTeammate)
        XCTAssertTrue(cachedBot.tasks?.allSatisfy { $0.busy == nil && $0.activity == nil } ?? true)
        let transcript = try XCTUnwrap(cold.messages[bot.threadId])
        XCTAssertEqual(transcript.count, CachedRoster.messagesPerThread)
        XCTAssertEqual(transcript.last?.id, "m30")
        XCTAssertNil(transcript.last?.png)
        XCTAssertEqual(transcript.last?.hasImage, true)
        XCTAssertEqual(cold.hasMore[bot.threadId], true)
        XCTAssertNil(cold.cursor)
    }

    func testEmptyStateIsEmpty() {
        XCTAssertTrue(CachedRoster(state: CompanionState()).isEmpty)
    }
}
