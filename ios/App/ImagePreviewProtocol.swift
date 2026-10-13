#if DEBUG
import Foundation

/// Offline UI fixture: intercept every request so this preview cannot dial a computer.
final class ImagePreviewProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                body.append(contentsOf: bytes.prefix(count))
            }
        }
        let payload = (try? JSONSerialization.jsonObject(with: body)) as? [String: String]
        if request.httpMethod == "POST",
           request.url?.path == "/api/threads/preview-gmail/messages/preview-gmail-reply/file",
           request.value(forHTTPHeaderField: "Authorization") == "Bearer image-fixture-token",
           payload?["path"] == "/fixture/notes.txt" {
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=notes.txt"
            ])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("These are the delivered notes.".utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        // A reply that embeds its images as Markdown sends the authored
        // destination through the same route.
        let embeddedCover = request.url?.path == "/api/threads/preview-gmail/messages/preview-covers-reply/file"
            && ["/fixture/rea/cover-a.png", "/fixture/rea/cover-b.png"].contains(payload?["path"] ?? "")
        let generatedImage = request.url?.path == "/api/threads/preview-gmail/messages/preview-gmail-reply/file"
            && payload?["path"] == "/fixture/screenshot.png"
        guard request.httpMethod == "POST",
              embeddedCover || generatedImage,
              request.value(forHTTPHeaderField: "Authorization") == "Bearer image-fixture-token",
              let url = Bundle.main.url(forResource: "ImagePreview", withExtension: "png"),
              let data = try? Data(contentsOf: url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "image/png", "Content-Disposition": "attachment; filename=screenshot.png"
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
