import XCTest
@testable import CompanionCore

final class MentionTests: XCTestCase {
    private func bot(_ id: String, _ name: String, title: String = "", hidden: Bool = false, remote: Bool = false) throws -> Bot {
        var bot = try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"\(id)","threadId":"t-\(id)","name":"\(name)","title":"\(title)","description":"","notifications":true,"color":"blue","unread":false,"modelSelection":{"instanceId":"local","model":"default"},"createdAt":1}
        """.utf8))
        bot.hidden = hidden ? true : nil
        if remote { bot.remote = BotRemote(homeId: "h", homeName: "Other", online: true) }
        return bot
    }

    private func room(_ members: [String], dm: Bool = false) throws -> Room {
        let ids = members.map { "\"\($0)\"" }.joined(separator: ",")
        return try JSONDecoder().decode(Room.self, from: Data(#"{"id":"r","threadId":"t","name":"HQ","memberIds":[\#(ids)],"defaultResponder":{"kind":"everyone"},"bulletin":"","unread":false,"createdAt":1\#(dm ? ",\"dm\":true" : "")}"#.utf8))
    }

    // MARK: pool

    func testRoomOffersEveryoneThenVisibleMembers() throws {
        let bots = [try bot("a", "pix"), try bot("b", "pipe", hidden: true), try bot("c", "dev"), try bot("d", "outsider")]
        let targets = MentionPool.targets(for: .room(try room(["a", "b", "c"])), bots: bots)
        XCTAssertEqual(targets.map(\.name), ["everyone", "pix", "dev"])
        XCTAssertTrue(targets[0].isEveryone)
        XCTAssertFalse(targets[1].isEveryone)
    }

    func testDirectRoomHasNoEveryone() throws {
        let bots = [try bot("a", "pix"), try bot("c", "dev")]
        XCTAssertEqual(MentionPool.targets(for: .room(try room(["a", "c"], dm: true)), bots: bots).map(\.name), ["pix", "dev"])
        XCTAssertTrue(MentionPool.targets(for: .room(try room([])), bots: bots).isEmpty, "An empty room offers nothing, not a lone @everyone")
    }

    func testBotChatOffersOtherLocalVisibleBots() throws {
        let me = try bot("me", "Scout")
        let bots = [me, try bot("p", "Pixel"), try bot("h", "Ghost", hidden: true), try bot("r", "Relay", remote: true), try bot("f", "Forge")]
        XCTAssertEqual(MentionPool.targets(for: .bot(me), bots: bots).map(\.name), ["Pixel", "Forge"])
    }

    // MARK: ranking

    func testRankingPutsPrefixThenWordThenContainsThenRoleThenFuzzy() throws {
        let targets = try [
            bot("1", "Ink", title: "Content writer"),
            bot("2", "Frontend Pix", title: "builder"),
            bot("3", "Pixel", title: "Designer"),
            bot("4", "Sapix", title: "x"),
            bot("5", "Nit", title: "QA for pix"),
            bot("6", "Pipe xen", title: "Backend"),
        ].map(MentionTarget.init(bot:))
        let ranked = MentionRanking.rank(targets, query: "pix")
        XCTAssertEqual(ranked.map(\.target.name), ["Pixel", "Frontend Pix", "Sapix", "Nit", "Pipe xen"])
        XCTAssertEqual(ranked[0].nameHighlights, [0..<3])
        XCTAssertEqual(ranked[1].nameHighlights, [9..<12])
        XCTAssertEqual(ranked[2].nameHighlights, [2..<5])
        XCTAssertNil(ranked[2].subtitleHighlight)
        XCTAssertEqual(ranked[3].subtitleHighlight, 7..<10)
        XCTAssertEqual(ranked[3].nameHighlights, [])
        XCTAssertEqual(ranked[4].nameHighlights, [0..<2, 5..<6])
    }

    func testRankingIsCaseInsensitiveAndEmptyQueryKeepsOrder() throws {
        let targets = [MentionTarget.everyone] + (try [bot("1", "Scout"), bot("2", "pixel")].map(MentionTarget.init(bot:)))
        XCTAssertEqual(MentionRanking.rank(targets, query: "").map(\.id), ["__everyone__", "1", "2"])
        XCTAssertEqual(MentionRanking.rank(targets, query: " ").count, 3)
        XCTAssertEqual(MentionRanking.rank(targets, query: "SC").map(\.target.name), ["Scout"])
        XCTAssertEqual(MentionRanking.rank(targets, query: "ever").map(\.target.name), ["everyone"])
        XCTAssertTrue(MentionRanking.rank(targets, query: "zzz").isEmpty)
    }

    func testRoleMatchesFromAWordStartOnly() throws {
        let targets = try [bot("1", "dev", title: "CTO · BOS platform"), bot("2", "pix", title: "Frontend builder")].map(MentionTarget.init(bot:))
        XCTAssertEqual(MentionRanking.rank(targets, query: "plat").map(\.target.name), ["dev"])
        XCTAssertEqual(MentionRanking.rank(targets, query: "build").map(\.target.name), ["pix"])
        XCTAssertEqual(MentionRanking.rank(targets, query: "latf").map(\.target.name), [], "mid-word role text is not a match")
        XCTAssertEqual(MentionRanking.rank(targets, query: "p").map(\.target.name), ["pix", "dev"], "names first, then a role word starting with it")
        XCTAssertEqual(MentionRanking.rank(targets, query: "a").map(\.target.name), [], "not every role with the letter somewhere in it")
    }

    func testSingleLetterDoesNotFuzzyMatch() throws {
        let targets = try [bot("1", "Forge")].map(MentionTarget.init(bot:))
        XCTAssertTrue(MentionRanking.rank(targets, query: "g").map(\.target.name) == ["Forge"], "contained letter still matches")
        XCTAssertEqual(MentionRanking.rank(targets, query: "fg").first?.nameHighlights, [0..<1, 3..<4])
        XCTAssertTrue(MentionRanking.rank(targets, query: "gf").isEmpty, "letters must appear in order")
    }

    // MARK: spans

    func testSpansFindWholeNamesAfterStandaloneAtLongestFirst() {
        let peers = [MentionPeer(id: "a", name: "pix"), MentionPeer(id: "b", name: "pix2"), MentionPeer(id: "c", name: "Scout Bot")]
        let text = "@pix2 and @PIX, ask @scout bot. mail@pix @pixel @ghost"
        let spans = MentionSpans.find(in: text, peers: peers)
        XCTAssertEqual(spans.map(\.peer?.id), ["b", "a", "c"])
        let chars = Array(text)
        XCTAssertEqual(spans.map { String(chars[$0.range]) }, ["@pix2", "@PIX", "@scout bot"])
    }

    func testSpansEveryoneOnlyWhenTheRoomHasIt() {
        XCTAssertTrue(MentionSpans.find(in: "@everyone go", peers: []).isEmpty)
        let spans = MentionSpans.find(in: "@everyone go", peers: [], everyone: true)
        XCTAssertEqual(spans.map(\.range), [0..<9])
        XCTAssertNil(spans.first?.peer)
        XCTAssertTrue(MentionSpans.find(in: "@everyones", peers: [], everyone: true).isEmpty)
    }

    func testSpansSkipHiddenPeersAndTextWithoutAt() {
        XCTAssertTrue(MentionSpans.find(in: "@ghost hi", peers: [MentionPeer(id: "g", name: "ghost", hidden: true)]).isEmpty)
        XCTAssertTrue(MentionSpans.find(in: "pix hi", peers: [MentionPeer(id: "a", name: "pix")]).isEmpty)
    }

    // MARK: outgoing

    func testEveryonePickSendsAsPlainText() throws {
        let dev = MentionTarget(bot: try bot("1", "dev"))
        XCTAssertEqual(ChannelMentionPicker.outgoing("ship it @", targets: [.everyone, dev]), "@everyone @dev ship it")
        XCTAssertEqual(ChannelMentionPicker.outgoing("@everyone look", targets: [.everyone]), "@everyone look")
        XCTAssertEqual(ChannelMentionPicker.outgoing("ok @dev\nthanks", targets: [dev]), "ok @dev\nthanks")
    }
}
