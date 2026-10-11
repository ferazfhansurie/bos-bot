import XCTest
@testable import CompanionCore

final class BotDraftTests: XCTestCase {
    func testRestartKeepsFilesReplyAndRetryIdentityButEditChangesIdentity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = BotDraft(directory: directory)
        let file = PendingMessageAttachment(data: Data([1, 2]), name: "a.txt", mime: "text/plain", kind: .file)
        first.text = "hello"; first.files = [file]
        first.reply = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"reply","role":"bot","kind":"text","at":1,"text":"quote"}"#.utf8))
        try first.checkpoint()
        let id = try first.prepareSend(text: "hello", priority: .queue)
        let restored = BotDraft(directory: directory)
        XCTAssertEqual(restored.files, [file])
        XCTAssertEqual(restored.reply, first.reply)
        XCTAssertEqual(try restored.prepareSend(text: "hello", priority: .queue), id)
        restored.text = "edited"
        XCTAssertNotEqual(try restored.prepareSend(text: "edited", priority: .queue), id)
        restored.complete(sendID: id)
        XCTAssertEqual(restored.text, "edited")
    }
    func testThirtyTwoAttachmentsSurviveRestartAndKeepRetryIdentity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = BotDraft(directory: directory)
        first.files = (0..<32).map { PendingMessageAttachment(data: Data([UInt8($0)]), name: "file-\($0).txt", mime: "text/plain", kind: .file) }
        try AttachmentPolicy.validate(first.files)
        let id = try first.prepareSend(text: "batch", priority: .queue)
        let restored = BotDraft(directory: directory)
        XCTAssertEqual(restored.files, first.files)
        XCTAssertEqual(try restored.prepareSend(text: "batch", priority: .queue), id)
    }

    func testOversizedSavedBatchIsRejectedBeforeLoadingPayloads() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ids = (0..<5).map { _ in UUID() }
        let archive = SharedDraftArchive(text: "", files: ids.map { .init(id: $0, name: "file.txt", mime: "text/plain") }, reply: nil, previous: nil, previousID: nil, uploads: [:])
        try JSONEncoder().encode(archive).write(to: directory.appendingPathComponent("draft.json"))
        for id in ids {
            let url = directory.appendingPathComponent(id.uuidString)
            XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
            let file = try FileHandle(forWritingTo: url)
            try file.truncate(atOffset: UInt64(AttachmentPolicy.maximumFileBytes))
            try file.close()
        }
        XCTAssertThrowsError(try SharedDraftDisk(directory: directory).load())
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(ids[0].uuidString).path))
    }

    func testCorruptManifestIsPreservedAndBlocksNetworkCheckpoint() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let manifest = directory.appendingPathComponent("draft.json")
        let corrupt = Data("bad".utf8)
        try corrupt.write(to: manifest)
        let draft = BotDraft(directory: directory)
        XCTAssertNotNil(draft.error)
        draft.text = "new"
        XCTAssertThrowsError(try draft.prepareSend(text: "new", priority: .queue))
        XCTAssertEqual(try Data(contentsOf: manifest), corrupt)
    }
    func testSaveFailureBlocksSendIdentityCheckpoint() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        try Data([1]).write(to: path)
        let draft = BotDraft(directory: path)
        draft.text = "blocked"
        XCTAssertThrowsError(try draft.prepareSend(text: "blocked", priority: .queue))
        XCTAssertNotNil(draft.error)
    }
    func testDifferentOwnedDirectoriesNeverRestoreEachOthersDrafts() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = BotDraft(directory: root.appendingPathComponent("account-a"))
        first.text = "private"; try first.checkpoint()
        XCTAssertEqual(BotDraft(directory: root.appendingPathComponent("account-b")).text, "")
    }
    func testTypingDoesNotRewriteAttachmentPayload() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let draft = BotDraft(directory: directory)
        let file = PendingMessageAttachment(data: Data([1]), name: "a.txt", mime: "text/plain", kind: .file)
        draft.files = [file]; try draft.checkpoint()
        let path = directory.appendingPathComponent(file.id.uuidString)
        let before = try FileManager.default.attributesOfItem(atPath: path.path)[.modificationDate] as? Date
        draft.text = "edit"; try draft.checkpoint()
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: path.path)[.modificationDate] as? Date, before)
    }
}
