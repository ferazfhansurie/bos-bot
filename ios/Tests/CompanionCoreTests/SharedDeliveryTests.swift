import XCTest
@testable import CompanionCore

@MainActor final class SharedDeliveryTests: XCTestCase {
    func testRestartRestoresFilesAndRetriesAcceptedSendWithoutUploadingAgain() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = SharedDeliveryDraft(text: "review", directory: directory)
        first.files = [PendingSharedFile(name: "brief.txt", mime: "text/plain", data: Data("private draft".utf8))]
        var originalID = ""
        let failed = await first.send(upload: { _ in try self.attachment("uploaded") }, deliver: { _, id, _ in
            originalID = id
            throw URLError(.networkConnectionLost)
        })
        XCTAssertFalse(failed)
        let restored = SharedDeliveryDraft(directory: directory)
        XCTAssertEqual(restored.text, "review")
        XCTAssertEqual(restored.files.first?.data, Data("private draft".utf8))
        XCTAssertNotNil(restored.error)
        XCTAssertFalse(restored.sending)
        let accepted = await restored.send(upload: { _ in
            XCTFail("must reuse the durable attachment receipt")
            throw URLError(.badServerResponse)
        }, deliver: { _, id, refs in
            XCTAssertEqual(id, originalID)
            XCTAssertEqual(refs.map(\.id), ["uploaded"])
        })
        XCTAssertTrue(accepted)
        let afterAcceptance = SharedDeliveryDraft(directory: directory)
        XCTAssertEqual(afterAcceptance.text, "")
        XCTAssertTrue(afterAcceptance.files.isEmpty)
        XCTAssertNil(afterAcceptance.error)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["draft.json"])
    }

    func testStorageFailurePreventsNetworkDispatch() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data([1]).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let draft = SharedDeliveryDraft(text: "keep this", directory: file)
        let sent = await draft.send(upload: { _ in XCTFail("no upload"); throw URLError(.unknown) }, deliver: { _, _, _ in XCTFail("no dispatch") })
        XCTAssertFalse(sent)
        XCTAssertEqual(draft.text, "keep this")
        XCTAssertNotNil(draft.error)
    }

    func testUnsentFilesAndEditsPersistIndependentlyOfAnotherConversation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let one = root.appendingPathComponent("one"), two = root.appendingPathComponent("two")
        let draft = SharedDeliveryDraft(directory: one)
        draft.files = [PendingSharedFile(name: "one.txt", mime: "text/plain", data: Data([1]))]
        draft.text = "unsent"
        XCTAssertEqual(SharedDeliveryDraft(directory: one).text, "unsent")
        XCTAssertEqual(SharedDeliveryDraft(directory: one).files.count, 1)
        XCTAssertTrue(SharedDeliveryDraft(directory: two).files.isEmpty)
    }

    func testCorruptArchiveCannotBeSilentlyOverwritten() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let manifest = directory.appendingPathComponent("draft.json")
        let original = Data("interrupted archive".utf8)
        try original.write(to: manifest)
        let draft = SharedDeliveryDraft(directory: directory)
        draft.text = "new text"
        draft.edited()
        XCTAssertNotNil(draft.error)
        let accepted = await draft.send(upload: { _ in throw URLError(.unknown) }, deliver: { _, _, _ in XCTFail("must not send over a corrupt archive") })
        XCTAssertFalse(accepted)
        XCTAssertEqual(try Data(contentsOf: manifest), original)
    }

    private func attachment(_ name: String) throws -> SharedAttachment {
        try JSONDecoder().decode(SharedAttachment.self, from: Data("{\"id\":\"\(name)\",\"name\":\"\(name)\",\"mime\":\"text/plain\",\"size\":1}".utf8))
    }
    func testRetryReusesPartialUploadsAndLostAcknowledgementIdentity() async throws {
        let draft = SharedDeliveryDraft(text: "review")
        let first = PendingSharedFile(name: "one", mime: "text/plain", data: Data([1]))
        let second = PendingSharedFile(name: "two", mime: "text/plain", data: Data([2]))
        draft.files = [first, second]
        var uploads: [UUID] = [], sends: [String] = []
        var rejectSecond = true, rejectSend = true
        let upload: (PendingSharedFile) async throws -> SharedAttachment = { file in
            uploads.append(file.id)
            if file.id == second.id && rejectSecond { rejectSecond = false; throw URLError(.notConnectedToInternet) }
            return try self.attachment(file.name)
        }
        let deliver: (SharedSendDraft, String, [SharedAttachment]) async throws -> Void = { snapshot, id, refs in
            sends.append(id)
            XCTAssertEqual(refs.map(\.id), ["one", "two"])
            XCTAssertEqual(snapshot.text, "review")
            if rejectSend { rejectSend = false; throw URLError(.networkConnectionLost) }
        }
        let firstAttempt = await draft.send(upload: upload, deliver: deliver)
        XCTAssertFalse(firstAttempt)
        let secondScreen = draft // the conversation store returns this object on navigation
        let secondAttempt = await secondScreen.send(upload: upload, deliver: deliver)
        XCTAssertFalse(secondAttempt)
        XCTAssertEqual(secondScreen.files.map(\.id), [first.id, second.id])
        XCTAssertNotNil(secondScreen.error)
        let thirdAttempt = await secondScreen.send(upload: upload, deliver: deliver)
        XCTAssertTrue(thirdAttempt)
        XCTAssertEqual(uploads, [first.id, second.id, second.id])
        XCTAssertEqual(sends.count, 2)
        XCTAssertEqual(sends.first, sends.last)
        XCTAssertTrue(draft.files.isEmpty)
        XCTAssertTrue(draft.text.isEmpty)
        XCTAssertTrue(draft.sent)
        draft.edited() // programmatic clear notification from the composer
        XCTAssertTrue(draft.sent)
        draft.text = "next message"; draft.edited()
        XCTAssertFalse(draft.sent)
    }
    func testEditsDuringUploadPreserveNewDraftAndCaptureOriginalReply() async throws {
        func message(_ id: String) throws -> SharedChatMessage {
            try JSONDecoder().decode(SharedChatMessage.self, from: Data("{\"id\":\"\(id)\",\"roomId\":\"r\",\"sequence\":1,\"actor\":{\"homeId\":\"h\",\"kind\":\"person\",\"localId\":\"owner\"},\"text\":\"source\",\"at\":1,\"sendId\":\"s\"}".utf8))
        }
        let draft = SharedDeliveryDraft(text: "original")
        draft.reply = try message("original-reply")
        let newerReply = try message("new-reply")
        let first = PendingSharedFile(name: "one", mime: "text/plain", data: Data([1]))
        let second = PendingSharedFile(name: "two", mime: "text/plain", data: Data([2]))
        draft.files = [first]
        let accepted = await draft.send(upload: { file in
            XCTAssertTrue(draft.sending)
            draft.text = "new draft"; draft.files.append(second); draft.reply = newerReply
            let duplicate = await draft.send(upload: { _ in XCTFail("duplicate upload"); return try self.attachment("bad") }, deliver: { _, _, _ in XCTFail("duplicate send") })
            XCTAssertFalse(duplicate)
            return try self.attachment(file.name)
        }, deliver: { snapshot, _, _ in
            XCTAssertEqual(snapshot.text, "original")
            XCTAssertEqual(snapshot.replyTo, "original-reply")
            XCTAssertEqual(snapshot.fileIDs, [first.id])
        })
        XCTAssertTrue(accepted)
        XCTAssertEqual(draft.text, "new draft")
        XCTAssertEqual(draft.files.map(\.id), [second.id])
        XCTAssertEqual(draft.reply?.id, "new-reply")
    }
}
