#if DEBUG
import Foundation

/// Isolated network fixture: the first stream remains open but stops delivering.
/// HTTP accepts the send; only a resumed stream delivers its reply.
final class StreamRecoveryPreviewProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var streams = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        if path == "/api/events" {
            Self.lock.lock(); Self.streams += 1; let count = Self.streams; Self.lock.unlock()
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
            emit(["kind": "hello", "cursor": "fixture:0", "resumed": true])
            if count > 1 && !ProcessInfo.processInfo.arguments.contains("-send-scroll-preview") {
                emit(["kind": "message", "seq": 1, "threadId": "preview-gmail", "message": Self.message])
                emit(["kind": "thread", "seq": 2, "threadId": "preview-gmail", "activeLeafId": "recovery-user"])
                emit(["kind": "message", "seq": 3, "threadId": "preview-gmail", "message": ["id": "recovery-reply", "parentId": "recovery-user", "role": "bot", "kind": "text", "at": 1890000000100, "text": "Live reply recovered without reopening"]])
            }
            return
        }
        if ProcessInfo.processInfo.arguments.contains("-send-scroll-preview"), request.httpMethod == "POST" {
            let message: [String: Any] = ["id": "scroll-user", "parentId": "stream-history-299",
                "role": "user", "kind": "text", "at": 1890000000000, "text": "keep this message visible"]
            let body: [String: Any] = ["ok": true, "threadId": "preview-gmail", "message": message]
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let body: [String: Any] = request.httpMethod == "POST" && path.hasSuffix("/messages")
            ? ["ok": true, "threadId": "preview-gmail", "message": Self.message]
            : [:]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    private static var message: [String: Any] {
        ["id": "recovery-user", "sendId": "recovery-send-0001", "role": "user", "kind": "text", "at": 1890000000000, "text": "recover this live stream"]
    }
    private func emit(_ body: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: body)
        client?.urlProtocol(self, didLoad: Data("data: ".utf8) + data + Data("\n\n".utf8))
    }
    override func stopLoading() {}
}
#endif
