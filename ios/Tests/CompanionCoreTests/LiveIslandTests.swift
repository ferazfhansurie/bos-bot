// The 3.0 island's line and beats, matched against the desktop's
// src/lib/live-activity.test.ts and the island effects in ChatView.tsx.
import XCTest
@testable import CompanionCore

final class LiveActivityLineTests: XCTestCase {
    private func tool(_ name: String, ok: Bool? = nil, spoken: String? = nil) -> Message {
        var message = Message(id: "a", role: .bot, kind: .activity, at: 1)
        message.tool = ToolActivity(name: name, ok: ok, spoken: spoken)
        return message
    }

    func testThinkingWithoutARunningTool() {
        XCTAssertEqual(LiveActivityLine.label(for: nil), "Thinking")
        XCTAssertEqual(LiveActivityLine.label(for: Message(id: "t", role: .bot, kind: .text, at: 1, text: "hi")), "Thinking")
        // a settled tool is no longer the current verb
        XCTAssertEqual(LiveActivityLine.label(for: tool("Bash", ok: true)), "Thinking")
        XCTAssertEqual(LiveActivityLine.label(for: tool("Bash", ok: false)), "Thinking")
        // a teammate chip is a receipt, not work in flight
        var chip = tool("ask_bot")
        chip.comm = CommChip(groupId: "g", withBotId: "b", withName: "Pepper", withColor: "blue")
        XCTAssertEqual(LiveActivityLine.label(for: chip), "Thinking")
    }

    func testSpokenNarrationWinsAndIsSentenceCased() {
        XCTAssertEqual(LiveActivityLine.label(for: tool("Bash", spoken: "checking the build...  ")), "Checking the build")
        XCTAssertEqual(LiveActivityLine.label(for: tool("Bash", spoken: "   ")), "Running a command")
    }

    func testFallbackByToolName() {
        let cases: [(String, String)] = [
            ("Bash", "Running a command"),
            ("Read", "Reading a file"),
            ("Write", "Writing a file"),
            ("apply_patch", "Editing a file"),
            ("WebSearch", "Working"),
            ("web_search", "Searching the web"),
            ("web_fetch", "Reading a page"),
            ("Grep", "Searching"),
            ("mcp__computer__screenshot", "Looking at the screen"),
            ("mcp__computer__click", "Using the computer"),
            ("mcp__browser__navigate", "Opening a page"),
            ("mcp__agents__list_bots", "Checking who's around"),
            ("mcp__agents__list_rooms", "Checking the groups"),
            ("mcp__agents__post_to_room", "Posting in a group"),
            ("mcp__agents__delegate_bot", "Handing off a task"),
            ("mcp__agents__ask_bot", "Asking a teammate"),
            ("Bash:git status", "Running a command"),
            ("mcp__agents__memory_update", "Working"),
        ]
        for (name, label) in cases {
            XCTAssertEqual(LiveActivityLine.label(for: tool(name)), label, name)
        }
    }

    func testWholeWordsOnly() {
        // `read_file` matches as itself, never as `read` inside a longer word
        XCTAssertEqual(LiveActivityLine.label(for: tool("read_file")), "Reading a file")
        XCTAssertEqual(LiveActivityLine.label(for: tool("reader")), "Working")
        XCTAssertEqual(LiveActivityLine.label(for: tool("computer_use")), "Working")
        // a server name with an underscore is not stripped, as on desktop
        XCTAssertEqual(LiveActivityLine.toolName("mcp__my_server__click"), "mcp__my_server__click")
        XCTAssertEqual(LiveActivityLine.toolName("mcp__x__click:left"), "click")
    }
}

final class LiveIslandAskTests: XCTestCase {
    func testNewestPendingCardQuestion() {
        var old = Message(id: "old", role: .bot, kind: .options, at: 1)
        old.card = OptionCard(title: "Run shell?", subtitle: "echo", options: ["Allow", "Deny"], requestId: "r1", tool: "shell")
        var answered = Message(id: "done", role: .bot, kind: .options, at: 2)
        answered.card = OptionCard(title: "Earlier?", subtitle: "", options: ["Yes"], answered: "Yes", requestId: "r0")
        XCTAssertEqual(LiveIslandAsk.pending(in: [old, answered])?.messageId, "old")
        XCTAssertEqual(LiveIslandAsk.pending(in: [old, answered])?.line, "Run shell?")

        var ask = Message(id: "ask", role: .bot, kind: .options, at: 3)
        ask.card = OptionCard(title: "Question", subtitle: "", options: [], requestId: "r2",
                              questionRequest: QuestionRequestCardData(questions: [AskQuestion(question: "Which day works?", options: [])]))
        XCTAssertEqual(LiveIslandAsk.pending(in: [old, ask])?.line, "Which day works?")
        XCTAssertEqual(LiveIslandAsk.pending(in: [old, ask])?.messageId, "ask")
    }

