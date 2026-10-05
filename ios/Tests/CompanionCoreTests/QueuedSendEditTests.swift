// Editing a held send: only typed words change, every paste and attachment
// stays byte for byte, and every refusal keeps the entry exactly as held.
import XCTest
@testable import CompanionCore

private final class QueuedEditStub: URLProtocol {
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?
    static var statusCode = 200
    static var responseBody = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = request.httpBody ?? request.httpBodyStream.map { stream in
            stream.open(); defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            return data
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class QueuedSendEditTests: XCTestCase {
    private let image = #"<attached-image path="/tmp/a.png" name="a.png" />"#
    private let file = #"<attached-file path="/tmp/b.pdf" />"#
    private let paste = "<pasted-text index=\"1\">\nline one\nline two\n</pasted-text>"

    // MARK: - Draft

    func testPlainTextIsOneFieldAndRebuildsExactly() {
        let draft = QueuedSendDraft(QueuedSend(queueId: "q1", text: "fix the header"))
        XCTAssertEqual(draft.fields, ["fix the header"])
        XCTAssertEqual(draft.text(with: draft.fields), "fix the header")
        XCTAssertEqual(draft.text(with: ["fix the footer"]), "fix the footer")
        XCTAssertEqual(draft.problem(with: draft.fields), .unchanged)
        XCTAssertNil(draft.problem(with: ["fix the footer"]))
    }

    func testAttachmentsAndPastesAreKeptByteForByte() {
        let text = "look at these\n\n\(paste)\n\n\(image)\n\n\(file)"
        let draft = QueuedSendDraft(QueuedSend(queueId: "q1", text: text))
        XCTAssertEqual(draft.fields, ["look at these"])
        XCTAssertEqual(draft.attachments.map(\.name), ["a.png", "b.pdf"])
        XCTAssertEqual(draft.pastes.count, 1)
        XCTAssertEqual(draft.text(with: draft.fields), text)
        let edited = draft.text(with: ["look closer"])
        XCTAssertEqual(edited, "look closer\n\n\(paste)\n\n\(image)\n\n\(file)")
        XCTAssertNil(draft.problem(with: ["look closer"]))
    }

    func testTypedTextOnBothSidesOfAFileStaysInPlace() {
        let text = "before\n\(image)\nafter"
        let draft = QueuedSendDraft(QueuedSend(queueId: "q1", text: text))
        XCTAssertEqual(draft.fields, ["before", "after"])
        XCTAssertEqual(draft.text(with: ["one", "two"]), "one\n\(image)\ntwo")
    }

    func testFileOnlySendGetsANewLeadingField() {
        let draft = QueuedSendDraft(QueuedSend(queueId: "q1", text: image))
        XCTAssertEqual(draft.fields, [""])
        XCTAssertEqual(draft.text(with: [""]), image)
        XCTAssertEqual(draft.text(with: ["caption"]), "caption\n\n\(image)")
        XCTAssertEqual(draft.problem(with: [""]), .unchanged)
    }

    func testTagInsideACodeFenceIsTypedTextNotAFile() {
        let text = "```\n\(image)\n```"
        let draft = QueuedSendDraft(QueuedSend(queueId: "q1", text: text))
        XCTAssertTrue(draft.attachments.isEmpty)
        XCTAssertEqual(draft.fields, [text])
    }

    func testAnEditCannotAddDropOrSwallowAFile() {
        let draft = QueuedSendDraft(QueuedSend(queueId: "q1", text: "hi\n\n\(image)"))
        XCTAssertEqual(draft.problem(with: ["hi\n\(file)"]), .changesAttachments)
        // An unclosed fence would hide the kept tag from every reader.
        XCTAssertEqual(draft.problem(with: ["```"]), .changesAttachments)
    }

    func testEmptyingAPlainSendIsRefused() {
        let draft = QueuedSendDraft(QueuedSend(queueId: "q1", text: "hello"))
        XCTAssertEqual(draft.problem(with: ["   "]), .empty)
    }

    // MARK: - Errors

    func testErrorMappingNeverReadsAnOldComputerAsDrained() {
        XCTAssertEqual(QueuedSendEditError.from(APIError.status(code: 404, message: "no such queued message")), .gone)
        XCTAssertEqual(QueuedSendEditError.from(APIError.status(code: 404, message: "not found")), .unsupported)
        XCTAssertEqual(QueuedSendEditError.from(APIError.status(code: 404, message: nil)), .unsupported)
        XCTAssertEqual(QueuedSendEditError.from(APIError.status(code: 405, message: nil)), .unsupported)
        XCTAssertEqual(QueuedSendEditError.from(APIError.status(code: 409, message: "changed")), .changed)
        XCTAssertEqual(QueuedSendEditError.from(APIError.status(code: 401, message: nil)), .unauthorized)
        XCTAssertEqual(QueuedSendEditError.from(APIError.status(code: 403, message: "revoked")), .refused("revoked"))
        XCTAssertTrue(QueuedSendEditError.from(APIError.transport("offline")).isRetryable)
        XCTAssertFalse(QueuedSendEditError.gone.isRetryable)
    }

    func testARetriedEditThatAlreadyLandedIsRecognised() {
        XCTAssertTrue(QueuedSendEditError.landed("new", live: QueuedSend(queueId: "q1", text: "new")))
        XCTAssertFalse(QueuedSendEditError.landed("new", live: QueuedSend(queueId: "q1", text: "other")))
        XCTAssertFalse(QueuedSendEditError.landed("new", live: nil))
    }

    // MARK: - State

    func testAcceptedEditReplacesInPlaceAndKeepsOrder() {
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "one"), threadId: "t")
        state.rememberQueued(QueuedSend(queueId: "q2", text: "two", reason: "capacity"), threadId: "t")
        state.rememberQueued(QueuedSend(queueId: "q3", text: "three"), threadId: "t")
        XCTAssertTrue(state.applyQueuedEdit(QueuedSend(queueId: "q2", text: "TWO"), threadId: "t"))
        XCTAssertEqual(state.pendingQueued["t"]?.map(\.queueId), ["q1", "q2", "q3"])
        XCTAssertEqual(state.pendingQueued["t"]?[1].text, "TWO")
        XCTAssertEqual(state.pendingQueued["t"]?[1].reason, "capacity")
    }

