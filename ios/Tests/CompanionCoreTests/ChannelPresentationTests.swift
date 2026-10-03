import XCTest
@testable import CompanionCore

final class ChannelPresentationTests: XCTestCase {
    private func room() throws -> Room {
        try JSONDecoder().decode(Room.self, from: Data(#"{"id":"r","threadId":"t","name":"HQ","memberIds":["a","b"],"defaultResponder":{"kind":"everyone"},"bulletin":"","unread":false,"createdAt":1,"activeBotIds":["a"]}"#.utf8))
    }
    private func bot(_ id: String) throws -> Bot {
        try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"\(id)","threadId":"private-thread","name":"Scout","title":"","description":"","notifications":true,"color":"blue","unread":false,"busy":true,"modelSelection":{"instanceId":"local","model":"default"},"createdAt":1}
        """.utf8))
    }
    func testRoomStatusUsesThisRoomsActiveBotsAndOfflineWins() throws {
        let room = try room()
        XCTAssertEqual(ChannelMemberStatus.resolve(room: room, bot: try bot("a"), hostLive: true), .working)
        XCTAssertEqual(ChannelMemberStatus.resolve(room: room, bot: try bot("b"), hostLive: true), .idle, "Private bot work must not appear as room work")
        XCTAssertEqual(ChannelMemberStatus.resolve(room: room, bot: try bot("a"), hostLive: false), .offline)
        var remote = try bot("a")
        remote.remote = BotRemote(homeId: "remote", homeName: "Remote", online: false)
        XCTAssertEqual(ChannelMemberStatus.resolve(room: room, bot: remote, hostLive: true), .offline)
    }
    func testCollapseExcludesUserQuestionsApprovalsAndTools() throws {
        let data = Data(#"{"id":"m","at":1,"kind":"text","role":"bot","text":"Long prose"}"#.utf8)
        var message = try JSONDecoder().decode(Message.self, from: data)
        XCTAssertTrue(ChannelTextPresentation.canCollapse(message))
        message.role = .user
        XCTAssertFalse(ChannelTextPresentation.canCollapse(message))
        message.role = .bot
        for kind in [Message.Kind.options, .activity, .secret, .screen, .unknown] {
            message.kind = kind
            XCTAssertFalse(ChannelTextPresentation.canCollapse(message))
        }
    }
    func testSettingsContextRejectsReplacementHostAndAwayThenBack() {
        let opened = RoomSettingsContext(connectionID: "host-a", generation: 3)
        XCTAssertTrue(opened.permits(RoomSettingsContext(connectionID: "host-a", generation: 3)))
        XCTAssertFalse(opened.permits(RoomSettingsContext(connectionID: "host-b", generation: 3)))
        XCTAssertFalse(opened.permits(RoomSettingsContext(connectionID: "host-a", generation: 5)))
        XCTAssertFalse(opened.permits(nil))
    }

    func testMentionReplacementPreservesEarlierProseAndNames() {
        XCTAssertEqual(ChannelTextPresentation.mentionQuery("ask @Sc"), "Sc")
        XCTAssertNil(ChannelTextPresentation.mentionQuery("mail@example.com"))
        XCTAssertNil(ChannelTextPresentation.mentionQuery("@Scout done "))
        XCTAssertEqual(ChannelTextPresentation.insertingMention("Scout Bot", into: "@Lead review this with @Sc"), "@Lead review this with @Scout Bot ")
    }

    private func named(_ id: String, _ name: String, title: String = "") throws -> Bot {
        var b = try bot(id); b.name = name; b.title = title; return b
    }

    func testRosterPutsWorkingBotsFirstAndCountsTheRest() throws {
        let room = try room()
        let members = try ["b", "c", "d", "a", "e", "f"].map { try named($0, $0) }
        let roster = ChannelRoster(room: room, members: members, hostLive: true, limit: 4)
        XCTAssertEqual(roster.shown.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(roster.overflow, 2)
        XCTAssertEqual(roster.working, ["a"])
        XCTAssertEqual(ChannelRoster(room: room, members: Array(members.prefix(2)), hostLive: true).overflow, 0)
    }

    func testMentionDrawerFiltersByNameThenRole() throws {
        let bots = [try named("1", "pipe", title: "Backend builder"), try named("2", "pix", title: "Frontend builder"), try named("3", "bud", title: "Client delivery")]
        XCTAssertEqual(ChannelMentionPicker.matching(bots, query: "").count, 3)
        XCTAssertEqual(ChannelMentionPicker.matching(bots, query: "pi").map(\.name), ["pipe", "pix"])
        XCTAssertEqual(ChannelMentionPicker.matching(bots, query: "front").map(\.name), ["pix"])
        XCTAssertEqual(ChannelMentionPicker.matching(bots, query: "b").map(\.name), ["bud", "pipe", "pix"])
    }

    func testPickedMentionsSendAsPlainMentionText() throws {
        let picks = [try named("1", "dev"), try named("2", "pix")]
        XCTAssertEqual(ChannelMentionPicker.outgoing("ship it @", picks: picks), "@dev @pix ship it")
        XCTAssertEqual(ChannelMentionPicker.outgoing("@", picks: picks), "@dev @pix")
        XCTAssertEqual(ChannelMentionPicker.outgoing("@dev look", picks: picks), "@pix @dev look")
        XCTAssertEqual(ChannelMentionPicker.outgoing("hello", picks: []), "hello")
        XCTAssertEqual(ChannelMentionPicker.removingQuery(from: "ask @de"), "ask ")
    }
}