    func testSecretAndNothing() {
        var secret = Message(id: "s", role: .bot, kind: .secret, at: 1)
        secret.secret = SecretRequestCardData(label: "OpenAI key")
        XCTAssertEqual(LiveIslandAsk.pending(in: [secret])?.line, "Needs OpenAI key")
        secret.secret?.provided = true
        XCTAssertNil(LiveIslandAsk.pending(in: [secret]))
        XCTAssertNil(LiveIslandAsk.pending(in: []))
    }
}

final class LiveIslandStateTests: XCTestCase {
    func testOffUnlessEnabled() {
        var island = LiveIslandState()
        island.show(thread: "t", busy: true)
        XCTAssertEqual(island.phase(enabled: false, needsYou: false), .off)
        XCTAssertFalse(island.composerFolded(enabled: false, needsYou: false, focused: false))
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .working)
    }

    func testWorkingNeedsYouDoneThenSettles() {
        var island = LiveIslandState()
        island.show(thread: "t", busy: false)
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .off)
        XCTAssertFalse(island.busyChanged(true))
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .working)
        XCTAssertTrue(island.composerFolded(enabled: true, needsYou: false, focused: false))
        XCTAssertEqual(island.phase(enabled: true, needsYou: true), .needsYou)
        // needing you never hides the composer
        XCTAssertFalse(island.composerFolded(enabled: true, needsYou: true, focused: false))

        XCTAssertTrue(island.busyChanged(false))
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .done)
        XCTAssertFalse(island.composerFolded(enabled: true, needsYou: false, focused: false))
        island.settle(beat: island.beat)
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .off)
    }

    func testIdleToIdleIsNoDoneBeat() {
        var island = LiveIslandState()
        island.show(thread: "t", busy: false)
        XCTAssertFalse(island.busyChanged(false))
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .off)
    }

    func testStaleSettleKeepsANewerBeat() {
        var island = LiveIslandState()
        island.show(thread: "t", busy: true)
        island.busyChanged(false)
        let first = island.beat
        island.busyChanged(true)
        island.busyChanged(false)
        island.settle(beat: first)
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .done)
        island.settle(beat: island.beat)
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .off)
    }

    func testThreadSwitchResetsWithoutDone() {
        var island = LiveIslandState()
        island.show(thread: "a", busy: true)
        island.openComposer()
        island.show(thread: "b", busy: false)
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .off)
        XCTAssertFalse(island.open)
        // same thread again only reports the busy change
        island.show(thread: "b", busy: true)
        XCTAssertEqual(island.phase(enabled: true, needsYou: false), .working)
        XCTAssertFalse(island.open)
    }

    func testOpenAndFocusUnfoldTheComposer() {
        var island = LiveIslandState()
        island.show(thread: "t", busy: true)
        XCTAssertFalse(island.composerFolded(enabled: true, needsYou: false, focused: true))
        island.openComposer()
        XCTAssertFalse(island.composerFolded(enabled: true, needsYou: false, focused: false))
        // the turn ending closes it again
        island.busyChanged(false)
        island.busyChanged(true)
        XCTAssertTrue(island.composerFolded(enabled: true, needsYou: false, focused: false))
        // tapping while idle does nothing
        var idle = LiveIslandState()
        idle.show(thread: "t", busy: false)
        idle.openComposer()
        XCTAssertFalse(idle.open)
    }
}

