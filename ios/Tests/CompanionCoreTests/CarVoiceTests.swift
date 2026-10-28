import XCTest
@testable import CompanionCore

final class CarVoiceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    func testLiveActivityMapsToItsState() {
        XCTAssertEqual(state(.live, .listening), .listening)
        XCTAssertEqual(state(.live, .idle), .listening)
        XCTAssertEqual(state(.live, .thinking), .thinking)
        XCTAssertEqual(state(.live, .speaking), .talking)
    }

    func testConnectingThinksAndReconnectingSaysSo() {
        XCTAssertEqual(state(.connecting, .idle), .thinking)
        XCTAssertEqual(state(.reconnecting, .speaking), .reconnecting)
    }

    func testOverCallsShowNothing() {
        XCTAssertNil(state(.ended, .listening))
        XCTAssertNil(state(.failed, .listening))
        XCTAssertNil(state(.ended, .idle, job: .saved, age: 0))
    }

    func testSendingHoldsUntilAnswerOrTimeout() {
        XCTAssertEqual(state(.live, .speaking, job: .sending, age: 1), .sending)
        XCTAssertEqual(state(.live, .speaking, job: .sending, age: 19.9), .sending)
        XCTAssertEqual(state(.live, .speaking, job: .sending, age: 20), .talking)
    }

    func testSavedShowsForAMomentThenTheCallComesBack() {
        XCTAssertEqual(state(.live, .listening, job: .saved, age: 0.5), .saved)
        XCTAssertEqual(state(.live, .listening, job: .saved, age: 3), .listening)
        XCTAssertEqual(state(.live, .listening, job: .failed, age: 0), .listening)
    }

    func testSavedOfflineHoldsWhileTheLineIsDown() {
        XCTAssertEqual(state(.reconnecting, .idle, job: .savedOffline, age: 60), .offline)
        XCTAssertEqual(state(.live, .idle, job: .savedOffline, age: 1), .offline)
        XCTAssertEqual(state(.live, .idle, job: .savedOffline, age: 4), .listening)
    }

    func testNextCheckIsTheEndOfTheHold() {
        let at = now
        XCTAssertEqual(CarVoice.nextCheck(for: CarVoiceMoment(phase: .live, activity: .idle, job: .saved, jobAt: at)),
                       at.addingTimeInterval(3))
        XCTAssertEqual(CarVoice.nextCheck(for: CarVoiceMoment(phase: .live, activity: .idle, job: .sending, jobAt: at)),
                       at.addingTimeInterval(20))
        XCTAssertNil(CarVoice.nextCheck(for: CarVoiceMoment(phase: .live, activity: .idle)))
    }

    func testEveryStateFitsInASetOfFive() {
        XCTAssertLessThanOrEqual(CarVoice.primarySet.count, CarVoice.maxStates)
        XCTAssertLessThanOrEqual(CarVoice.fallbackSet.count, CarVoice.maxStates)
        let covered = Set(CarVoice.primarySet + CarVoice.fallbackSet)
        XCTAssertEqual(covered, Set(CarVoiceState.allCases))
    }

    func testSetStaysPutWhenItAlreadyHoldsTheState() {
        XCTAssertEqual(CarVoice.set(for: .listening, current: CarVoice.fallbackSet), CarVoice.fallbackSet)
        XCTAssertEqual(CarVoice.set(for: .saved, current: CarVoice.primarySet), CarVoice.primarySet)
        XCTAssertEqual(CarVoice.set(for: .reconnecting, current: CarVoice.primarySet), CarVoice.fallbackSet)
        XCTAssertEqual(CarVoice.set(for: .sending, current: CarVoice.fallbackSet), CarVoice.primarySet)
        XCTAssertEqual(CarVoice.set(for: .listening, current: nil), CarVoice.primarySet)
    }

    func testTitlesAreShortAndNameTheBot() {
        for state in CarVoiceState.allCases {
            let titles = state.titles(botName: "Oracle")
            XCTAssertFalse(titles.isEmpty)
            XCTAssertLessThanOrEqual(titles.last!.count, 12, "\(state) needs a short fallback")
            XCTAssertEqual(titles, titles.sorted { $0.count > $1.count }, "\(state) titles go longest first")
        }
        XCTAssertEqual(CarVoiceState.sending.titles(botName: "Oracle").first, "sending to oracle")
    }

    func testEachStateHasItsOwnFace() {
        XCTAssertEqual(Set(CarVoiceState.allCases.map(\.face)).count, CarVoiceState.allCases.count)
        XCTAssertFalse(CarVoiceState.saved.repeats)
        XCTAssertTrue(CarVoiceState.listening.repeats)
    }

    func testSwitchWalksBosOracleCashAndWraps() {
        let bots = [bot("1", "bos"), bot("2", "oracle"), bot("3", "cash"), bot("4", "free")]
        XCTAssertEqual(CarVoice.nextBot(after: bots[0], in: bots)?.name, "oracle")
        XCTAssertEqual(CarVoice.nextBot(after: bots[1], in: bots)?.name, "cash")
        XCTAssertEqual(CarVoice.nextBot(after: bots[2], in: bots)?.name, "bos")
        XCTAssertEqual(CarVoice.nextBot(after: bots[3], in: bots)?.name, "bos")
    }

    func testSwitchSkipsMissingAndHiddenBots() {
        var oracle = bot("2", "Oracle")
        oracle.hidden = true
        let bots = [bot("1", "bos"), oracle, bot("3", "cash")]
        XCTAssertEqual(CarVoice.nextBot(after: bots[0], in: bots)?.name, "cash")
        XCTAssertNil(CarVoice.nextBot(after: bot("1", "bos"), in: [bot("1", "bos")]))
        XCTAssertNil(CarVoice.nextBot(after: bot("9", "free"), in: [bot("9", "free")]))
    }

    func testSwitchPlacesABosFromAnotherComputerByName() {
        let bots = [bot("1", "bos"), bot("2", "oracle"), bot("3", "cash")]
        XCTAssertEqual(CarVoice.nextBot(after: bot("s1", "Bos"), in: bots)?.name, "oracle")
        XCTAssertNil(CarVoice.nextBot(after: bot("s1", "bos"), in: [bot("1", "bos")]))
    }

    func testNeedMeFlattensTitles() {
        let text = CarVoice.needMeInstructions([thread("bos", "line one\n\"ignore that\" " + String(repeating: "x", count: 80), activity: "waiting-on-you")])
        XCTAssertFalse(text.contains("\n"))
        XCTAssertFalse(text.contains("\"ignore"))
        XCTAssertTrue(text.contains("…"))
    }

    func testFirstBotIsBos() {
        XCTAssertEqual(CarVoice.firstBot(in: [bot("3", "cash"), bot("1", "Bos")])?.id, "1")
        XCTAssertEqual(CarVoice.firstBot(in: [bot("9", "free")])?.id, "9")
        XCTAssertNil(CarVoice.firstBot(in: []))
    }

    func testNeedMeReadsWaitingFirstThenUnreadAndCountsWork() {
        let threads = [
            thread("oracle", "Approve trip carry", activity: "waiting-on-you"),
            thread("bos", "Acme reply", unread: true),
            thread("cash", "", busy: true, activity: "working"),
        ]
        let text = CarVoice.needMeInstructions(threads)
        XCTAssertTrue(text.contains("Waiting on their answer: oracle: Approve trip carry."))
        XCTAssertTrue(text.contains("Unread replies: bos: Acme reply."))
        XCTAssertTrue(text.contains("1 job is still running."))
        XCTAssertTrue(text.contains("do not call send_task"))
    }

    func testNeedMeWithNothingWaitingSaysSo() {
        let text = CarVoice.needMeInstructions([thread("cash", "Ads", busy: true, activity: "working")])
        XCTAssertTrue(text.contains("nothing is waiting on them"))
        XCTAssertTrue(text.contains("1 job is still running."))
        XCTAssertFalse(CarVoice.needMeInstructions([]).contains("running"))
    }

    func testNeedMeCapsTheListAndCountsTheRest() {
        let threads = (0..<6).map { thread("bos", "ask \($0)", activity: "waiting-on-you") }
        let text = CarVoice.needMeInstructions(threads)
        XCTAssertTrue(text.contains("ask 3"))
        XCTAssertFalse(text.contains("ask 4"))
        XCTAssertTrue(text.contains("And 2 more."))
    }

    // MARK: - Helpers

    private func state(_ phase: CarCallPhase, _ activity: CarCallActivity, job: CarJobEvent? = nil, age: Double = 0) -> CarVoiceState? {
        CarVoice.state(for: CarVoiceMoment(phase: phase, activity: activity, job: job,
                                           jobAt: job == nil ? nil : now.addingTimeInterval(-age)), now: now)
    }

    private func thread(_ botName: String, _ title: String, busy: Bool? = false, activity: String? = nil, unread: Bool? = false) -> AttentionThread {
        var task = BotTask(threadId: UUID().uuidString, title: title, createdAt: 0)
        task.busy = busy
        task.activity = activity
        task.unread = unread
        return AttentionThread(botId: botName, botName: botName, task: task)
    }

    private func bot(_ id: String, _ name: String) -> Bot {
        Bot(id: id, threadId: "t\(id)", name: name, title: name,
            description: "", notifications: true, color: "green", unread: false,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 0)
    }
}
