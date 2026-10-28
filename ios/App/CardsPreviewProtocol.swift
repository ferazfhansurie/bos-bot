#if DEBUG
import Foundation

/// `-cards-preview`: answers every request locally and writes each one to
/// Documents/cards-preview-requests.log, so a simulator run can prove what a
/// card tap posted (and to which thread) without a computer.
final class CardsPreviewProtocol: URLProtocol {
    static let logURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("cards-preview-requests.log")

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            body = data
        }
        let line = "\(request.httpMethod ?? "GET") \(path)\(request.url?.query.map { "?\($0)" } ?? "") \(body.flatMap { String(data: $0, encoding: .utf8) } ?? "")\n"
        if let handle = try? FileHandle(forWritingTo: Self.logURL) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: Self.logURL)
        }
        let reply: String
        if path.hasSuffix("/authorize") { reply = #"{"url":"https://bosbot.my/"}"# }
        else if path.hasSuffix("/status") { reply = #"{"connected":false,"pending":true,"status":"authorizing"}"# }
        else { reply = #"{"ok":true}"# }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
