import Foundation
import XCTest
@testable import CompanionCore

private final class ResumeAllStub: URLProtocol {
    static var statuses: [Int] = []
    static var paths: [String] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.paths.append(request.url!.path)
        let status = Self.statuses.isEmpty ? 202 : Self.statuses.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ResumeAllClientTests: XCTestCase {
    var session: URLSession!
    var client: CompanionClient!
    let turns = [
        InterruptedTurn(id: "r1", botId: "b1", threadId: "t1", at: nil),
        InterruptedTurn(id: "r2", botId: "b2", threadId: "t2", at: nil),
    ]
    override func setUp() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResumeAllStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(connection: Connection(name: "Fixture", host: "127.0.0.1", port: 8810), token: "fixture", session: session)
        ResumeAllStub.statuses = []
        ResumeAllStub.paths = []
    }
    override func tearDown() { session.invalidateAndCancel() }

    func testResumeAllIsOneCallWhenAllowed() async throws {
        ResumeAllStub.statuses = [202]
        try await client.resumeAllTurns(turns)
        XCTAssertEqual(ResumeAllStub.paths, ["/api/recovery/resume-all"])
    }

    func testPairedPhoneWithoutAdminScopeResumesEachTurn() async throws {
        ResumeAllStub.statuses = [403, 202, 202]
        try await client.resumeAllTurns(turns)
        XCTAssertEqual(ResumeAllStub.paths, [
            "/api/recovery/resume-all",
            "/api/bots/b1/threads/t1/recovery/r1/resume",
            "/api/bots/b2/threads/t2/recovery/r2/resume",
        ])
    }

    func testOneFailedTurnStillTriesTheRestThenThrows() async {
        ResumeAllStub.statuses = [404, 500, 202]
        do {
            try await client.resumeAllTurns(turns)
            XCTFail("expected the failed turn to surface")
        } catch {}
        XCTAssertEqual(ResumeAllStub.paths.count, 3)
    }

    func testOtherErrorsDoNotFanOut() async {
        ResumeAllStub.statuses = [401]
        do {
            try await client.resumeAllTurns(turns)
            XCTFail("expected 401")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnauthorized)
        } catch { XCTFail("\(error)") }
        XCTAssertEqual(ResumeAllStub.paths, ["/api/recovery/resume-all"])
    }
}
