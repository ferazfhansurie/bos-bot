import Foundation
import XCTest
@testable import CompanionCore

private final class AuthorityMovedStub: URLProtocol {
    static var statusCode = 200
    static var body = Data("{}".utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class AuthorityEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [WriteAuthority] = []
    var all: [WriteAuthority] { lock.withLock { stored } }
    func append(_ event: WriteAuthority) { lock.withLock { stored.append(event) } }
}

final class AuthorityMovedTests: XCTestCase {
    private static let movedBody = #"{"error":"authority_moved","workspace_id":"ws_123","epoch":"7"}"#

    // MARK: - The error itself

    func testOnly409WithTheAuthorityMovedCodeWordCounts() {
        XCTAssertTrue(APIError.status(code: 409, message: "authority_moved").isAuthorityMoved)
        XCTAssertFalse(APIError.status(code: 409, message: "The bot is busy.").isAuthorityMoved)
        XCTAssertFalse(APIError.status(code: 409, message: nil).isAuthorityMoved)
        XCTAssertFalse(APIError.status(code: 400, message: "authority_moved").isAuthorityMoved)
        XCTAssertFalse(APIError.transport("authority_moved").isAuthorityMoved)
    }

    func testAuthorityMovedReadsAsASentenceAndOther409sAreUnchanged() {
        let moved = APIError.status(code: 409, message: "authority_moved").errorDescription
        XCTAssertEqual(moved, "This computer’s chats moved to BOS cloud. They’re read-only here now; keep chatting in Cloud rooms.")
        XCTAssertFalse(moved?.contains("authority_moved") ?? true)
        XCTAssertEqual(APIError.status(code: 409, message: "The bot is busy.").errorDescription, "The bot is busy.")
        XCTAssertEqual(APIError.status(code: 409, message: nil).errorDescription, "The bot is busy — stop it first.")
    }

    func testCheckDecodesTheMovedBodyWithItsExtraFields() throws {
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "http://127.0.0.1:8810/api/bots/b/messages")!,
            statusCode: 409, httpVersion: "HTTP/1.1", headerFields: nil
        ))
        XCTAssertThrowsError(try CompanionClient.check(response, Data(Self.movedBody.utf8))) { error in
            XCTAssertTrue((error as? APIError)?.isAuthorityMoved == true)
        }
    }

    // MARK: - The observer

    private func client(status: Int, body: String, events: AuthorityEvents) -> (CompanionClient, URLSession) {
        AuthorityMovedStub.statusCode = status
        AuthorityMovedStub.body = Data(body.utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthorityMovedStub.self]
        let session = URLSession(configuration: configuration)
        var client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
        client.authorityObserver = { events.append($0) }
        return (client, session)
    }

    func testRefusedWriteReportsMovedAndAcceptedSendReportsAccepted() async throws {
        let events = AuthorityEvents()
        let (refusing, refusingSession) = client(status: 409, body: Self.movedBody, events: events)
        defer { refusingSession.invalidateAndCancel() }
        do {
            _ = try await refusing.send(text: "hi", toBot: "bot-1")
            XCTFail("expected the write to be refused")
        } catch let error as APIError {
            XCTAssertTrue(error.isAuthorityMoved)
        }
        XCTAssertEqual(events.all, [.moved])

        let (accepting, acceptingSession) = client(status: 200, body: "{}", events: events)
        defer { acceptingSession.invalidateAndCancel() }
        _ = try await accepting.send(text: "hi", toBot: "bot-1")
        XCTAssertEqual(events.all, [.moved, .accepted])
    }

    func testOrdinaryBusy409DoesNotReportMoved() async {
        let events = AuthorityEvents()
        let (busy, session) = client(status: 409, body: #"{"error":"The bot is busy."}"#, events: events)
        defer { session.invalidateAndCancel() }
        _ = try? await busy.send(text: "hi", toBot: "bot-1")
        XCTAssertEqual(events.all, [])
    }
}
