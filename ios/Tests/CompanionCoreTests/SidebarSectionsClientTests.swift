import Foundation
import XCTest
@testable import CompanionCore

private final class SidebarSectionRequestStub: URLProtocol {
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
        let body = Data(Self.response.utf8)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
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

    private static let response = #"""
    {
      "section":"Research",
      "bots":[{
        "id":"b1","threadId":"t1","name":"Scout","title":"Researcher","description":"",
        "notifications":true,"color":"green","unread":false,"section":"Research",
        "modelSelection":{"instanceId":"i1","model":"m1"},"createdAt":1
      }]
    }
    """#
}

final class SidebarSectionsClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        SidebarSectionRequestStub.capturedRequest = nil
        SidebarSectionRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SidebarSectionRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testAssignSectionUsesTheNarrowAtomicRoute() async throws {
        let bots = try await client.assignSection(name: "Research", botIds: ["b2", "b1"])

        let request = try XCTUnwrap(SidebarSectionRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/sidebar-sections")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")

        let data = try XCTUnwrap(SidebarSectionRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["name"] as? String, "Research")
        XCTAssertEqual(body["botIds"] as? [String], ["b2", "b1"], "gesture order reaches the server unchanged")
        XCTAssertEqual(bots.map(\.id), ["b1"])
        XCTAssertEqual(bots.first?.section, "Research")
    }
}
