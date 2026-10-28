import Foundation
import XCTest
@testable import CompanionCore

private final class ConnectorCardStub: URLProtocol {
    static var requests: [(URLRequest, Data?)] = []
    static var responseBody = Data("{}".utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            body = data
        }
        Self.requests.append((request, body))
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ConnectorCardsTests: XCTestCase {
    func testConnectorMessageDecodesItsCard() throws {
        let json = #"{"id":"m1","role":"bot","kind":"connector","at":1,"text":"cash needs Gmail","connector":{"slug":"gmail","label":"Gmail","description":"cash needs Gmail to read your inbox","status":"authorizing","resumeKey":"k","reason":"to read your inbox","reconnect":true}}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        let card = try XCTUnwrap(message.connector)
        XCTAssertEqual(card.slug, "gmail")
        XCTAssertEqual(card.status, .authorizing)
        XCTAssertEqual(card.reconnect, true)
        XCTAssertEqual(card.detail(v3: true), "Waiting for sign-in…")
    }

    func testUnknownStatusReadsAsRequired() throws {
        let card = try JSONDecoder().decode(ConnectorCardData.self, from: Data(#"{"slug":"x","label":"X","status":"later"}"#.utf8))
        XCTAssertEqual(card.status, .required)
    }

    func testDetailWording() {
        var card = ConnectorCardData(slug: "slack", label: "Slack", description: "cash needs Slack", reconnect: true)
        XCTAssertEqual(card.detail(v3: true), "Slack needs signing in again")
        XCTAssertEqual(card.detail(v3: false), "cash needs Slack")
        card.status = .connected
        XCTAssertEqual(card.detail(v3: true), "Connected securely. Continue the paused task when you're ready.")
        card.resumed = true
        XCTAssertEqual(card.detail(v3: true), "Connected securely. Your bot is continuing the task.")
    }

    func testAfterConnectActionsOnlyOnceConnectedAndResumedInV3() {
        var card = ConnectorCardData(slug: "googlemail", label: "Gmail", status: .connected)
        XCTAssertEqual(card.afterConnectActions(v3: true), [])
        card.resumed = true
        XCTAssertEqual(card.afterConnectActions(v3: false), [])
        XCTAssertEqual(card.afterConnectActions(v3: true).first, "summarise my unread email")
    }

    func testActionsMatchTheSharedTable() {
        XCTAssertEqual(ConnectActions.actions(slug: "Meta_Ads", label: nil).first, "how are my ads doing this week?")
        XCTAssertEqual(ConnectActions.actions(slug: "gcal", label: nil).first, "what's on my calendar today?")
        XCTAssertEqual(ConnectActions.actions(slug: "hubspot", label: "HubSpot"), [
            "what can you do with hubspot now?",
            "check hubspot for anything that needs me",
            "every morning, brief me on what's new in hubspot",
        ])
        XCTAssertEqual(ConnectActions.actions(slug: " ", label: "  ").first, "what can you do with this app now?")
    }

    func testCardCallsHitTheThreadsCard() async throws {
        ConnectorCardStub.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectorCardStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810), token: "t", session: session)

        ConnectorCardStub.responseBody = Data(#"{"url":"https://connect.composio.dev/link/abc"}"#.utf8)
        guard case let .signIn(url) = try await client.authorizeConnectorCard(botId: "bot-1", threadId: "th-1", messageId: "m-1")
        else { return XCTFail("expected a sign-in page") }
        XCTAssertEqual(url.host, "connect.composio.dev")

        ConnectorCardStub.responseBody = Data(#"{"native":true,"whatsapp":{"state":"qr_pending"}}"#.utf8)
        guard case .native = try await client.authorizeConnectorCard(botId: "bot-1", threadId: "th-1", messageId: "m-1")
        else { return XCTFail("expected native whatsapp") }

        ConnectorCardStub.responseBody = Data(#"{"url":"http://plain.example"}"#.utf8)
        do {
            _ = try await client.authorizeConnectorCard(botId: "bot-1", threadId: "th-1", messageId: "m-1")
            XCTFail("a non-https sign-in page must not open")
        } catch {}

        ConnectorCardStub.responseBody = Data(#"{"connected":true,"pending":false,"status":"connected"}"#.utf8)
        let status = try await client.connectorCardStatus(botId: "bot-1", threadId: "th-1", messageId: "m-1")
        XCTAssertTrue(status.connected)

        ConnectorCardStub.responseBody = Data("{}".utf8)
        try await client.resumeConnectorCard(botId: "bot-1", threadId: "th-1", messageId: "m-1")
        try await client.dismissConnectorCard(botId: "bot-1", threadId: "th-1", messageId: "m-1")

        let paths = ConnectorCardStub.requests.map { "\($0.0.httpMethod ?? "") \($0.0.url?.path ?? "")" }
        XCTAssertEqual(paths, [
            "POST /api/bots/bot-1/connector-cards/m-1/authorize",
            "POST /api/bots/bot-1/connector-cards/m-1/authorize",
            "POST /api/bots/bot-1/connector-cards/m-1/authorize",
            "GET /api/bots/bot-1/connector-cards/m-1/status",
            "POST /api/bots/bot-1/connector-cards/m-1/resume",
            "POST /api/bots/bot-1/connector-cards/m-1/dismiss",
        ])
        XCTAssertEqual(ConnectorCardStub.requests[3].0.url?.query, "threadId=th-1")
        let body = try XCTUnwrap(ConnectorCardStub.requests[4].1)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["threadId": "th-1"])
    }
}

final class CardsPreviewFixtureTests: XCTestCase {
    /// The `-cards-preview` thread (App/CardsPreview.json) must decode, or the
    /// simulator fixture silently shows nothing.
    func testFixtureDecodes() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/CardsPreview.json")
        let messages = try JSONDecoder().decode([Message].self, from: Data(contentsOf: url))
        XCTAssertEqual(messages.count, 17)
        XCTAssertEqual(messages.compactMap(\.connector).count, 5)
        XCTAssertTrue(messages.contains { $0.text?.contains("SettingChange(") == true })
    }
}