    func testEditForADrainedOrForeignRowChangesNothing() {
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "one"), threadId: "t")
        state.consumeQueued(queueId: "q1", threadId: "t")
        XCTAssertFalse(state.applyQueuedEdit(QueuedSend(queueId: "q1", text: "late"), threadId: "t"))
        XCTAssertNil(state.pendingQueued["t"])
        state.rememberQueued(QueuedSend(queueId: "q2", text: "two"), threadId: "t")
        XCTAssertFalse(state.applyQueuedEdit(QueuedSend(queueId: "q2", text: "x"), threadId: "other-thread"))
        XCTAssertEqual(state.pendingQueued["t"]?.first?.text, "two")
    }

    // MARK: - Client

    private func client() -> (CompanionClient, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [QueuedEditStub.self]
        let session = URLSession(configuration: configuration)
        return (CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810),
                                token: "paired-token", session: session), session)
    }

    override func setUp() {
        super.setUp()
        QueuedEditStub.capturedRequest = nil
        QueuedEditStub.capturedBody = nil
        QueuedEditStub.statusCode = 200
        QueuedEditStub.responseBody = Data(#"{"ok":true,"queueId":"q1","threadId":"t","text":"n"}"#.utf8)
    }

    /// The editor reads every refusal of the shared client as an edit error,
    /// and a computer without the route is never mistaken for a drained entry.
    func testClientRefusalsMapToEditErrorsThatKeepTheEdit() async {
        let cases: [(Int, String, QueuedSendEditError)] = [
            (404, #"{"error":"Not found"}"#, .unsupported),
            (405, #"{"error":"method not allowed"}"#, .unsupported),
            (409, #"{"error":"queued message changed or is no longer waiting; edits were not saved","code":"queue_edit_conflict"}"#, .changed),
            (200, #"{"ok":true,"queueId":"q9","threadId":"t","text":"n"}"#, .changed),
            (403, #"{"error":"only the workspace owner can edit queued messages"}"#,
             .refused("only the workspace owner can edit queued messages")),
        ]
        for (code, body, expected) in cases {
            QueuedEditStub.statusCode = code
            QueuedEditStub.responseBody = Data(body.utf8)
            let (client, session) = client()
            do {
                try await client.editQueued(queueId: "q1", to: .bot(id: "b", threadId: "t"), expectedText: "o", text: "n")
                XCTFail("\(code) should throw")
            } catch {
                let mapped = QueuedSendEditError.from(error)
                XCTAssertEqual(mapped, expected, "\(code) \(body)")
                XCTAssertFalse(mapped.isRetryable, "\(code) must not offer a retry")
            }
            XCTAssertEqual(QueuedEditStub.capturedRequest?.httpMethod, "PATCH", "never a new send")
            session.invalidateAndCancel()
        }
    }

    func testAcceptedClientEditLandsInPlace() async throws {
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        try await client.editQueued(queueId: "q1", to: .room(id: "room-1", threadId: "t"), expectedText: "o", text: "n")
        XCTAssertEqual(QueuedEditStub.capturedRequest?.url?.path, "/api/groups/room-1/queue/q1")
        var state = CompanionState()
        state.pendingQueued["t"] = [QueuedSend(queueId: "q0", text: "a"), QueuedSend(queueId: "q1", text: "o", reason: "capacity")]
        XCTAssertTrue(state.applyQueuedEdit(QueuedSend(queueId: "q1", text: "n"), threadId: "t"))
        XCTAssertEqual(state.pendingQueued["t"], [QueuedSend(queueId: "q0", text: "a"), QueuedSend(queueId: "q1", text: "n", reason: "capacity")])
    }

    func testUnauthorizedStaysAnAPIErrorForRepairing() async {
        QueuedEditStub.statusCode = 401
        QueuedEditStub.responseBody = Data("{}".utf8)
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        do {
            try await client.editQueued(queueId: "q1", to: .bot(id: "b", threadId: "t"), expectedText: "o", text: "n")
            XCTFail("401 should throw")
        } catch {
            XCTAssertTrue((error as? APIError)?.isUnauthorized == true)
        }
    }
}
