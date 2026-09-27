import XCTest
@testable import CompanionCore

final class SharedConversationTests: XCTestCase {
    func testHumanNamesReplaceOnlyPlaceholderGroupNames() throws {
        let contacts = try JSONDecoder().decode(SharedContactsResponse.self, from: Data(#"{"contacts":[{"id":"me","name":"Firaz","kind":"person"},{"id":"p","name":"Putri","kind":"person"},{"id":"f","name":"Faeez","kind":"person"}]}"#.utf8)).contacts
        let json = #"{"id":"r","homeId":"h","name":"Group chat","kind":"group","memberIds":["me","f","p"],"createdAt":1}"#
        let group = try JSONDecoder().decode(SharedRoomSummary.self, from: Data(json.utf8))
        XCTAssertEqual(group.displayName(contacts: contacts, selfID: "me"), "Faeez, Putri")
        XCTAssertEqual(group.displayName(contacts: [], selfID: "me"), "Group chat")
        let named = try JSONDecoder().decode(SharedRoomSummary.self, from: Data(json.replacingOccurrences(of: "Group chat", with: "Launch crew").utf8))
        XCTAssertEqual(named.displayName(contacts: contacts, selfID: "me"), "Launch crew")
        let direct = try JSONDecoder().decode(SharedRoomSummary.self, from: Data(#"{"id":"dm","homeId":"h","name":"Old name","kind":"direct","memberIds":["me","p"],"createdAt":1}"#.utf8))
        XCTAssertEqual(direct.displayName(contacts: contacts, selfID: "me"), "Putri")
    }

    func testBotSearchMatchesOwnerWithoutChangingIdentity() throws {
        let bots = try JSONDecoder().decode(SharedEligibleBotsResponse.self, from: Data(#"{"bots":[{"id":"p:bot:pixie","name":"Pixie","ownerName":"Putri"},{"id":"f:bot:koda","name":"Koda","ownerName":"Faeez"}]}"#.utf8)).bots
        XCTAssertEqual(SharedEligibleBot.matching(bots, query: "putri").map(\.id), ["p:bot:pixie"])
        XCTAssertEqual(SharedEligibleBot.matching(bots, query: "PIX").map(\.id), ["p:bot:pixie"])
        XCTAssertTrue(SharedEligibleBot.matching(bots, query: "missing").isEmpty)
        XCTAssertEqual(SharedEligibleBot.matching(bots, query: "").count, 2)
    }

    func testExplicitTwoPersonGroupRemainsAGroupAndLegacyDMRemainsDirect() throws {
        let base = #"{"id":"room","homeId":"home","name":"Launch","memberIds":["home:person:owner","other:person:owner"],"createdAt":1"#
        let group = try JSONDecoder().decode(SharedRoomSummary.self, from: Data((base + #", "kind":"group", "unreadCount":3, "notifications":"mentions"}"#).utf8))
        XCTAssertTrue(group.isGroup)
        XCTAssertEqual(group.unreadCount, 3)
        XCTAssertEqual(group.notifications, "mentions")
        let legacy = try JSONDecoder().decode(SharedRoomSummary.self, from: Data((base + "}").utf8))
        XCTAssertFalse(legacy.isGroup)
        XCTAssertNil(legacy.unreadCount)
    }

    func testChangedMessagePagePreservesReplyAndRemovalMetadata() throws {
        let json = #"{"messages":[],"changes":[{"id":"message","roomId":"room","sequence":2,"actor":{"homeId":"home","kind":"person","localId":"owner"},"text":"","at":1,"sendId":"send","replyTo":"earlier","deletedAt":5}],"version":7,"hasMore":true}"#
        let page = try JSONDecoder().decode(SharedMessagesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(page.version, 7)
        XCTAssertEqual(page.hasMore, true)
        XCTAssertEqual(page.changes?.first?.replyTo, "earlier")
        XCTAssertEqual(page.changes?.first?.deletedAt, 5)
    }

    func testOlderServerPagesStillDecode() throws {
        let page = try JSONDecoder().decode(SharedMessagesResponse.self, from: Data(#"{"messages":[]}"#.utf8))
        XCTAssertNil(page.changes)
        XCTAssertNil(page.version)
        let bots = try JSONDecoder().decode(SharedEligibleBotsResponse.self, from: Data(#"{"bots":[{"id":"home:bot:one","name":"Ultron","ownerName":"Owner"}]}"#.utf8))
        XCTAssertEqual(bots.bots.first?.id, "home:bot:one")
    }
}
