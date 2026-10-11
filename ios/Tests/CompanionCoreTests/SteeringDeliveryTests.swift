import XCTest
@testable import CompanionCore

final class SteeringDeliveryTests: XCTestCase {
    func testDeliveryEvidenceSurvivesMessageCacheRoundTrip() throws {
        for delivery in ["transport_written", "provider_accepted", "outcome_unknown", "future_delivery_state"] {
            let source = """
            {"id":"correction","role":"user","kind":"text","at":1,"text":"change direction",
             "steered":true,"steerDelivery":"\(delivery)"}
            """
            let message = try JSONDecoder().decode(Message.self, from: Data(source.utf8))
            let cached = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any])
            XCTAssertEqual(cached["steerDelivery"] as? String, delivery)
            XCTAssertEqual(cached["steered"] as? Bool, true)
        }
    }

    func testLabelsDistinguishTransportWriteAcknowledgementAndUncertainty() throws {
        let statuses: [(String, SteeringStatus)] = [
            ("transport_written", .sentDuringReply),
            ("provider_accepted", .acceptedDuringReply),
            ("outcome_unknown", .uncertain)
        ]
        for (delivery, status) in statuses {
            var message = Message(id: "correction", role: .user, kind: .text, at: 1)
            message.steerDelivery = delivery
            XCTAssertEqual(message.steeringStatus, status)
        }
        var legacy = Message(id: "old", role: .user, kind: .text, at: 1)
        XCTAssertNil(legacy.steeringStatus)
        legacy.steered = true
        XCTAssertEqual(legacy.steeringStatus, .sentDuringReply)
        legacy.steerDelivery = "outcome_unknown"
        XCTAssertEqual(legacy.steeringStatus, .uncertain, "uncertainty wins over a legacy success flag")
        legacy.role = .bot
        XCTAssertNil(legacy.steeringStatus)
    }

    func testUnknownReceiptRetiresQueueAndPreservesUncertaintyBeforeSSE() throws {
        let receipt = try decode(#"{"steered":false,"outcomeUnknown":true,"threadId":"t1","queueIds":["q1"],"messages":[{"id":"m1","role":"user","kind":"text","at":1,"text":"correction","queueId":"q1"}]}"#)
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "correction"), threadId: "t1")
        XCTAssertTrue(receipt.apply(to: &state, expectedThreadId: "t1"))
        XCTAssertNil(state.pendingQueued["t1"])
        XCTAssertEqual(state.transcript(forThread: "t1").first?.steeringStatus, .uncertain)
        XCTAssertTrue(receipt.apply(to: &state, expectedThreadId: "t1"))
        XCTAssertEqual(state.transcript(forThread: "t1").count, 1, "a repeated receipt must not duplicate the message")
    }

    func testRefusedAndUnscopedReceiptsKeepQueuedCorrection() throws {
        for source in [
            #"{"queued":true,"threadId":"t1","reason":"still waiting"}"#,
            #"{"ok":true}"#,
            #"{"steered":true,"threadId":"other","queueIds":["q1"],"messages":[{"id":"m1","role":"user","kind":"text","at":1}]}"#
        ] {
            var state = CompanionState()
            state.rememberQueued(QueuedSend(queueId: "q1", text: "correction"), threadId: "t1")
            XCTAssertFalse(try decode(source).apply(to: &state, expectedThreadId: "t1"))
            XCTAssertEqual(state.pendingQueued["t1"]?.count, 1)
            XCTAssertTrue(state.transcript(forThread: "t1").isEmpty)
            XCTAssertTrue(state.transcript(forThread: "other").isEmpty)
        }
    }

    func testReceiptPreservesProviderEvidenceAndDeduplicatesLateSSE() throws {
        let receipt = try decode(#"{"steered":true,"threadId":"t1","delivery":"provider_accepted","queueIds":["q1"],"messages":[{"id":"m1","role":"user","kind":"text","at":1,"text":"correction","queueId":"q1","steered":true}]}"#)
        var state = CompanionState()
        XCTAssertTrue(receipt.apply(to: &state, expectedThreadId: "t1"))
        let message = try XCTUnwrap(state.transcript(forThread: "t1").first)
        state.apply(.message(threadId: "t1", message: message))
        XCTAssertEqual(state.transcript(forThread: "t1").count, 1)
        XCTAssertEqual(state.transcript(forThread: "t1").first?.steeringStatus, .acceptedDuringReply)
    }

    func testInterruptedReceiptReconcilesExactlyOnceWithoutClaimingModelConsumption() throws {
        let receipt = try decode(#"{"interrupted":true,"queued":false,"threadId":"t1","queueIds":["q1"],"messages":[{"id":"m1","role":"user","kind":"text","at":1,"text":"correction","queueId":"q1","sendId":"s1"}]}"#)
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "correction"), threadId: "t1")
        XCTAssertTrue(receipt.apply(to: &state, expectedThreadId: "t1"))
        let message = try XCTUnwrap(state.transcript(forThread: "t1").first)
        XCTAssertEqual(message.sendId, "s1")
        XCTAssertNil(message.steeringStatus)
        state.apply(.message(threadId: "t1", message: message))
        XCTAssertEqual(state.transcript(forThread: "t1").count, 1)
        XCTAssertNil(state.pendingQueued["t1"])
        let cached = try JSONDecoder().decode(Message.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(cached.sendId, "s1")
    }

    func testInterruptedButStillQueuedReceiptDoesNotHideCorrection() throws {
        let receipt = try decode(#"{"interrupted":true,"queued":true,"threadId":"t1","queueIds":["q1"]}"#)
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "correction"), threadId: "t1")
        XCTAssertFalse(receipt.apply(to: &state, expectedThreadId: "t1"))
        XCTAssertEqual(state.pendingQueued["t1"]?.count, 1)
    }

    func testSendReceiptKeepsCanonicalMessageForImmediateLocalReconciliation() throws {
        let source = #"{"threadId":"t1","message":{"id":"m1","role":"user","kind":"text","at":1,"text":"now","sendId":"s1"}}"#
        let receipt = try JSONDecoder().decode(SendReceipt.self, from: Data(source.utf8))
        XCTAssertEqual(receipt.message?.sendId, "s1")
        XCTAssertEqual(receipt.threadId, "t1")
    }

    private func decode(_ source: String) throws -> SteerReceipt {
        try JSONDecoder().decode(SteerReceipt.self, from: Data(source.utf8))
    }
}