final class LiveIslandSteerTests: XCTestCase {
    private func user(_ id: String, steered: Bool? = nil) -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: 1, text: id)
        message.steered = steered
        return message
    }
    private let bot = Message(id: "b", role: .bot, kind: .text, at: 1, text: "ok")

    func testFindsWordsTheRunningTurnTookIn() {
        XCTAssertEqual(LiveIslandSteer.lastSteeredId(in: [user("a"), bot, user("c", steered: true), bot]), "c")
    }

    func testOlderSteerUnknownOutcomeAndEmptyDoNotCount() {
        XCTAssertNil(LiveIslandSteer.lastSteeredId(in: [user("a", steered: true), bot, user("c")]))
        XCTAssertNil(LiveIslandSteer.lastSteeredId(in: [user("a", steered: false)]))
        XCTAssertNil(LiveIslandSteer.lastSteeredId(in: []))
    }

    func testFreshOnlyForANewSteerInTheSameWorkingThread() {
        var seen = LiveIslandSteer.Seen()
        XCTAssertFalse(seen.note(.init(thread: "t1", id: "old"), working: true)) // opening the thread
        XCTAssertTrue(seen.note(.init(thread: "t1", id: "new"), working: true))
        XCTAssertFalse(seen.note(.init(thread: "t1", id: "new"), working: true))
        XCTAssertFalse(seen.note(.init(thread: "t1", id: nil), working: true))
        XCTAssertFalse(seen.note(.init(thread: "t1", id: "later"), working: false))
        XCTAssertFalse(seen.note(.init(thread: "t2", id: "other"), working: true))
    }

    func testASteerThatComesBackBehindAQueuedSendIsNotNew() {
        var seen = LiveIslandSteer.Seen()
        _ = seen.note(.init(thread: "t1", id: nil), working: true)
        XCTAssertTrue(seen.note(.init(thread: "t1", id: "c"), working: true))
        XCTAssertFalse(seen.note(.init(thread: "t1", id: nil), working: true)) // the queued send, for a moment
        XCTAssertFalse(seen.note(.init(thread: "t1", id: "c"), working: true))
    }
}

/// The car's glance (CarPlay draws the activity's small family).
final class CarGlanceTests: XCTestCase {
    private func content(_ kind: String, line: String = "running tests", title: String? = "ios: live activity polish for carplay") -> BotActivityContent {
        BotActivityContent(face: "working", kind: kind, headline: "bos", line: line, threadId: "t1", card: nil,
                           since: Date(timeIntervalSince1970: 100), threadTitle: title)
    }

    func testSummarySaysEveryBusyBotOrNothingForOne() {
        XCTAssertNil(CarGlance.summary(working: 1, needsYou: 0))
        XCTAssertNil(CarGlance.summary(working: 0, needsYou: 0))
        XCTAssertEqual(CarGlance.summary(working: 3, needsYou: 1), "3 working · 1 needs you")
        XCTAssertEqual(CarGlance.summary(working: 0, needsYou: 2), "2 need you")
    }

    func testTitleIsFiveWordsAtMost() {
        XCTAssertEqual(CarGlance.shortTitle("ios: live activity polish for carplay"), "ios: live activity polish for…")
        XCTAssertEqual(CarGlance.shortTitle("ad e watch"), "ad e watch")
        XCTAssertNil(CarGlance.shortTitle("  "))
    }

    func testStateWordAndLine() {
        XCTAssertEqual(CarGlance.stateWord(content("working")), "working")
        XCTAssertEqual(CarGlance.detail(content("working")), "ios: live activity polish for…")
        XCTAssertEqual(CarGlance.detail(content("working", title: nil)), "running tests")
        let done = content("done", line: "ad e: rm18 spent, 2 sign-ups")
        XCTAssertEqual(CarGlance.stateWord(done), "done")
        XCTAssertEqual(CarGlance.detail(done), "ad e: rm18 spent, 2 sign-ups")
        XCTAssertEqual(CarGlance.stateWord(content("needsYou")), "needs you")
    }

    func testACallTakesTheStateWordAndTheClock() {
        var c = content("working")
        c.call = LiveCallPhase.sending(to: "money").word
        c.callSince = Date(timeIntervalSince1970: 500)
        XCTAssertEqual(CarGlance.stateWord(c), "sending to money")
        XCTAssertEqual(CarGlance.since(c), Date(timeIntervalSince1970: 500))
        XCTAssertEqual(CarGlance.relevance(c), 100)
        var callOnly = content("call", line: LiveCallPhase.listening.word, title: nil)
        callOnly.call = LiveCallPhase.listening.word
        XCTAssertEqual(CarGlance.stateWord(callOnly), "listening")
        XCTAssertNil(CarGlance.detail(callOnly))
        XCTAssertGreaterThan(CarGlance.relevance(content("needsYou")), CarGlance.relevance(content("working")))
    }

    func testOldActivitiesStillDecode() throws {
        // content an older build started: no summary, call or callSince
        let old = #"{"face":"working","kind":"working","headline":"bos is working","line":"thinking","options":[],"isPermission":false,"since":0}"#
        let decoded = try JSONDecoder().decode(BotActivityContent.self, from: Data(old.utf8))
        XCTAssertNil(decoded.summary)
        XCTAssertNil(decoded.call)
        XCTAssertEqual(CarGlance.stateWord(decoded), "working")
        let pushed = #"{"face":"working","kind":"working","headline":"bos is working","line":"thinking","options":[],"isPermission":false,"since":0,"summary":"2 working"}"#
        XCTAssertEqual(try JSONDecoder().decode(BotActivityContent.self, from: Data(pushed.utf8)).summary, "2 working")
    }
}
