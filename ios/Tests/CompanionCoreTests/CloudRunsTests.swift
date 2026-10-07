import Foundation
import XCTest
@testable import CompanionCore

/// Slice 3/4 events in the room reducer, decoded from wire-shaped JSON.
final class CloudRunsTests: XCTestCase {
    private typealias F = CloudFixture
    private let digest = String(repeating: "a", count: 64)

    private func json(_ raw: String) -> [String: CloudJSON] {
        try! JSONDecoder().decode([String: CloudJSON].self, from: Data(raw.utf8))
    }

    private func event(_ kind: String, _ sequence: Int, _ payload: String) -> CloudEvent {
        CloudEvent(workspaceId: "w1", roomId: "r1", eventId: "ev\(sequence)", sequence: CloudSequence(sequence), kind: kind, payload: json(payload))
    }

    private func invocation(state: String = "queued", attempt: Int = 0, fence: String = "0", thread: String = "t1", host: String = "null", stop: Bool = false) -> String {
        """
        {"invocation_id":"i1","attempt":\(attempt),"fence_gen":"\(fence)","workspace_id":"w1","room_id":"r1","thread_id":"\(thread)","bot_id":"b1","state":"\(state)",
        "model":{"provider":"local","model":"fixture","config_revision":"1"},
        "source":{"message_id":"m1","version":1,"digest":"\(digest)","actor_id":"alice","text":"@bot hi","mentions":[{"kind":"bot","id":"b1","start":0,"end":4}],"attachment_ids":[]},
        "control_revision":"0","host_id":\(host),"lease_expires_at":null,"queued_expires_at":"2026-10-07T00:10:00.000Z","result_message_id":null,
        "stop_requested":\(stop),"stopped_observed":false,"replay_safe":true}
        """
    }

    private func card(version: Int = 1, status: String = "pending", actor: String = "alice", expires: String = "2026-10-07T00:05:00.000Z", canDecide: Bool = true) -> String {
        """
        {"invocation_id":"i1","attempt":1,"fence_gen":"1","approval_id":"ap1","workspace_id":"w1","room_id":"r1","thread_id":"t1","actor_id":"\(actor)",
        "version":\(version),"effect_id":"e1","digest":"\(digest)","title":"send the report","expires_at":"\(expires)","status":"\(status)","can_view":true,"can_decide":\(canDecide)}
        """
    }

    private func liveRoom() -> CloudRoomState {
        var state = CloudRoomState(workspaceId: "w1", roomId: "r1", threadId: "t1", me: "alice")
        state.apply(F.snapshot(messages: [F.message("m1", sequence: 1, actor: "alice")], watermark: 1, cursor: "c1"))
        return state
    }

