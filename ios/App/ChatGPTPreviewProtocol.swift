#if DEBUG
import Foundation

/// Offline UI fixture for the ChatGPT-style transcript: serves the bundled
/// GPTPreview-* media through the message file route and refuses everything
/// else, so this preview cannot dial a computer.
final class ChatGPTPreviewProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private static let types = [
        "jpg": "image/jpeg", "png": "image/png", "mp4": "video/mp4", "m4a": "audio/mp4", "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]

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
        guard request.httpMethod == "POST",
              request.url?.path.hasSuffix("/file") == true,
              request.value(forHTTPHeaderField: "Authorization") == "Bearer chatgpt-fixture-token",
              let path = payload?["path"], path.hasPrefix("/fixture/") else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        let file = (path as NSString).lastPathComponent
        let ext = (file as NSString).pathExtension
        guard let url = Bundle.main.url(forResource: "GPTPreview-" + (file as NSString).deletingPathExtension, withExtension: ext),
              let data = try? Data(contentsOf: url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.fileDoesNotExist))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": Self.types[ext] ?? "application/octet-stream",
            "Content-Disposition": "attachment; filename=\(file)",
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
