// The 3.0 thread worker's brain, matched against the desktop's
// src/components/v3/thread-worker.test.ts and the choices in ThreadWorker.tsx.
import XCTest
@testable import CompanionCore

final class ThreadWorkerTests: XCTestCase {
    private var n = 0

    private func user(steered: Bool? = nil, delivery: String? = nil) -> Message {
        n += 1
        var message = Message(id: "u\(n)", role: .user, kind: .text, at: Double(n), text: "hi")
        message.steered = steered
        message.steerDelivery = delivery
        return message
    }

    private func bot() -> Message {
        n += 1
        return Message(id: "b\(n)", role: .bot, kind: .text, at: Double(n), text: "ok")
    }

    private func tool(_ ok: Bool? = nil, name: String = "Read", comm: Bool = false) -> Message {
        n += 1
        var message = Message(id: "t\(n)", role: .bot, kind: .activity, at: Double(n))
        message.tool = ToolActivity(name: name, ok: ok)
        if comm { message.comm = CommChip(groupId: "g", withBotId: "b", withName: "Pepper", withColor: "blue") }
        return message
    }

    // MARK: turnSteps

    func testTurnStepsCountsToolsAfterTheTurnStartAcrossMidTurnSends() {
        let messages = [user(), tool(true), bot(), user(), tool(true), user(steered: true), tool()]
        XCTAssertEqual(ThreadWorker.turnSteps(messages).map(\.id), [messages[4].id, messages[6].id])
    }

    func testTurnStepsLeavesOutBotChipsAndFailedTurnRows() {
        let messages = [user(), tool(true, comm: true), tool(false, name: "error: boom"), tool(true)]
        XCTAssertEqual(ThreadWorker.turnSteps(messages).count, 1)
    }

    func testTurnStepsWithoutAUserMessageTakesTheWholeThread() {
        XCTAssertEqual(ThreadWorker.turnSteps([tool(true), bot(), tool()]).count, 2)
    }

    // MARK: doneTrail

    func testDoneTrailKeepsTheLastThreeFinishedStepsOldestFirst() {
        let steps = [tool(true), tool(true), tool(false), tool(true), tool()]
        XCTAssertEqual(ThreadWorker.doneTrail(steps).map(\.id), steps[1...3].map(\.id))
    }

    // MARK: steerReads

    func testSteerWaitsUntilSomethingNewLandsAfterIt() {
        let first = user(), running = tool(), steer = user(steered: true)
        XCTAssertEqual(ThreadWorker.steerReads([first, running, steer], busy: true)[steer.id], .waiting)
        XCTAssertEqual(ThreadWorker.steerReads([first, running, steer, tool()], busy: true)[steer.id], .read)
    }

    func testAFinishedTurnCountsAsReadAndUnknownDeliveriesAreSkipped() {
        let steer = user(steered: true)
        let unknown = user(steered: true, delivery: "outcome_unknown")
        let reads = ThreadWorker.steerReads([user(), steer, unknown], busy: false)
        XCTAssertEqual(reads[steer.id], .read)
        XCTAssertNil(reads[unknown.id])
    }

    func testPlainSendsAreIgnored() {
        XCTAssertTrue(ThreadWorker.steerReads([user(), bot()], busy: true).isEmpty)
    }

    func testDeliveryAloneNeverMarksRead() {
        let steer = user(steered: true, delivery: "provider_accepted")
        XCTAssertEqual(ThreadWorker.steerReads([user(), tool(), steer], busy: true)[steer.id], .waiting)
    }

    // MARK: lastNewsAt / slow

    func testLastNewsIsTheNewestRowOrTheTurnStart() {
        XCTAssertNil(ThreadWorker.lastNewsAt([user()], since: nil))
        var early = user(); early.at = 50
        var late = user(); late.at = 150
        XCTAssertEqual(ThreadWorker.lastNewsAt([early], since: 100), 100)
        XCTAssertEqual(ThreadWorker.lastNewsAt([late], since: 100), 150)
        XCTAssertEqual(ThreadWorker.lastNewsAt([], since: 100), 100)
    }

    func testSlowAfterFortyFiveQuietSeconds() {
        XCTAssertEqual(ThreadWorker.slowSeconds, 45)
        XCTAssertFalse(ThreadWorker.isSlow(now: 44_999, lastNews: 0, finishing: false, needsYou: false))
        XCTAssertTrue(ThreadWorker.isSlow(now: 45_000, lastNews: 0, finishing: false, needsYou: false))
        XCTAssertFalse(ThreadWorker.isSlow(now: 90_000, lastNews: 0, finishing: true, needsYou: false))
        XCTAssertFalse(ThreadWorker.isSlow(now: 90_000, lastNews: 0, finishing: false, needsYou: true))
        XCTAssertFalse(ThreadWorker.isSlow(now: 90_000, lastNews: nil, finishing: false, needsYou: false))
    }

    // MARK: lines and faces

