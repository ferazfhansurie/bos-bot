// The open thread's face reacts to how a turn ended (ios 1.9.4 idea 14).
import XCTest
@testable import CompanionCore

final class ThreadMoodTests: XCTestCase {
    private func user(_ id: String, _ body: String = "do it") -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: 1)
        message.text = body
        return message
    }

    private func reply(_ id: String, _ body: String) -> Message {
        var message = Message(id: id, role: .bot, kind: .text, at: 2)
        message.text = body
        return message
    }

    private func step(_ id: String, ok: Bool?) -> Message {
        var message = Message(id: id, role: .bot, kind: .activity, at: 2)
        message.tool = ToolActivity(name: "run", ok: ok)
        return message
    }

    private func card(_ id: String, pending: Bool) -> Message {
        var message = Message(id: id, role: .bot, kind: .options, at: 2)
        var card = OptionCard(title: "Allow?", subtitle: "", options: ["Allow", "Deny"])
        if pending { card.requestId = "req-\(id)" }
        message.card = card
        return message
    }

    func testAFinishedReplyIsProud() {
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), step("s", ok: true), reply("r", "done, it's live.")]), .proud)
    }

    func testAQuestionIsCurious() {
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), reply("r", "which one do you want?")]), .curious)
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), reply("r", "ship it **now?**")]), .curious)
    }

    func testAnOpenCardIsCurious() {
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), reply("r", "need your ok."), card("c", pending: true)]), .curious)
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), card("c", pending: false), reply("r", "done.")]), .proud)
    }

    func testEndingOnAFailedStepIsSheepish() {
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), reply("r", "trying"), step("s", ok: false)]), .sheepish)
        // a step that failed before the bot recovered and replied is not the ending
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), step("s", ok: false), reply("r", "fixed it.")]), .proud)
    }

    func testAFailedOrStoppedFeedIsSheepish() {
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), reply("r", "ok.")], feed: .failed), .sheepish)
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("u"), reply("r", "ok.")], feed: .stopped), .sheepish)
    }

    func testOnlyTheLatestTurnCounts() {
        XCTAssertEqual(ThreadMoodRules.mood(after: [user("a"), reply("q", "which?"), user("b"), reply("r", "done.")]), .proud)
    }

    func testNothingBackIsNoMood() {
        XCTAssertNil(ThreadMoodRules.mood(after: [user("u")]))
        XCTAssertNil(ThreadMoodRules.mood(after: []))
    }

    func testOnlyLongTurnsCelebrate() {
        XCTAssertFalse(ThreadMoodRules.celebrates(turnSeconds: 59))
        XCTAssertTrue(ThreadMoodRules.celebrates(turnSeconds: 61))
    }
}