    private func offered(_ state: inout CloudRoomState, at sequence: Int = 2) {
        let effects = state.receive(F.batch([event(CloudEventKind.invocationOffered, sequence, #"{"kind":"invocation.offered","invocation_id":"i1","attempt":0,"fence_gen":"0","invocation":"# + invocation() + "}")], cursor: "c\(sequence)"))
        XCTAssertEqual(effects, [.persist])
    }

    private func claimed(_ state: inout CloudRoomState, at sequence: Int = 3) {
        _ = state.receive(F.batch([event(CloudEventKind.invocationClaimed, sequence, #"{"kind":"invocation.claimed","invocation_id":"i1","attempt":1,"fence_gen":"1","host_id":"h1","model":{"provider":"local","model":"fixture","config_revision":"1"},"lease_expires_at":"2026-10-07T00:00:30.000Z"}"#)], cursor: "c\(sequence)"))
    }

    private func delta(_ id: String, _ text: String, _ sequence: Int, fence: String = "1") -> CloudEvent {
        event(CloudEventKind.streamDelta, sequence, #"{"kind":"stream.delta","invocation_id":"i1","attempt":1,"fence_gen":""# + fence + #"","delta_id":""# + id + #"","text":""# + text + #""}"#)
    }

    func testEveryRequiredSlice34KindIsReadable() {
        var state = liveRoom()
        offered(&state)
        claimed(&state)
        let final = F.message("m9", sequence: 9, actor: "alice", text: "done")
        var finalJSON = try! CloudJSON(encoding: final)
        if case .object(var object) = finalJSON { object["bot_id"] = .string("b1"); finalJSON = .object(object) }
        let events = [
            delta("d1", "he", 4),
            event(CloudEventKind.stopRequested, 5, #"{"kind":"stop.requested","invocation_id":"i1","attempt":1,"fence_gen":"1","control_revision":"1"}"#),
            event(CloudEventKind.stopObserved, 6, #"{"kind":"stop.observed","invocation_id":"i1","attempt":1,"fence_gen":"1","control_revision":"1"}"#),
            event(CloudEventKind.approvalUpdated, 7, #"{"actor_id":"alice","card":"# + card() + "}"),
            event(CloudEventKind.attachmentUpdated, 8, #"{"actor_id":"alice","attachment":{"attachment_id":"a1","workspace_id":"w1","room_id":"r1","thread_id":"t1","owner_id":"alice","object_key":"w1|r1|a1","name":"x.txt","size":3,"type":"text/plain","checksum":""# + digest + #"","state":"ready","expires_at":"2026-10-08T00:00:00.000Z"}}"#),
            CloudEvent(workspaceId: "w1", roomId: "r1", eventId: "ev9", sequence: CloudSequence(9), kind: CloudEventKind.finalCommit, payload: ["kind": .string("final.commit"), "invocation_id": .string("i1"), "attempt": .integer(1), "fence_gen": .string("1"), "message": finalJSON]),
            event(CloudEventKind.presence, 10, #"{"host_id":"h1","online":false}"#),
        ]
        let effects = state.receive(F.batch(events, cursor: "c10"))
        XCTAssertFalse(state.upgradeRequired)
        XCTAssertEqual(state.cursor, "c10")
        // The bot's final is the host owner's account but never an own send.
        XCTAssertFalse(effects.contains { if case .observedOwnSend = $0 { true } else { false } })
        XCTAssertTrue(effects.contains { if case .attachmentUpdated(let a) = $0 { a.attachmentId == "a1" && a.state == .ready } else { false } })
        XCTAssertEqual(state.messageIds, ["m1", "m9"])
        XCTAssertEqual(state.messages.last?.botId, "b1")
        XCTAssertNil(state.streaming["i1"])
        let run = state.run("i1")
        XCTAssertEqual(run?.resultMessageId, "m9")
        XCTAssertEqual(run?.stopRequested, true)
        XCTAssertEqual(run?.stoppedObserved, true)
        XCTAssertEqual(run?.hostOnline, false)
        XCTAssertEqual(state.card("ap1")?.title, "send the report")
    }

    func testDeltasDedupeAndDropForAnotherAttempt() {
        var state = liveRoom()
        offered(&state)
        claimed(&state)
        XCTAssertEqual(state.run("i1")?.state, .leased)
        XCTAssertEqual(state.run("i1")?.hostId, "h1")
        _ = state.receive(F.batch([delta("d1", "hel", 4), delta("d1", "hel", 5), delta("d2", "lo", 6), delta("d3", "zz", 7, fence: "0")], cursor: "c7"))
        XCTAssertEqual(state.streaming["i1"]?.text, "hello")
        // A newer attempt replaces the provisional text.
        _ = state.receive(F.batch([event(CloudEventKind.invocationClaimed, 8, #"{"kind":"invocation.claimed","invocation_id":"i1","attempt":2,"fence_gen":"2","host_id":"h2","model":{"provider":"local","model":"fixture","config_revision":"1"},"lease_expires_at":"2026-10-07T00:01:00.000Z"}"#)], cursor: "c8"))
        XCTAssertNil(state.streaming["i1"])
        XCTAssertEqual(state.run("i1")?.fenceGen, CloudSequence(2))
    }

    func testStreamingIsNeverPersisted() throws {
        var state = liveRoom()
        offered(&state)
        claimed(&state)
        _ = state.receive(F.batch([delta("d1", "secret draft", 4)], cursor: "c4"))
        let data = try JSONEncoder().encode(state)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("secret draft"))
        let restored = try JSONDecoder().decode(CloudRoomState.self, from: data)
        XCTAssertEqual(restored.run("i1")?.hostId, "h1")
        XCTAssertTrue(restored.streaming.isEmpty)
    }

    func testCacheFromBeforeSlice3StillDecodes() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(liveRoom())) as! [String: Any]
        object["runStore"] = nil
        object["cardStore"] = nil
        let restored = try JSONDecoder().decode(CloudRoomState.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(restored.messageIds, ["m1"])
        XCTAssertTrue(restored.runs.isEmpty)
    }

    func testRunUpdateFromOlderFenceIgnoredAndOtherThreadsDropped() {
        var state = liveRoom()
        offered(&state)
        claimed(&state)
        _ = state.receive(F.batch([event(CloudEventKind.runUpdated, 4, #"{"invocation":"# + invocation(state: "queued", attempt: 0, fence: "0") + "}")], cursor: "c4"))
        XCTAssertEqual(state.run("i1")?.state, .leased)
        _ = state.receive(F.batch([event(CloudEventKind.runUpdated, 5, #"{"invocation":"# + invocation(state: "waiting_for_human", attempt: 1, fence: "1", host: #""h1""#) + "}")], cursor: "c5"))
        XCTAssertEqual(state.run("i1")?.state, .waitingForHuman)
        var other = liveRoom()
        _ = other.receive(F.batch([event(CloudEventKind.runUpdated, 2, #"{"invocation":"# + invocation(thread: "t2") + "}")], cursor: "c2"))
        XCTAssertTrue(other.runs.isEmpty)
        XCTAssertFalse(other.upgradeRequired)
    }

    func testMalformedRequiredRunEventBlocksTheBatch() {
        var state = liveRoom()
        let effects = state.receive(F.batch([event(CloudEventKind.streamDelta, 2, #"{"kind":"stream.delta","invocation_id":"i1","attempt":1,"fence_gen":1,"delta_id":"d1","text":"x"}"#)], cursor: "c2"))
        XCTAssertEqual(effects, [.closeStream, .persist])
        XCTAssertTrue(state.upgradeRequired)
        XCTAssertEqual(state.cursor, "c1")
    }

    func testCardsVersionedAndOnlyMine() throws {
        var state = liveRoom()
        _ = state.receive(F.batch([event(CloudEventKind.approvalUpdated, 2, #"{"actor_id":"alice","card":"# + card(version: 2, status: "approved", canDecide: false) + "}")], cursor: "c2"))
        XCTAssertEqual(state.card("ap1")?.status, .approved)
        // A late GET answer at an older version never reopens the card.
        let stale = try JSONDecoder().decode(CloudApprovalCard.self, from: Data(card(version: 1).utf8))
        XCTAssertEqual(state.apply(card: stale), [])
        XCTAssertEqual(state.card("ap1")?.status, .approved)
        let bobs = try JSONDecoder().decode(CloudApprovalCard.self, from: Data(card(actor: "bob").utf8))
        var fresh = liveRoom()
        XCTAssertEqual(fresh.apply(card: bobs), [])
        XCTAssertTrue(fresh.cards.isEmpty)
    }

    func testSnapshotReplacesRunsAndCards() throws {
        var state = liveRoom()
        offered(&state)
        claimed(&state)
        _ = state.receive(F.batch([delta("d1", "x", 4)], cursor: "c4"))
        var snapshot = F.snapshot(messages: [], watermark: 9, cursor: "c9")
        snapshot.activeRuns = [try JSONDecoder().decode(CloudInvocation.self, from: Data(invocation(state: "running", attempt: 1, fence: "1", host: #""h1""#).utf8))]
        var bobs = try JSONDecoder().decode(CloudApprovalCard.self, from: Data(card(actor: "bob").utf8))
        bobs.approvalId = "ap2"
        snapshot.cards = [try JSONDecoder().decode(CloudApprovalCard.self, from: Data(card().utf8)), bobs]
        state.apply(snapshot)
        XCTAssertEqual(state.runs.map(\.state), [.running])
        XCTAssertEqual(state.cards.map(\.approvalId), ["ap1"])
        XCTAssertTrue(state.streaming.isEmpty)
    }

    func testCardDecidableFailsClosed() throws {
        let now = F.now
        func make(_ raw: String) throws -> CloudApprovalCard { try JSONDecoder().decode(CloudApprovalCard.self, from: Data(raw.utf8)) }
        let future = ISO8601DateFormatter().string(from: now.addingTimeInterval(60))
        let past = ISO8601DateFormatter().string(from: now.addingTimeInterval(-1))
        XCTAssertTrue(try make(card(expires: future)).decidable(now: now))
        XCTAssertFalse(try make(card(expires: past)).decidable(now: now))
        XCTAssertEqual(try make(card(expires: past)).shownStatus(now: now), .expired)
        XCTAssertFalse(try make(card(expires: "soon")).decidable(now: now))
        XCTAssertFalse(try make(card(expires: future, canDecide: false)).decidable(now: now))
        XCTAssertFalse(try make(card(status: "approved", expires: future)).decidable(now: now))
        let decision = try make(card(version: 3, expires: future)).decision(.approve)
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decision)) as! [String: Any]
        XCTAssertEqual(Set(wire.keys), ["invocation_id", "attempt", "fence_gen", "version", "effect_id", "digest", "decision"])
        XCTAssertEqual(wire["fence_gen"] as? String, "1")
        XCTAssertEqual(wire["decision"] as? String, "approve")
        XCTAssertEqual(wire["version"] as? Int, 3)
    }

    func testAttachmentDraftLimitsAndTypes() {
        XCTAssertNil(CloudAttachmentDraft.validate(name: "a.png", type: "image/png", size: 10))
        XCTAssertNotNil(CloudAttachmentDraft.validate(name: "a.gif", type: "image/gif", size: 10))
        XCTAssertNotNil(CloudAttachmentDraft.validate(name: "a.png", type: nil, size: 10))
        XCTAssertNotNil(CloudAttachmentDraft.validate(name: "a.png", type: "image/png", size: 0))
        XCTAssertNotNil(CloudAttachmentDraft.validate(name: "a.png", type: "image/png", size: CloudAttachmentLimits.bytes + 1))
        XCTAssertEqual(CloudAttachmentLimits.type(forName: "Scan.PDF"), "application/pdf")
        XCTAssertEqual(CloudAttachmentLimits.type(forName: "photo.jpeg"), "image/jpeg")
        XCTAssertNil(CloudAttachmentLimits.type(forName: "run.sh"))
    }

    func testUploadOriginCheck() {
        let base = URL(string: "http://127.0.0.1:52647")!
        XCTAssertTrue(CloudClient.sameOrigin(URL(string: "http://127.0.0.1:52647/v2/workspaces/w1/attachments/a1/upload?token=x")!, base))
        XCTAssertFalse(CloudClient.sameOrigin(URL(string: "http://127.0.0.1:9/v2/x")!, base))
        XCTAssertFalse(CloudClient.sameOrigin(URL(string: "https://127.0.0.1:52647/v2/x")!, base))
        XCTAssertFalse(CloudClient.sameOrigin(URL(string: "http://evil.example:52647/v2/x")!, base))
        XCTAssertTrue(CloudClient.sameOrigin(URL(string: "https://rooms.example/v2/x")!, URL(string: "https://rooms.example:443")!))
    }
}
