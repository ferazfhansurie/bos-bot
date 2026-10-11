import Foundation
import XCTest
@testable import CompanionCore

private final class ConcurrentWaitingStub: URLProtocol {
    static let lock = NSLock()
    static var active = 0
    static var maximum = 0
    static var paths: [String] = []
    private var stopped = false
    static func reset() {
        lock.lock(); defer { lock.unlock() }
        active = 0; maximum = 0; paths = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        if path == "/api/bots" {
            let tasks = (0..<9).map { "{\"threadId\":\"wait-\($0)\",\"title\":\"Waiting\",\"createdAt\":1,\"activity\":\"waiting-on-you\"}" }.joined(separator: ",")
            finish("{\"bots\":[{\"id\":\"bot\",\"threadId\":\"selected\",\"name\":\"Fixture\",\"title\":\"Fixture\",\"description\":\"\",\"notifications\":true,\"color\":\"blue\",\"unread\":false,\"createdAt\":1,\"busy\":false,\"modelSelection\":{\"instanceId\":\"codex\",\"model\":\"default\"},\"messages\":[],\"tasks\":[\(tasks),{\"threadId\":\"wait-0\",\"title\":\"Duplicate\",\"createdAt\":1,\"activity\":\"waiting-on-you\"}]}],\"groups\":[]}")
            return
        }
        Self.lock.lock()
        Self.paths.append(path)
        Self.active += 1
        Self.maximum = max(Self.maximum, Self.active)
        Self.lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [self] in
            Self.lock.lock()
            Self.active -= 1
            let cancelled = stopped
            Self.lock.unlock()
            if !cancelled { finish("{\"messages\":[],\"hasMore\":false}") }
        }
    }
    private func finish(_ body: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {
        Self.lock.lock(); stopped = true; Self.lock.unlock()
    }
}

final class WaitingThreadConcurrencyTests: XCTestCase {
    func testWaitingPagesOverlapWithFourRequestLimitAndDeduplicateThreads() async throws {
        ConcurrentWaitingStub.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ConcurrentWaitingStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "Fixture", host: "127.0.0.1", port: 8810), token: "fixture", session: session)
        let snapshot = try await client.fleetForHydration()
        XCTAssertEqual(snapshot.waitingThreads.count, 9)
        XCTAssertEqual(ConcurrentWaitingStub.paths.count, 9)
        XCTAssertEqual(Set(ConcurrentWaitingStub.paths).count, 9)
        XCTAssertGreaterThan(ConcurrentWaitingStub.maximum, 1, "Slow approval pages must overlap instead of serially blocking hydration.")
        XCTAssertLessThanOrEqual(ConcurrentWaitingStub.maximum, 4)
    }
}
