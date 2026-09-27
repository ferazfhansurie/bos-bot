import XCTest
@testable import CompanionCore

final class SharedConversationTests: XCTestCase {
    func testHumanAndBotPickerLabelsDoNotCollide() throws {
        let contacts = try JSONDecoder().decode(SharedContactsResponse.self, from: Data(#"{"contacts":[{"id":"m","name":"Maya","kind":"person"},{"id":"outside","name":"Absent","kind":"person"}]}"#.utf8)).contacts
        let bots = try JSONDecoder().decode(SharedEligibleBotsResponse.self, from: Data(#"{"bots":[{"id":"a:bot:m","name":"Maya","ownerName":"Alex"},{"id":"p:bot:p","name":"Pixie","ownerName":"Putri"}]}"#.utf8)).bots
        let choices = SharedMentionChoice.choices(contacts: contacts, memberIDs: ["m"], bots: bots)
        XCTAssertEqual(choices.map(\.label), ["Maya · person", "Maya · Alex", "Pixie"])
        XCTAssertEqual(SharedMentionChoice.matching(choices, query: "person").map(\.id), ["m"])
        XCTAssertEqual(SharedMentionChoice.matching(choices, query: "putri").map(\.id), ["p:bot:p"])
        XCTAssertFalse(choices.contains { $0.id == "outside" })
    }

    func testRequestOwnershipAndUnknownStatesFailClosed() throws {
        let json = #"{"requests":[{"id":"q","roomId":"room","sourceId":"source","sourceSequence":4,"requesterId":"alice","botId":"home:bot:bot","botName":"Helper","ownerId":"owner","ownerName":"Owner","state":"queued","createdAt":1,"updatedAt":2}],"hasMore":false,"before":4}"#
        let page = try JSONDecoder().decode(SharedRequestsResponse.self, from: Data(json.utf8))
        let request = try XCTUnwrap(page.requests.first)
        XCTAssertTrue(request.canCancel(actorId: "alice"))
        XCTAssertTrue(request.canCancel(actorId: "owner"))
        XCTAssertFalse(request.canCancel(actorId: "other"))
        XCTAssertEqual(request.sourceSequence, 4)
        let future = try JSONDecoder().decode(SharedRequestsResponse.self, from: Data(json.replacingOccurrences(of: "queued", with: "future-state").utf8)).requests[0]
        XCTAssertFalse(future.isActive)
        XCTAssertFalse(future.canCancel(actorId: "owner"))
        XCTAssertEqual(future.stateLabel, "Outcome unknown")
    }

    func testSettledWorkKeepsBotAndRequestIdentity() throws {
        func row(_ id: String, _ sequence: Int, home: String = "one", request: String = "request-a", state: String = "start") throws -> SharedChatMessage {
            let json = """
            {"id":"\(id)","roomId":"room","sequence":\(sequence),"actor":{"homeId":"\(home)","kind":"bot","localId":"bot"},"text":"","at":1,"sendId":"activity-step-\(state)","responseTo":"\(request)","kind":"activity","tool":{"name":"working","spoken":"Pixie is working on this"\(state == "start" ? "" : ",\"ok\":true")}}
            """
            return try JSONDecoder().decode(SharedChatMessage.self, from: Data(json.utf8))
        }
        let start = try row("start", 1)
        let otherOwner = try row("other-owner", 2, home: "two")
        let otherRequest = try row("other-request", 3, request: "request-b")
        let settled = try row("settled", 4, state: "ok")
        XCTAssertEqual(SharedChatMessage.visible([start, otherOwner, otherRequest, settled]).map(\.id), ["other-owner", "other-request", "settled"])
        XCTAssertEqual(settled.activityLabel, "Completed")
        XCTAssertEqual(otherRequest.replyReference, "request-b")
        XCTAssertEqual(start.activityLabel, "Pixie is working on this")
    }

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
