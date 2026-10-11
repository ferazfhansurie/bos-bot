#if DEBUG
import Foundation

/// Intercept every preview request; this fixture never contacts a computer.
final class SteeringPreviewProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.url?.path.hasSuffix("/steer") == true
            ? #"{"ok":true,"queued":true,"threadId":"preview-gmail","reason":"This message is queued for the next reply; the running turn did not accept it."}"#
            : #"{"ok":true}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
