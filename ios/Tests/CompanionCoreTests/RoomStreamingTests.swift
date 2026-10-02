import XCTest
@testable import CompanionCore

final class RoomStreamingTests: XCTestCase {
    private func event(_ type: String, bot: String, delta: String? = nil, kind: String? = nil) throws -> RuntimeEvent {
        var json: [String: Any] = ["type": type, "threadId": "canonical", "roomBotId": bot, "roomRuntimeThreadId": "runtime-" + bot]
        if let delta { json["delta"] = delta }
        if let kind { json["streamKind"] = kind }
        return try JSONDecoder().decode(RuntimeEvent.self, from: JSONSerialization.data(withJSONObject: json))
    }
    func testInterleavedRoomLanesSettleIndependentlyAndKeepCanonicalCardsQuotes() throws {
        var state = CompanionState()
        state.rooms = [try JSONDecoder().decode(Room.self, from: Data(#"{"id":"r","threadId":"canonical","name":"HQ","memberIds":["a","b"],"defaultResponder":{"kind":"everyone"},"bulletin":"","unread":false,"createdAt":1,"activeBotIds":["a","b"]}"#.utf8))]
        let quote = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"quote","role":"user","kind":"text","at":1,"text":"Follow up","replyToId":"original"}"#.utf8))
        let card = Message(id: "approval", role: .bot, kind: .options, at: 2, text: "Approval required")
        state.apply(.message(threadId: "canonical", message: quote))
        state.apply(.message(threadId: "canonical", message: card))
        state.apply(.runtime(try event("content.delta", bot: "a", delta: "A one ", kind: "assistant_text")))
        state.apply(.runtime(try event("content.delta", bot: "b", delta: "B one ", kind: "assistant_text")))
        state.apply(.runtime(try event("content.delta", bot: "a", delta: "A two", kind: "assistant_text")))
        state.apply(.runtime(try event("content.delta", bot: "b", delta: "B thinking", kind: "reasoning_text")))
        XCTAssertEqual(state.streaming["canonical:room:a"], "A one A two")
        XCTAssertEqual(state.streaming["canonical:room:b"], "B one ")
        XCTAssertNil(state.streaming["canonical"])
        let completed = Message(id: "a-reply", role: .bot, kind: .text, at: 3, text: "A complete", from: Sender(botId: "a", name: "A", color: "blue"))
        state.apply(.message(threadId: "canonical", message: completed))
        state.apply(.runtime(try event("item.completed", bot: "a")))
        state.apply(.runtime(try event("turn.completed", bot: "a")))
        XCTAssertNil(state.streaming["canonical:room:a"])
        XCTAssertEqual(state.streaming["canonical:room:b"], "B one ")
        XCTAssertEqual(state.reasoning["canonical:room:b"], "B thinking")
        XCTAssertEqual(state.rooms[0].activeBotIds, ["a", "b"], "Only authoritative room frames own availability")
        XCTAssertEqual(state.messages["canonical"]?.map(\.id), ["quote", "approval", "a-reply"])
        XCTAssertEqual(state.messages["canonical"]?.first?.replyToId, "original")
        XCTAssertEqual(state.messages["canonical"]?[1].kind, .options)
        state.apply(.runtime(try event("turn.completed", bot: "b")))
        XCTAssertNil(state.streaming["canonical:room:b"])
        XCTAssertNil(state.reasoning["canonical:room:b"])
    }
    func testRuntimeMetadataAbsentKeepsLegacyKey() throws {
        let event = try JSONDecoder().decode(RuntimeEvent.self, from: Data(#"{"type":"content.delta","threadId":"private","delta":"hello","streamKind":"assistant_text"}"#.utf8))
        XCTAssertEqual(event.streamKey, "private")
        XCTAssertNil(event.roomRuntimeThreadId)
    }

    private func line(_ id: String, _ kind: Message.Kind, from bot: String?, role: Message.Role = .bot) -> Message {
        var message = Message(id: id, role: role, kind: kind, at: 1)
        if kind == .activity { message.tool = ToolActivity(name: "run", ok: true) }
        message.from = bot.map { Sender(botId: $0, name: $0.uppercased(), color: "blue") }
        return message
    }
    func testRoomMemberLiveStepsSplitInterleavedActivityPerMember() {
        let messages = [
            line("a-old", .activity, from: "a"), line("a-said", .text, from: "a"),
            line("ask", .text, from: nil, role: .user),
            line("a1", .activity, from: "a"), line("b1", .activity, from: "b"),
            line("receipt", .activity, from: nil), line("a2", .activity, from: "a"),
            line("b-said", .text, from: "b"), line("a3", .activity, from: "a"),
        ]
        let steps = roomMemberLiveSteps(messages, botIds: ["a", "b", "c"])
        XCTAssertEqual(steps["a"]?.map(\.id), ["a1", "a2", "a3"])
        XCTAssertNil(steps["b"], "b spoke after its step, so that step is settled")
        XCTAssertNil(steps["c"])
    }
    func testRoomMemberLiveStepsStopAtThePersonsLatestMessage() {
        let messages = [line("a-old", .activity, from: "a"), line("ask", .text, from: nil, role: .user)]
        XCTAssertTrue(roomMemberLiveSteps(messages, botIds: ["a"]).isEmpty)
    }
    func testGroupRoomTurnsPutsEachMembersStepsAboveItsReply() {
        let messages = [
            line("ask", .text, from: nil, role: .user),
            line("a1", .activity, from: "a"), line("b1", .activity, from: "b"),
            line("receipt", .activity, from: nil), line("a2", .activity, from: "a"),
            line("b-said", .text, from: "b"), line("a-said", .text, from: "a"),
            line("c1", .activity, from: "c"),
            line("next", .text, from: nil, role: .user),
        ]
        XCTAssertEqual(groupRoomTurns(messages).map(\.id),
                       ["ask", "receipt", "b1", "b-said", "a1", "a2", "a-said", "c1", "next"])
    }
    func testRoomRunsFoldFailuresAndNeverSpanMembers() {
        var failed = line("a2", .activity, from: "a")
        failed.tool = ToolActivity(name: "run", ok: false)
        let messages = [line("a1", .activity, from: "a"), failed, line("b1", .activity, from: "b"), line("b2", .activity, from: "b")]
        XCTAssertEqual(transcriptRows(messages, detail: .reduced, foldFailures: true).map(\.id), ["run.a1", "run.b1"])
        XCTAssertEqual(transcriptRows(messages, detail: .reduced).map(\.id), ["a1", "a2", "run.b1"])
    }
}
