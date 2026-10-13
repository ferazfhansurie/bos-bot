import Foundation
import XCTest
@testable import CompanionCore

private final class InboxRequestStub: URLProtocol {
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class InboxClientTests: XCTestCase {
    var session: URLSession!
    var client: CompanionClient!
    override func setUp() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [InboxRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(connection: Connection(name: "Fixture", host: "127.0.0.1", port: 8810), token: "fixture", session: session)
        InboxRequestStub.capturedRequest = nil
        InboxRequestStub.capturedBody = nil
        InboxRequestStub.responseBody = Data("{}".utf8)
    }
    override func tearDown() { session.invalidateAndCancel() }
    func testSteerPinsTheBotThread() async throws {
        try await client.steerQueued(queueId: "queue-1", to: .bot(id: "bot-1", threadId: "thread-2"))
        XCTAssertEqual(InboxRequestStub.capturedRequest?.url?.path, "/api/bots/bot-1/queue/queue-1/steer")
        XCTAssertEqual(InboxRequestStub.capturedRequest?.httpMethod, "POST")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(InboxRequestStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(body["threadId"] as? String, "thread-2")
        XCTAssertEqual(body["interrupt"] as? Bool, true)
    }
    func testRoomSteerNamesTheMemberItMustReach() async throws {
        try await client.steerQueued(queueId: "queue-1", to: .room(id: "room-1", threadId: "thread-2"), botId: "pix")
        XCTAssertEqual(InboxRequestStub.capturedRequest?.url?.path, "/api/groups/room-1/queue/queue-1/steer")
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(InboxRequestStub.capturedBody)) as! [String: String]
        XCTAssertEqual(body, ["threadId": "thread-2", "botId": "pix"])
    }
    func testSteerRejectsRouteInjectionBeforeSending() async {
        do {
            try await client.steerQueued(queueId: "../other", to: .bot(id: "bot-1", threadId: "thread-2"))
            XCTFail("unsafe route accepted")
        } catch {}
        XCTAssertNil(InboxRequestStub.capturedRequest)
    }
    func testSettlementPersistsOffAndPreservesConcurrency() async throws {
        InboxRequestStub.responseBody = Data(#"{"threads":{"maxConcurrentPerBot":4,"autoSettleDays":0}}"#.utf8)
        let config = try await client.setThreadSettlement(days: 0)
        XCTAssertEqual(config.threads?.autoSettleDays, 0)
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(InboxRequestStub.capturedBody)) as! [String: [String: Int]]
        XCTAssertEqual(body["threads"], ["maxConcurrentPerBot": 4, "autoSettleDays": 0])
    }
    func testMissingSettlementSettingUsesDefaultAtTheView() throws {
        let config = try JSONDecoder().decode(ConfigStatus.self, from: Data("{}".utf8))
        XCTAssertNil(config.threads)
    }
}
