import XCTest
@testable import CompanionCore

/// Runs the phone's cloud client against a real slice 1 server launched by
/// `services/cloud/fixture.ts`. Skipped unless CLOUD_LIVE_URL points at one;
/// only fictional identities and throwaway data are used.
final class CloudLiveServerTests: XCTestCase {
    private var base: URL!

    override func setUpWithError() throws {
        let url = ProcessInfo.processInfo.environment["CLOUD_LIVE_URL"]
        try XCTSkipUnless(url != nil, "set CLOUD_LIVE_URL to a running slice 1 fixture")
        base = URL(string: url!)!
    }

    func testTwoHumansSendReceiveReconnectAndRemoval() async throws {
        let run = UUID().uuidString.prefix(8).lowercased()
        let alice = try await signIn("fictional_alice_\(run)")
        let bob = try await signIn("fictional_bob_\(run)")
        let aliceClient = CloudClient(baseURL: base) { alice.bearer }
        let bobClient = CloudClient(baseURL: base) { bob.bearer }

        // Owner setup goes through the plain routes; the phone has no UI for it yet.
        let workspace = try await call(alice, "POST", "/v2/workspaces", ["name": "fictional workspace"])
        let workspaceId = try XCTUnwrap(workspace["workspace_id"] as? String)
        let room = try await call(alice, "POST", "/v2/workspaces/\(workspaceId)/rooms", ["name": "fictional room"])
        let roomId = try XCTUnwrap(room["room_id"] as? String)
        let threadId = try XCTUnwrap(room["thread_id"] as? String)
        let invite = try await call(alice, "POST", "/v2/workspaces/\(workspaceId)/invites", ["role": "member", "room_ids": [roomId]])
        _ = try await call(bob, "POST", "/v2/invites/redeem", ["token": try XCTUnwrap(invite["token"] as? String)])

        // Discovery decodes and both people see the room.
        let aliceRooms = try await aliceClient.discovery().rooms
        let bobDiscovery = try await bobClient.discovery()
        let bobRef = try XCTUnwrap(bobDiscovery.rooms.first { $0.roomId == roomId })
        XCTAssertEqual(bobRef.threadId, threadId)
        XCTAssertEqual(bobRef.role, .member)
        XCTAssertTrue(aliceRooms.contains { $0.roomId == roomId && $0.role == .owner })
        let policy = try XCTUnwrap(bobDiscovery.workspaces.first?.rooms.first?.policyRevision)

        // Bob subscribes from nothing: reset with the initial snapshot.
        var bobRoom = CloudRoomState(workspaceId: workspaceId, roomId: roomId, threadId: threadId, me: bob.accountId)
        var bobFrames = try await bobClient.realtime(subscriptions: [subscribe(bobRef, cursor: nil, snapshotId: nil)]).makeAsyncIterator()
        let first = try await next(&bobFrames) { if case .reset = $0 { return true }; return false }
        let resetEffects = bobRoom.receive(first)
        XCTAssertNotNil(bobRoom.cursor)
        XCTAssertTrue(resetEffects.contains(.persist))
        _ = try await next(&bobFrames) { if case .batch(let b) = $0 { return b.live }; return false }

        // Alice sends through the outbox: window, frozen envelope, submit.
        let aliceKey = CloudAccountKey(service: alice.service, issuer: alice.issuer, subject: alice.subject)
        var outbox = CloudOutbox(account: aliceKey)
        let window = try await aliceClient.operationWindow(workspaceId: workspaceId)
        XCTAssertEqual(window.namespace.accountId, alice.accountId)
        let envelope = CloudSendEnvelope(window: window, roomId: roomId, threadId: threadId, text: "fictional hello \u{1F44B} bob", expectedPolicyRevision: policy)
        let effects = try outbox.enqueue(envelope, windowExpiresAt: try XCTUnwrap(window.expiryDate), now: Date())
        guard case .submit(let sent)? = effects.first(where: { if case .submit = $0 { return true }; return false }) else {
            return XCTFail("outbox did not submit: \(effects)")
        }
        let result = await aliceClient.submit(sent)
        _ = outbox.answered(sent.clientOperationId, result: result, generation: outbox.generation, now: Date())
        guard case .accepted(let acceptance)? = outbox.entry(sent.clientOperationId)?.status else {
            return XCTFail("send not accepted: \(result)")
        }
        XCTAssertEqual(acceptance.digest, sent.digest, "server digest must match the phone's canonical digest")

        // Same bytes again is the same commit; changed bytes on the key conflict.
        let replay = await aliceClient.submit(sent)
        guard case .outcome(.accepted(let again)) = replay else { return XCTFail("replay: \(replay)") }
        XCTAssertEqual(again.messageId, acceptance.messageId)
        var changed = sent
        changed.text = "fictional different"
        let conflict = await aliceClient.submit(changed)
        XCTAssertEqual(conflict, .outcome(.recoveryUnknown))
        guard case .outcome(.accepted(let looked)) = await aliceClient.lookup(sent.clientOperationId, workspaceId: workspaceId) else {
            return XCTFail("lookup did not return the acceptance")
        }
        XCTAssertEqual(looked.messageId, acceptance.messageId)

        // Bob's live stream carries it into the reducer.
        let delivered = try await next(&bobFrames) { frame in
            if case .batch(let b) = frame { return b.events.contains { $0.payload["message"]?["message_id"]?.stringValue == acceptance.messageId } }
            return false
        }
        _ = bobRoom.receive(delivered)
        XCTAssertEqual(bobRoom.messages.last?.messageId, acceptance.messageId)
        XCTAssertEqual(bobRoom.messages.last?.text, sent.text)
        XCTAssertEqual(bobRoom.messages.last?.actorId, alice.accountId)

        // An operation that never reached the server seals as rejected.
        let unsent = CloudSendEnvelope(window: window, roomId: roomId, threadId: threadId, text: "fictional never sent", expectedPolicyRevision: policy)
        guard case .outcome(.notFound) = await aliceClient.lookup(unsent.clientOperationId, workspaceId: workspaceId) else {
            return XCTFail("unsent lookup should be not_found")
        }
        guard case .outcome(.rejected(let sealed)) = await aliceClient.seal(unsent) else { return XCTFail("seal did not reject") }
        XCTAssertEqual(sealed.clientOperationId, unsent.clientOperationId.rawValue)

        // HTTP snapshot and private read coverage decode.
        let ref = CloudRoomRef(workspaceId: workspaceId, roomId: roomId, threadId: threadId)
        let snapshot = try await bobClient.snapshot(ref)
        XCTAssertTrue(snapshot.messages.contains { $0.messageId == acceptance.messageId })
        let coverage = try await bobClient.markViewed(ref, intervals: [CloudReadInterval(acceptance.sequence, acceptance.sequence)])
        XCTAssertTrue(coverage.covers(acceptance.sequence))
        _ = bobRoom.apply(coverage)

        // Background then foreground: resubscribe from the cursor alone,
        // a second message arrives once, nothing duplicates.
        _ = bobRoom.background()
        bobFrames = try await bobClient.realtime(subscriptions: bobRoom.resubscribe().compactMap {
            if case .subscribe(let cursor, let snapshotId) = $0 { return subscribe(bobRef, cursor: cursor, snapshotId: snapshotId) }
            return nil
        }).makeAsyncIterator()
        let caughtUp = try await next(&bobFrames) { if case .batch(let b) = $0 { return b.live }; if case .reset = $0 { return true }; return false }
        if case .reset = caughtUp { XCTFail("resubscribe from a fresh cursor should not reset") }
        _ = bobRoom.receive(caughtUp)
        let second = CloudSendEnvelope(window: window, roomId: roomId, threadId: threadId, text: "fictional second", expectedPolicyRevision: policy)
        guard case .outcome(.accepted(let secondAccepted)) = await aliceClient.submit(second) else { return XCTFail("second send") }
        let secondFrame = try await next(&bobFrames) { frame in
            if case .batch(let b) = frame { return b.events.contains { $0.payload["message"]?["message_id"]?.stringValue == secondAccepted.messageId } }
            return false
        }
        _ = bobRoom.receive(secondFrame)
        XCTAssertEqual(bobRoom.messageIds, [acceptance.messageId, secondAccepted.messageId])

        // Removal: bob's discovery drops the room and the session removes it first.
        _ = try await call(alice, "DELETE", "/v2/workspaces/\(workspaceId)/members/\(bob.accountId)", nil)
        var session = CloudSession(account: CloudAccountKey(service: bob.service, issuer: bob.issuer, subject: bob.subject))
        _ = session.reduce(.foreground)
        _ = session.reduce(.authRefreshed(generation: 0))
        _ = session.reduce(.discoverySynced(generation: 0, bobDiscovery))
        _ = session.reduce(.foreground)
        _ = session.reduce(.authRefreshed(generation: 0))
        let after = session.reduce(.discoverySynced(generation: 0, try await bobClient.discovery()))
        XCTAssertEqual(after.first, .removeRoom(bobRef))
        // The audience changed, so the old policy revision is refused and the
        // owner sends again on the one discovery now reports.
        let stale = CloudSendEnvelope(window: window, roomId: roomId, threadId: threadId, text: "fictional after removal", expectedPolicyRevision: policy)
        let staleResult = await aliceClient.submit(stale)
        guard case .outcome(.rejected(let refused)) = staleResult, refused.reason == .policyChanged else { return XCTFail("stale policy send: \(staleResult)") }
        let ownerDiscovery = try await aliceClient.discovery()
        let newPolicy = try XCTUnwrap(ownerDiscovery.workspaces.first { $0.workspaceId == workspaceId }?.rooms.first { $0.roomId == roomId }?.policyRevision)
        XCTAssertGreaterThan(newPolicy, policy)
        let fresh = CloudSendEnvelope(window: window, roomId: roomId, threadId: threadId, text: "fictional after removal", expectedPolicyRevision: newPolicy)
        let freshResult = await aliceClient.submit(fresh)
        guard case .outcome(.accepted) = freshResult else { return XCTFail("owner send after removal: \(freshResult)") }
        do {
            _ = try await bobClient.snapshot(ref)
            XCTFail("removed member still reads the room")
        } catch {}
    }

