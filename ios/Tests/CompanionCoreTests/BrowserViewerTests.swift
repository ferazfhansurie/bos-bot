import XCTest
@testable import CompanionCore

private final class BrowserActionStub: URLProtocol {
    static var calls = 0
    static var request: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.calls += 1; Self.request = request
        client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
    }
    override func stopLoading() {}
}

private final class BrowserEventsStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let events = "event: ready\ndata: {\"viewerId\":\"synthetic\"}\n\nevent: control\ndata: {\"held\":false}\n\nevent: frame\ndata: {\"seq\":1,\"data\":\"/9j/AAAA\",\"metadata\":{\"deviceWidth\":1280,\"deviceHeight\":720}}\n\n"
        client?.urlProtocol(self, didLoad: Data(events.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class BrowserViewerTests: XCTestCase {
    func testNamedEventsStaySeparateFromChatFrames() throws {
        var parser = SSEParser()
        XCTAssertNil(parser.line("event: ready"))
        XCTAssertNil(parser.line("data: {\"viewerId\":\"synthetic-viewer\"}"))
        let event = try XCTUnwrap(parser.line(""))
        let ready = try BrowserViewerEvent.decode(event)
        XCTAssertEqual(ready.name, "ready")
        XCTAssertEqual(ready.payload.viewerId, "synthetic-viewer")
        XCTAssertNil(parser.line("data: {}"))
        XCTAssertThrowsError(try BrowserViewerEvent.decode(try XCTUnwrap(parser.line(""))))
    }

    func testFrameBoundsRejectBadDimensionsAndSequences() throws {
        for (seq, width, height) in [(0, 1280, 720), (1, 9000, 720), (1, 8192, 8192)] {
            let event = SSEEvent(name: "frame", data: "{\"seq\":\(seq),\"data\":\"/9j/AAAA\",\"metadata\":{\"deviceWidth\":\(width),\"deviceHeight\":\(height)}}")
            XCTAssertThrowsError(try BrowserViewerEvent.decode(event))
        }
        let frame = try BrowserViewerEvent.decode(SSEEvent(name: "frame", data: "{\"seq\":1,\"data\":\"/9j/AAAA\",\"metadata\":{\"deviceWidth\":1280,\"deviceHeight\":720}}"))
        XCTAssertEqual(frame.payload.metadata?.deviceWidth, 1280)
    }

    func testTransportPreservesBlankLinesAndYieldsNamedFrames() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BrowserEventsStub.self]
        let network = URLSession(configuration: configuration)
        defer { network.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "fixture", host: "127.0.0.1", port: 8810), token: "synthetic", session: network)
        var names: [String] = []
        for try await event in try client.browserEvents(botId: "fixture", streamingSession: network).prefix(3) { names.append(event.name) }
        XCTAssertEqual(names, ["ready", "control", "frame"])
    }

    func testLostActionResponseDoesNotReplayTheTap() async throws {
        BrowserActionStub.calls = 0
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BrowserActionStub.self]
        let network = URLSession(configuration: configuration)
        defer { network.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "fixture", host: "127.0.0.1", port: 8810), token: "synthetic-bearer", session: network)
        do {
            try await client.browserAction(botId: "fixture-bot", viewerId: "fixture-viewer", action: .tap(seq: 8, x: 12, y: 20))
            XCTFail("lost response must fail")
        } catch {}
        XCTAssertEqual(BrowserActionStub.calls, 1)
        XCTAssertEqual(BrowserActionStub.request?.url?.path, "/api/bots/fixture-bot/browser/action")
        XCTAssertEqual(BrowserActionStub.request?.httpMethod, "POST")
        XCTAssertEqual(BrowserActionStub.request?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-bearer")
    }
}