    func testPickMatchesTheDesktopHash() {
        // expected values printed by the desktop's `pick` (alive-mood.ts)
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.doneLines, seed: "abc"), "that's a wrap")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.gotItLines, seed: "abc"), "on it")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.doneLines, seed: "u12"), "all yours")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.gotItLines, seed: "u12"), "heard you. adding that in")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.doneLines, seed: "héllo 😀"), "there you go")
        // long seeds wrap at 32 bits and go negative
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.doneLines, seed: "a-very-long-thread-id-0123456789:1789088500123"), "that's a wrap")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.gotItLines, seed: "a-very-long-thread-id-0123456789:1789088500123"), "heard you. adding that in")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.doneLines, seed: "preview-forge:1789088500000"), "all yours")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.gotItLines, seed: "preview-forge:1789088500000"), "got it")
        XCTAssertEqual(ThreadWorker.pick(ThreadWorker.doneFaces, seed: "u12"), .proud)
        XCTAssertEqual(ThreadWorker.pick([GlyphFaceState.wink, .happy], seed: "x"), .happy)
    }

    func testTurnKeyPrintsLikeJavaScript() {
        XCTAssertEqual(ThreadWorker.turnKey(threadId: "t", since: 1789088500000), "t:1789088500000")
        XCTAssertEqual(ThreadWorker.turnKey(threadId: "t", since: nil), "t:0")
    }

    func testStepCount() {
        XCTAssertEqual(ThreadWorker.stepCount(1), "1 step")
        XCTAssertEqual(ThreadWorker.stepCount(4), "4 steps")
    }

    func testFaceOrder() {
        let read = ThreadWorker.Reaction(kind: .read, id: "t1:0")
        let noticed = ThreadWorker.Reaction(kind: .noticed, id: "x")
        XCTAssertEqual(ThreadWorker.face(finishing: true, stepCount: 12, turnKey: "u12", reaction: read, needsYou: false, slow: false), .nailedIt)
        XCTAssertEqual(ThreadWorker.face(finishing: true, stepCount: 2, turnKey: "u12", reaction: nil, needsYou: false, slow: false), .proud)
        XCTAssertEqual(ThreadWorker.face(finishing: false, stepCount: 2, turnKey: "k", reaction: read, needsYou: true, slow: true), .wink)
        XCTAssertEqual(ThreadWorker.face(finishing: false, stepCount: 2, turnKey: "k", reaction: noticed, needsYou: true, slow: true), .noticed)
        XCTAssertEqual(ThreadWorker.face(finishing: false, stepCount: 2, turnKey: "k", reaction: nil, needsYou: true, slow: true), .waiting)
        XCTAssertEqual(ThreadWorker.face(finishing: false, stepCount: 2, turnKey: "k", reaction: nil, needsYou: false, slow: true), .determined)
        XCTAssertNil(ThreadWorker.face(finishing: false, stepCount: 2, turnKey: "k", reaction: nil, needsYou: false, slow: false))
    }

    func testSayOnlyWhenDoneOrRead() {
        XCTAssertEqual(ThreadWorker.say(finishing: true, turnKey: "abc", reaction: nil), "that's a wrap")
        XCTAssertEqual(ThreadWorker.say(finishing: false, turnKey: "k", reaction: .init(kind: .read, id: "abc")), "on it")
        XCTAssertNil(ThreadWorker.say(finishing: false, turnKey: "k", reaction: .init(kind: .noticed, id: "abc")))
        XCTAssertNil(ThreadWorker.say(finishing: false, turnKey: "k", reaction: nil))
    }

    // MARK: reactions

    func testOldNewsNeverReactsAndEachChangeReactsOnce() {
        var reactions = ThreadWorker.Reactions(oldNews: "s0")
        XCTAssertNil(reactions.note(id: "s0", read: .read))
        XCTAssertNil(reactions.note(id: nil, read: nil))
        let noticed = reactions.note(id: "s1", read: .waiting)
        XCTAssertEqual(noticed, .init(kind: .noticed, id: "s1"))
        XCTAssertEqual(noticed?.holdSeconds, 1.4)
        XCTAssertNil(reactions.note(id: "s1", read: .waiting))
        let read = reactions.note(id: "s1", read: .read)
        XCTAssertEqual(read, .init(kind: .read, id: "s1"))
        XCTAssertEqual(read?.holdSeconds, 2.4)
        XCTAssertNil(reactions.note(id: "s1", read: .read))
    }

    // MARK: step labels

    func testStepLabelNamesFinishedStepsToo() {
        XCTAssertEqual(LiveActivityLine.stepLabel(for: tool(true, name: "Bash")), "Running a command")
        XCTAssertEqual(LiveActivityLine.stepLabel(for: tool(false, name: "mcp__fs__read_file")), "Reading a file")
        var spoken = tool(true, name: "Bash")
        spoken.tool?.spoken = "checked the manifest."
        XCTAssertEqual(LiveActivityLine.stepLabel(for: spoken), "Checked the manifest")
        XCTAssertEqual(LiveActivityLine.stepLabel(for: tool(true, name: "frobnicate")), "Working")
        XCTAssertEqual(LiveActivityLine.stepLabel(for: bot()), "Working")
    }

    func testDoneBeatMatchesTheDesktopHold() {
        XCTAssertEqual(LiveIslandState.doneBeat, ThreadWorker.doneSeconds)
    }
}