    // MARK: - helpers

    private struct Identity {
        var bearer: String
        var accountId: String
        var issuer: String
        var subject: String
        var service: String
    }

    private func subscribe(_ room: CloudRoomRef, cursor: String?, snapshotId: String?) -> CloudOutboundFrame {
        .subscribe(workspaceId: room.workspaceId, roomId: room.roomId, threadId: room.threadId, cursor: cursor, snapshotId: snapshotId)
    }

    private func signIn(_ subject: String) async throws -> Identity {
        let body = try await raw(nil, "POST", "/v2/test/sign-in", ["subject": subject])
        return Identity(bearer: try XCTUnwrap(body["bearer"] as? String), accountId: try XCTUnwrap(body["account_id"] as? String),
                        issuer: try XCTUnwrap(body["issuer"] as? String), subject: try XCTUnwrap(body["subject"] as? String),
                        service: try XCTUnwrap(body["service"] as? String))
    }

    private func call(_ who: Identity, _ method: String, _ path: String, _ body: Any?) async throws -> [String: Any] {
        try await raw(who.bearer, method, path, body)
    }

    private func raw(_ bearer: String?, _ method: String, _ path: String, _ body: Any?) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            throw NSError(domain: "live", code: status, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path) -> \(status) \(String(decoding: data, as: UTF8.self))"])
        }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// Next frame matching `match`, failing after 10 seconds.
    private func next(_ frames: inout AsyncThrowingStream<CloudFrame, Error>.AsyncIterator, _ match: (CloudFrame) -> Bool) async throws -> CloudFrame {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            guard let frame = try await frames.next() else { throw NSError(domain: "live", code: 0, userInfo: [NSLocalizedDescriptionKey: "stream ended"]) }
            if match(frame) { return frame }
        }
        throw NSError(domain: "live", code: 0, userInfo: [NSLocalizedDescriptionKey: "no matching frame in 10s"])
    }
}
