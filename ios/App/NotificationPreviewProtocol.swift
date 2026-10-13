#if DEBUG
import Foundation

/// Offline notification routing fixture. Every request is intercepted and
/// mutations fail, including the old server-side task-switch navigation.
final class NotificationPreviewProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var status = 404
        var data = Data("{}".utf8)
        if request.httpMethod == "GET", let url = request.url {
            if url.path == "/api/bots",
               let fixture = Bundle.main.url(forResource: "ThreadPreview", withExtension: "json"),
               let body = try? Data(contentsOf: fixture) {
                data = body; status = 200
            } else if url.path.hasSuffix("/messages"),
                      let fixture = Bundle.main.url(forResource: "ThreadPreviewPages", withExtension: "json"),
                      let body = try? Data(contentsOf: fixture),
                      let pages = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let page = pages[url.deletingLastPathComponent().lastPathComponent],
                      let encoded = try? JSONSerialization.data(withJSONObject: page) {
                data = encoded; status = 200
            }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif
