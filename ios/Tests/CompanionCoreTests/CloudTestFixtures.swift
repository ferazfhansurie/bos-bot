import Foundation
import XCTest
@testable import CompanionCore

/// Fictional cloud fixtures shared by the Cloud*Tests files: workspace w1,
/// room r1, thread t1, accounts alice and bob.
enum CloudFixture {
    static let now = Date(timeIntervalSince1970: 1_791_331_200)
    static let windowExpiry = now.addingTimeInterval(30 * 24 * 60 * 60)

    static func account(_ subject: String) -> CloudAccountKey {
        CloudAccountKey(service: "cloud-local", issuer: "stub", subject: subject)
    }

    static func namespace(_ subject: String = "alice", workspaceId: String = "w1") -> CloudNamespace {
        CloudNamespace(service: "cloud-local", issuer: "stub", subject: subject, accountId: subject, workspaceId: workspaceId, epoch: "e1")
    }

    static func window(_ subject: String = "alice") -> CloudSendWindow {
        CloudSendWindow(namespace: namespace(subject), windowId: "window1", windowToken: "fixture.signature", issuedAt: "2026-10-07T00:00:00Z", expiresAt: "2026-11-06T00:00:00Z")
    }

    /// `window1.` plus a 16+ character nonce ending in `n`.
    static func operation(_ n: Int) -> CloudOperationID {
        CloudOperationID(rawValue: "window1.nonce" + String(format: "%011d", n))
    }

    static func envelope(_ n: Int, subject: String = "alice", room: String = "r1", thread: String = "t1", text: String = "hello", mentions: [CloudMention] = [], replyTo: String? = nil) -> CloudSendEnvelope {
        CloudSendEnvelope(window: window(subject), operation: operation(n), roomId: room, threadId: thread, text: text, mentions: mentions, replyToMessageId: replyTo, expectedPolicyRevision: CloudSequence(1))
    }

    static func acceptance(for envelope: CloudSendEnvelope, messageId: String, sequence: Int) -> CloudAcceptance {
        CloudAcceptance(clientOperationId: envelope.clientOperationId.rawValue, digest: envelope.digest, messageId: messageId, roomId: envelope.roomId, threadId: envelope.threadId, sequence: CloudSequence(sequence), redacted: false)
    }

    static func message(_ id: String, sequence: Int, thread: String = "t1", room: String = "r1", actor: String = "bob", operation: String? = nil, version: Int = 1, text: String = "hi", deleted: Bool = false) -> CloudMessage {
        CloudMessage(workspaceId: "w1", roomId: room, threadId: thread, messageId: id, actorId: actor, clientOperationId: operation ?? "op-\(id)", sequence: CloudSequence(sequence), version: version, text: text, deleted: deleted, createdAt: "2026-10-07T00:00:00Z")
    }

    static func messageEvent(_ message: CloudMessage, sequence: Int, kind: String = CloudEventKind.messageCreated) -> CloudEvent {
        CloudEvent(workspaceId: message.workspaceId, roomId: message.roomId, eventId: "ev\(sequence)", sequence: CloudSequence(sequence), kind: kind, payload: ["message": try! CloudJSON(encoding: message)])
    }

    static func batch(_ events: [CloudEvent], room: String = "r1", cursor: String, live: Bool = true) -> CloudFrame {
        let last = events.last?.sequence ?? CloudSequence(0)
        return .batch(CloudEventBatch(workspaceId: "w1", roomId: room, events: events, cursor: cursor, scannedSequence: last, frontier: last, live: live))
    }

    static func snapshot(messages: [CloudMessage], thread: String = "t1", watermark: Int, cursor: String = "c-snap", snapshotId: String = "s1", read: CloudReadCoverage = .empty) -> CloudSnapshot {
        CloudSnapshot(snapshotId: snapshotId, expiresAt: "2026-10-07T00:05:00Z", workspaceId: "w1", roomId: "r1", threadId: thread, watermark: CloudSequence(watermark), frontier: CloudSequence(watermark), cursor: cursor, policyRevision: CloudSequence(1), messages: messages, members: [CloudMember(accountId: "alice", role: .member), CloudMember(accountId: "bob", role: .member)], threads: [], capabilities: [], read: read, activeRuns: [], cards: [])
    }

    static func room(_ id: String, thread: String = "t1", workspace: String = "w1", role: CloudRole = .member) -> CloudRoomRef {
        CloudRoomRef(workspaceId: workspace, roomId: id, threadId: thread, role: role)
    }

    static func discovery(_ roomIds: [String], role: CloudRole = .member) -> CloudDiscovery {
        CloudDiscovery(workspaces: [CloudDiscovery.Workspace(workspaceId: "w1", role: role, rooms: roomIds.map { CloudDiscovery.Room(roomId: $0, threadId: "t1", policyRevision: CloudSequence(1)) })])
    }
}

extension Array where Element == CloudOutboxEffect {
    var submitted: [CloudSendEnvelope] {
        compactMap { if case .submit(let envelope) = $0 { return envelope } else { return nil } }
    }
    var sealed: [CloudSendEnvelope] {
        compactMap { if case .seal(let envelope) = $0 { return envelope } else { return nil } }
    }
    var wakeDelays: [TimeInterval] {
        compactMap { if case .scheduleWake(let after) = $0 { return after } else { return nil } }
    }
}
