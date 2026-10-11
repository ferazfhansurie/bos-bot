import Foundation
import CryptoKit
import XCTest
@testable import CompanionCore

/// Opt-in acceptance against an explicitly supplied isolated fixture only.
final class LocalLargeMediaFixtureTests: XCTestCase {
    func testFileBackedUploadAndDownloadAgainstIsolatedFixture() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let portText = env["LARGE_MEDIA_FIXTURE_PORT"], let port = Int(portText),
              let sourcePath = env["LARGE_MEDIA_FIXTURE_FILE"],
              let threadID = env["LARGE_MEDIA_FIXTURE_THREAD"],
              let messageID = env["LARGE_MEDIA_FIXTURE_MESSAGE"],
              let uploadID = env["LARGE_MEDIA_FIXTURE_UPLOAD"] else {
            throw XCTSkip("Requires an explicitly launched isolated media fixture.")
        }
        let client = CompanionClient(connection: Connection(name: "Isolated media fixture", host: "127.0.0.1", port: port), token: nil)
        let source = URL(fileURLWithPath: sourcePath)
        let saved = try await client.uploadFile(fileURL: source, name: "LargeVideo.mp4", mime: "video/mp4", uploadId: uploadID)
        let downloaded = try await client.downloadFileToDisk(threadId: threadID, messageId: messageID, path: saved.path)
        let url = try XCTUnwrap(downloaded.localURL)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertTrue(downloaded.data.isEmpty)
        XCTAssertEqual(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, try source.resourceValues(forKeys: [.fileSizeKey]).fileSize)
        func digest(_ file: URL) throws -> SHA256.Digest {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var hash = SHA256()
            while let chunk = try handle.read(upToCount: 1_024 * 1_024), !chunk.isEmpty { hash.update(data: chunk) }
            return hash.finalize()
        }
        XCTAssertEqual(try digest(source), try digest(url))
    }
}
