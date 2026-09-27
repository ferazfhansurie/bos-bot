// Remote bots (a linked Mac's bots proxied through this home) share the
// local bot shape plus an optional `remote` object. Shared-room messages can
// be activity lines with a tool and empty text.
import XCTest
@testable import CompanionCore

final class RemoteBotTests: XCTestCase {
    private func fixtureBotJSON() throws -> [String: Any] {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-full", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-full", withExtension: "json")
        )
        let fleet = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let bots = try XCTUnwrap(fleet["bots"] as? [[String: Any]])
        return try XCTUnwrap(bots.first)
    }

    func testLocalBotHasNoRemote() throws {
        let bot = try JSONDecoder().decode(Bot.self, from: JSONSerialization.data(withJSONObject: fixtureBotJSON()))
        XCTAssertNil(bot.remote)
        XCTAssertFalse(bot.isRemote)
        XCTAssertFalse(Chat.bot(bot).isRemoteBot)
    }

    func testRemoteBotDecodesAndSurvivesABotFrame() throws {
        var json = try fixtureBotJSON()
        json["id"] = "rb-0123456789ab-bot1"
        json["threadId"] = "rt-0123456789ab-pending-bot1"
        json["computer"] = "off"
        json["remote"] = ["homeId": "home-b", "homeName": "Studio Mac", "ownerName": NSNull()]
        let bot = try JSONDecoder().decode(Bot.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(bot.remote, BotRemote(homeId: "home-b", homeName: "Studio Mac", ownerName: nil))
        XCTAssertTrue(Chat.bot(bot).isRemoteBot)
        XCTAssertEqual(Chat.bot(bot).remoteHomeName, "Studio Mac")
        XCTAssertTrue(Chat.bot(bot).subtitle.hasSuffix("on Studio Mac"))

        // Round-trips through encode.
        let again = try JSONDecoder().decode(Bot.self, from: JSONEncoder().encode(bot))
        XCTAssertEqual(again.remote, bot.remote)

        // A bot frame (first send creates the real thread) keeps `remote`.
        var state = CompanionState()
        state.apply(Frame.bot(bot))
        var moved = json
        moved["threadId"] = "rt-0123456789ab-thread9"
        moved.removeValue(forKey: "messages")
        let movedBot = try JSONDecoder().decode(Bot.self, from: JSONSerialization.data(withJSONObject: moved))
        state.apply(Frame.bot(movedBot))
        XCTAssertEqual(state.bots.first { $0.id == bot.id }?.remote?.homeName, "Studio Mac")
        XCTAssertEqual(state.bots.first { $0.id == bot.id }?.threadId, "rt-0123456789ab-thread9")
    }

    func testSharedActivityMessageDecodes() throws {
        let data = Data(#"""
        {"messages":[
          {"id":"m1","roomId":"r","sequence":1,"actor":{"homeId":"h","kind":"bot","localId":"b"},
           "text":"","at":1,"sendId":"s1","kind":"activity","tool":{"name":"Bash","ok":false,"spoken":"ran a command"}},
          {"id":"m2","roomId":"r","sequence":2,"actor":{"homeId":"h","kind":"person","localId":"p"},
           "text":"hi","at":2,"sendId":"s2"}
        ]}
        """#.utf8)
        let messages = try JSONDecoder().decode(SharedMessagesResponse.self, from: data).messages
        XCTAssertTrue(messages[0].isActivity)
        XCTAssertEqual(messages[0].tool?.name, "Bash")
        XCTAssertEqual(messages[0].tool?.ok, false)
        XCTAssertEqual(messages[0].tool?.spoken, "ran a command")
        XCTAssertFalse(messages[1].isActivity)
        XCTAssertNil(messages[1].tool)
    }
}
