import Foundation
import Network
import XCTest
@testable import CompanionCore

private final class UploadProgressCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(Int64, Int64)] = []
    func append(_ sent: Int64, _ total: Int64) {
        lock.lock(); defer { lock.unlock() }
        values.append((sent, total))
    }
    var snapshot: [(Int64, Int64)] {
        lock.lock(); defer { lock.unlock() }
        return values
    }
}

/// Real loopback transport: URLProtocol fixtures cannot emit didSendBodyData.
private final class UploadHTTPFixture: @unchecked Sendable {
    private let listener: NWListener
    private let responseDelay: Double
    private let queue = DispatchQueue(label: "upload-progress-fixture")
    private let lock = NSLock()
    private var receivedHeaders: [String] = []
    private var receivedSizes: [Int] = []
    private var receivedBodies: [Data] = []
    private var connections: [NWConnection] = []
    var received: ([String], [Int]) {
        lock.lock(); defer { lock.unlock() }
        return (receivedHeaders, receivedSizes)
    }

    var bodies: [Data] {
        lock.lock(); defer { lock.unlock() }
        return receivedBodies
    }

    init(responseDelay: Double = 0) throws {
        self.responseDelay = responseDelay
        listener = try NWListener(using: .tcp, on: .any)
    }

    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.connections.append(connection)
            connection.start(queue: self.queue)
            self.read(connection, accumulated: Data())
        }
        return try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    guard let port = self?.listener.port?.rawValue else { return }
                    self?.listener.stateUpdateHandler = nil
                    continuation.resume(returning: port)
                case .failed(let error):
                    self?.listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    private func read(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1_024) { [weak self] data, _, complete, error in
            guard let self else { return }
            var bytes = accumulated
            if let data { bytes.append(data) }
            if let separator = bytes.range(of: Data("\r\n\r\n".utf8)) {
                let headers = String(decoding: bytes[..<separator.lowerBound], as: UTF8.self)
                let length = headers.components(separatedBy: "\r\n").first(where: { $0.lowercased().hasPrefix("content-length:") })
                    .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
                if bytes.count - separator.upperBound >= length {
                    self.lock.lock()
                    self.receivedHeaders.append(headers)
                    self.receivedSizes.append(length)
                    self.receivedBodies.append(Data(bytes[separator.upperBound..<(separator.upperBound + length)]))
                    self.lock.unlock()
                    let body = #"{"path":"/tmp/uploaded.png","name":"uploaded.png","mime":"image/png","bytes":524288}"#
                    let response = "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    self.queue.asyncAfter(deadline: .now() + self.responseDelay) {
                        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                    }
                    return
                }
            }
            if !complete, error == nil {
                // Exercise periodic transport progress rather than a tiny
                // loopback request that can finish before any callback fires.
                let partialBody = bytes
                self.queue.asyncAfter(deadline: .now() + 0.01) {
                    self.read(connection, accumulated: partialBody)
                }
            } else { connection.cancel() }
        }
    }

    func stop() {
        listener.cancel()
        queue.sync { connections.forEach { $0.cancel() } }
    }
}

final class UploadProgressTests: XCTestCase {
    func testDelegateReportsOnlyObservedBytesAndUsesKnownSizeForUnknownLength() {
        let capture = UploadProgressCapture()
        let delegate = UploadByteProgress(totalBytes: 1_024, progress: { capture.append($0, $1) })
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: URL(string: "http://127.0.0.1/")!)
        delegate.urlSession(session, task: task, didSendBodyData: 128, totalBytesSent: 128, totalBytesExpectedToSend: NSURLSessionTransferSizeUnknown)
        delegate.urlSession(session, task: task, didSendBodyData: 256, totalBytesSent: 384, totalBytesExpectedToSend: 1_024)
        XCTAssertEqual(capture.snapshot.map { $0.0 }, [128, 384])
        XCTAssertEqual(capture.snapshot.map { $0.1 }, [1_024, 1_024])
    }

    func testCancellationAfterTransportStartsRemainsCancellationAndDoesNotRetry() async throws {
        let fixture = try UploadHTTPFixture(responseDelay: 2)
        let port = try await fixture.start()
        defer { fixture.stop() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "fixture", host: "127.0.0.1", port: Int(port)), token: nil, session: session)
        let started = expectation(description: "request body began transmission")
        started.assertForOverFulfill = false
        let upload = Task {
            try await client.uploadImage(data: Data(repeating: 42, count: 512 * 1_024), mime: "image/png", uploadId: UUID().uuidString,
                                         progress: { sent, _ in if sent > 0 { started.fulfill() } })
        }
        await fulfillment(of: [started], timeout: 5)
        upload.cancel()
        do {
            _ = try await upload.value
            XCTFail("expected active transfer cancellation")
        } catch is CancellationError {} catch { XCTFail("cancellation was rewritten as \(error)") }
        XCTAssertLessThanOrEqual(fixture.received.1.count, 1)
    }

    func testAllUploadSourcesReportRealTransportBytesAndPreserveSessionHeaders() async throws {
        let fixture = try UploadHTTPFixture()
        let port = try await fixture.start()
        defer { fixture.stop() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpAdditionalHeaders = ["X-Upload-Fixture": "supplied-session"]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "fixture", host: "127.0.0.1", port: Int(port)), token: "fixture-token", session: session)
        let bytes = Data(repeating: 42, count: 2 * 1_024 * 1_024)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try bytes.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        for source in 0..<3 {
            let capture = UploadProgressCapture()
            let id = UUID().uuidString
            if source == 0 {
                _ = try await client.uploadImage(data: bytes, mime: "image/png", uploadId: id, progress: { capture.append($0, $1) })
            } else if source == 1 {
                _ = try await client.uploadFile(data: bytes, name: "uploaded.png", mime: "image/png", uploadId: id, progress: { capture.append($0, $1) })
            } else {
                _ = try await client.uploadFile(fileURL: file, name: "uploaded.png", mime: "image/png", uploadId: id, progress: { capture.append($0, $1) })
            }
            let events = capture.snapshot
            XCTAssertEqual(events.first?.0, 0)
            XCTAssertTrue(events.contains { $0.0 > 0 }, "source \(source) must emit actual transport callbacks")
            XCTAssertTrue(events.allSatisfy { $0.0 >= 0 && $0.0 <= Int64(bytes.count) })
            XCTAssertTrue(zip(events, events.dropFirst()).allSatisfy { $0.0.0 <= $0.1.0 })
            XCTAssertTrue(events.allSatisfy { $0.1 == Int64(bytes.count) })
        }
        let (headers, sizes) = fixture.received
        XCTAssertEqual(sizes, [bytes.count, bytes.count, bytes.count])
        XCTAssertEqual(fixture.bodies, [bytes, bytes, bytes])
        XCTAssertTrue(headers.allSatisfy { $0.lowercased().contains("x-upload-fixture: supplied-session") })
        XCTAssertTrue(headers.allSatisfy { $0.lowercased().contains("authorization: bearer fixture-token") })
    }
}
