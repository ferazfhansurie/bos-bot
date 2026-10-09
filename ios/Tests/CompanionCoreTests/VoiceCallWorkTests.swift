// Voice v2: what a call posts, what it reads back, and the voice pushes.
import XCTest
@testable import CompanionCore

final class VoiceCallWorkTests: XCTestCase {
    private func bot(_ id: String, at: Double, text: String = "x", kind: Message.Kind = .text,
                     terminal: Bool? = nil) -> Message {
        var message = Message(id: id, role: .bot, kind: kind, at: at)
        message.text = text
        message.turnTerminal = terminal
        return message
    }

    // MARK: Thread text

    func testAskUsesTheCallersOwnWords() {
        let ask = VoiceCallAsk.make(spoken: [" how many bots ", "", "are online right now"],
                                    request: "Firaz wants to know how many bots are online.")
        XCTAssertEqual(ask.text, "how many bots are online right now")
        XCTAssertEqual(ask.job, "Firaz wants to know how many bots are online.")
    }

    func testAskFallsBackToTheRequestWithNoTranscript() {
        let ask = VoiceCallAsk.make(spoken: ["  "], request: " check the deploy ")
        XCTAssertEqual(ask.text, "check the deploy")
    }

    func testSameAskInsideThirtySecondsIsARepeat() {
        let now = Date()
        let ask = VoiceCallAsk(text: "Check the deploy.", job: "")
        XCTAssertTrue(ask.repeats(("check the deploy", now.addingTimeInterval(-10)), now: now))
        XCTAssertFalse(ask.repeats(("check the deploy", now.addingTimeInterval(-31)), now: now))
        XCTAssertFalse(ask.repeats(("check the build", now.addingTimeInterval(-5)), now: now))
        XCTAssertFalse(ask.repeats(nil, now: now))
    }

    // MARK: Landed replies

    func testBusyBotOnlyGivesTheSettledLine() {
        var user = Message(id: "u", role: .user, kind: .text, at: 20)
        user.text = "do it"
        let messages = [bot("before", at: 10), user, bot("tool", at: 21, kind: .activity, terminal: true),
                        bot("draft", at: 22, text: "working on it"), bot("final", at: 23, text: "done", terminal: true)]
        let landed = RealtimeVoice.landedReplies(messages, since: 20, busy: true, delivered: [])
        XCTAssertEqual(landed.map(\.id), ["final"])
    }

    func testIdleBotGivesEveryNewTextOnce() {
        let messages = [bot("draft", at: 22, text: "working on it"), bot("blank", at: 22, text: "  "),
                        bot("final", at: 23, text: "done")]
        XCTAssertEqual(RealtimeVoice.landedReplies(messages, since: 20, busy: false, delivered: []).map(\.id),
                       ["draft", "final"])
        XCTAssertEqual(RealtimeVoice.landedReplies(messages, since: 20, busy: false, delivered: ["draft"]).map(\.id),
                       ["final"])
    }

    func testTurnTerminalAndOriginDecode() throws {
        let json = #"{"id":"m","role":"user","kind":"text","at":1,"text":"hi","turnTerminal":true,"origin":{"kind":"voice_call","callId":"c","job":"j"}}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.turnTerminal, true)
        XCTAssertEqual(message.origin, MessageOrigin(callId: "c", job: "j"))
    }

    // MARK: Pushes and rings

    func testWorkDonePushParses() {
        let push = VoicePush(payload: ["type": "voice_work_done", "botId": "b", "threadId": "t", "callId": "c", "messageId": "m"])
        XCTAssertEqual(push, .workDone(botId: "b", threadId: "t", callId: "c", messageId: "m"))
        XCTAssertEqual(push?.category, VoicePush.workDoneCategory)
        // The live notify frame only says kind.
        XCTAssertEqual(VoicePush(payload: ["kind": "voice_work_done", "botId": "b", "threadId": "t"]),
                       .workDone(botId: "b", threadId: "t", callId: nil, messageId: nil))
        XCTAssertNil(VoicePush(payload: ["kind": "done", "botId": "b", "threadId": "t"]))
        XCTAssertNil(VoicePush(payload: ["type": "voice_work_done", "botId": "b"]))
    }

    func testRingPushParses() {
        let push = VoicePush(payload: ["type": "voice_ring", "ringId": "r", "botId": "b", "threadId": "", "reason": "deploy failed"])
        XCTAssertEqual(push, .ring(VoiceRing(ringId: "r", botId: "b", threadId: nil, reason: "deploy failed")))
        XCTAssertEqual(push?.category, VoicePush.ringCategory)
        XCTAssertNil(VoicePush(payload: ["type": "voice_ring", "botId": "b"]))
    }

    func testRingStreamFrameDecodes() throws {
        let json = #"{"kind":"voice_ring","type":"voice_ring","ringId":"r1","botId":"b1","threadId":"t1","reason":"need you","seq":7}"#
        let frame = try JSONDecoder().decode(StreamFrame.self, from: Data(json.utf8))
        XCTAssertEqual(frame.seq, 7)
        guard case let .voiceRing(ring) = frame.frame else { return XCTFail("not a ring") }
        XCTAssertEqual(ring, VoiceRing(ringId: "r1", botId: "b1", threadId: "t1", reason: "need you"))
        let broken = try JSONDecoder().decode(StreamFrame.self, from: Data(#"{"kind":"voice_ring","botId":"b1"}"#.utf8))
        guard case .unknown = broken.frame else { return XCTFail("a broken ring must not break the stream") }
    }

    func testNotifyFrameCarriesCallId() throws {
        let json = #"{"kind":"notify","notification":{"kind":"voice_work_done","botId":"b","botName":"bos","threadId":"t","title":"bos is done","body":"3 bots","callId":"c","messageId":"m"}}"#
        let frame = try JSONDecoder().decode(StreamFrame.self, from: Data(json.utf8))
        guard case let .notify(notification) = frame.frame else { return XCTFail("not notify") }
        XCTAssertEqual(notification.callId, "c")
    }

    func testOpenersCarryTheirReason() {
        XCTAssertTrue(RealtimeVoice.callBackOpener(botName: "bos", result: " 3 bots online ").hasSuffix("What you finished: 3 bots online"))
        XCTAssertTrue(RealtimeVoice.ringOpener(reason: "deploy failed").hasSuffix("Why you called: deploy failed"))
    }
}
