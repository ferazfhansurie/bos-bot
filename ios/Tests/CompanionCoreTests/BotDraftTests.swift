import XCTest
@testable import CompanionCore

final class BotDraftTests: XCTestCase {
    func testFileBackedVideoSurvivesPickerDeletionAndRestartWithoutLoadingBytes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("picker.mp4")
        let bytes = Data(repeating: 17, count: 30 * 1_024 * 1_024)
        try bytes.write(to: source)
        let file = try PendingMessageAttachment(copying: source, name: "Video.mp4", mime: "video/mp4")
        try FileManager.default.removeItem(at: source)
        XCTAssertTrue(file.data.isEmpty)
        XCTAssertEqual(file.bytes, bytes.count)
        let first = BotDraft(directory: root.appendingPathComponent("draft"))
        first.files = [file]
        let sendID = try first.prepareSend(text: "review", priority: .queue)
        let restored = BotDraft(directory: root.appendingPathComponent("draft"))
        XCTAssertNotNil(restored.error) // Interrupted sends keep their retry identity.
        XCTAssertEqual(restored.files.first?.id, file.id)
        XCTAssertEqual(restored.files.first?.bytes, bytes.count)
        XCTAssertTrue(try XCTUnwrap(restored.files.first).data.isEmpty)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(restored.files.first?.fileURL)), bytes)
        XCTAssertEqual(try restored.prepareSend(text: "review", priority: .queue), sendID)
        restored.complete(sendID: sendID)
        XCTAssertTrue(restored.files.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("draft").appendingPathComponent(file.id.uuidString).path))
    }

    func testFileBackedImportRejectsOversizeAndRemovesTemporaryCopy() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: source) }
        XCTAssertTrue(FileManager.default.createFile(atPath: source.path, contents: nil))
        let handle = try FileHandle(forWritingTo: source)
        try handle.truncate(atOffset: UInt64(AttachmentPolicy.maximumFileBytes + 1)); try handle.close()
        let target = source.appendingPathExtension("copy")
        XCTAssertThrowsError(try copyAttachmentFile(source, to: target, limit: AttachmentPolicy.maximumFileBytes))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

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
    func testLostResponseRetryKeepsIdentityWhenBotBecomesIdle() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let draft = BotDraft(directory: directory)
        draft.text = "one message"
        let first = try draft.prepareSend(text: draft.text, priority: .block)
        // The UI resets priority after sending; on reconnect the bot may
        // also have finished its turn. Neither proves the message was lost.
        let restored = BotDraft(directory: directory)
        XCTAssertEqual(try restored.prepareSend(text: restored.text, priority: .queue), first)
        restored.text = "a changed message"
        XCTAssertNotEqual(try restored.prepareSend(text: restored.text, priority: .queue), first)
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
            try file.truncate(atOffset: UInt64(AttachmentPolicy.maximumBufferedFileBytes))
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
