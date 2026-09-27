import XCTest
@testable import CompanionCore

@MainActor final class SharedDeliveryTests: XCTestCase {
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
