import Foundation

/// Slices 3/4 wire: bot runs, approval cards and attachments, as frozen in
/// shared/cloud-protocol/index.ts. Generations are decimal strings.

public enum CloudID {
    /// IdSchema: 1–128 of [A-Za-z0-9_-].
    public static func isValid(_ raw: String) -> Bool {
        (1...128).contains(raw.utf8.count) && raw.utf8.allSatisfy { c in
            (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45 || c == 95
        }
    }
}

public enum CloudRunState: String, Codable, Sendable {
    case queued, leased, running, held, completed, failed, cancelled
    case waitingForHuman = "waiting_for_human"

    public var finished: Bool { self == .completed || self == .failed || self == .cancelled }
}

/// Which attempt of which invocation an event or decision belongs to.
public struct CloudRunBinding: Hashable, Codable, Sendable {
    public var invocationId: String
    public var attempt: Int
    public var fenceGen: CloudSequence

    public init(invocationId: String, attempt: Int, fenceGen: CloudSequence) {
        self.invocationId = invocationId; self.attempt = attempt; self.fenceGen = fenceGen
    }

    enum CodingKeys: String, CodingKey { case invocationId = "invocation_id", attempt, fenceGen = "fence_gen" }
}

public struct CloudModel: Hashable, Codable, Sendable {
    public var provider: String
    public var model: String
    public var configRevision: CloudSequence

    enum CodingKeys: String, CodingKey { case provider, model, configRevision = "config_revision" }
}

public struct CloudRunSource: Hashable, Codable, Sendable {
    public var messageId: String
    public var version: Int
    public var digest: String
    public var actorId: String
    public var text: String
    public var mentions: [CloudMention]
    public var attachmentIds: [String]

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id", version, digest, actorId = "actor_id", text, mentions, attachmentIds = "attachment_ids"
    }
}

public struct CloudInvocation: Hashable, Codable, Sendable {
    public var invocationId: String
    public var attempt: Int
    public var fenceGen: CloudSequence
    public var workspaceId: String
    public var roomId: String
    public var threadId: String
    public var botId: String
    public var state: CloudRunState
    public var model: CloudModel
    public var source: CloudRunSource
    public var controlRevision: CloudSequence
    public var hostId: String?
    public var leaseExpiresAt: String?
    public var queuedExpiresAt: String
    public var resultMessageId: String?
    public var stopRequested: Bool
    public var stoppedObserved: Bool
    public var replaySafe: Bool
    public var hostOnline: Bool?

    public var binding: CloudRunBinding { CloudRunBinding(invocationId: invocationId, attempt: attempt, fenceGen: fenceGen) }

    enum CodingKeys: String, CodingKey {
        case invocationId = "invocation_id", attempt, fenceGen = "fence_gen", workspaceId = "workspace_id", roomId = "room_id"
        case threadId = "thread_id", botId = "bot_id", state, model, source, controlRevision = "control_revision"
        case hostId = "host_id", leaseExpiresAt = "lease_expires_at", queuedExpiresAt = "queued_expires_at"
        case resultMessageId = "result_message_id", stopRequested = "stop_requested", stoppedObserved = "stopped_observed"
        case replaySafe = "replay_safe", hostOnline = "host_online"
    }
}

public enum CloudApprovalStatus: String, Codable, Sendable {
    case pending, approved, denied, expired, revoked
}

/// A human gate on one run attempt. Only the bound actor decides; the
/// server serializes decisions on card, run, version and digest.
public struct CloudApprovalCard: Hashable, Codable, Sendable {
    public var invocationId: String
    public var attempt: Int
    public var fenceGen: CloudSequence
    public var approvalId: String
    public var workspaceId: String
    public var roomId: String
    public var threadId: String
    public var actorId: String
    public var version: Int
    public var effectId: String
    public var digest: String
    public var title: String
    public var expiresAt: String
    public var status: CloudApprovalStatus
    public var canView: Bool
    public var canDecide: Bool

    public var binding: CloudRunBinding { CloudRunBinding(invocationId: invocationId, attempt: attempt, fenceGen: fenceGen) }

    /// Fails closed: an unreadable expiry, a passed one, or any status but
    /// pending shows no buttons.
    public func decidable(now: Date) -> Bool {
        guard status == .pending, canDecide, let expiry = CloudTime.parse(expiresAt) else { return false }
        return expiry > now
    }

    /// The status to show: a pending card past its expiry reads as expired
    /// before the server says so.
    public func shownStatus(now: Date) -> CloudApprovalStatus {
        if status == .pending, CloudTime.parse(expiresAt).map({ $0 <= now }) ?? true { return .expired }
        return status
    }

    public func decision(_ choice: CloudApprovalChoice) -> CloudApprovalDecision {
        CloudApprovalDecision(invocationId: invocationId, attempt: attempt, fenceGen: fenceGen, version: version, effectId: effectId, digest: digest, decision: choice)
    }

    enum CodingKeys: String, CodingKey {
        case invocationId = "invocation_id", attempt, fenceGen = "fence_gen", approvalId = "approval_id"
        case workspaceId = "workspace_id", roomId = "room_id", threadId = "thread_id", actorId = "actor_id", version
        case effectId = "effect_id", digest, title, expiresAt = "expires_at", status, canView = "can_view", canDecide = "can_decide"
    }
}

public enum CloudApprovalChoice: String, Codable, Sendable { case approve, deny }

public struct CloudApprovalDecision: Hashable, Codable, Sendable {
    public var invocationId: String
    public var attempt: Int
    public var fenceGen: CloudSequence
    public var version: Int
    public var effectId: String
    public var digest: String
    public var decision: CloudApprovalChoice

    enum CodingKeys: String, CodingKey {
        case invocationId = "invocation_id", attempt, fenceGen = "fence_gen", version, effectId = "effect_id", digest, decision
    }
}

public enum CloudAttachmentState: String, Codable, Sendable {
    case preparing, uploading, verifying, ready, rejected, expired
}

public enum CloudAttachmentLimits {
    public static let bytes = 10_485_760
    public static let types: Set<String> = ["image/png", "image/jpeg", "application/pdf", "text/plain"]

    /// The allowed type for a file name, or nil.
    public static func type(forName name: String) -> String? {
        switch (name as NSString).pathExtension.lowercased() {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "pdf": "application/pdf"
        case "txt", "text", "md": "text/plain"
        default: nil
        }
    }
}

public struct CloudAttachment: Hashable, Codable, Sendable {
    public var attachmentId: String
    public var workspaceId: String
    public var roomId: String
    public var threadId: String
    public var ownerId: String
    /// workspace|room|attachment, built by the server, never from a filename.
    public var objectKey: String
    /// Display only.
    public var name: String
    public var size: Int
    public var type: String
    public var checksum: String
    public var state: CloudAttachmentState
    public var expiresAt: String

    enum CodingKeys: String, CodingKey {
        case attachmentId = "attachment_id", workspaceId = "workspace_id", roomId = "room_id", threadId = "thread_id"
        case ownerId = "owner_id", objectKey = "object_key", name, size, type, checksum, state, expiresAt = "expires_at"
    }
}

public struct CloudAttachmentPrepare: Hashable, Codable, Sendable {
    public var roomId: String
    public var threadId: String
    public var name: String
    public var size: Int
    public var type: String
    public var checksum: String

    public init(roomId: String, threadId: String, name: String, size: Int, type: String, checksum: String) {
        self.roomId = roomId; self.threadId = threadId; self.name = name; self.size = size; self.type = type; self.checksum = checksum
    }

    enum CodingKeys: String, CodingKey { case roomId = "room_id", threadId = "thread_id", name, size, type, checksum }
}

public struct CloudAttachmentUpload: Hashable, Codable, Sendable {
    public var attachment: CloudAttachment
    public var uploadURL: String
    public var expiresAt: String

    enum CodingKeys: String, CodingKey { case attachment, uploadURL = "upload_url", expiresAt = "expires_at" }
}

/// One local file on its way to `ready`. Memory only: bytes never touch
/// disk, so a guest or a sign-out leaves nothing behind.
public struct CloudAttachmentDraft: Hashable, Sendable, Identifiable {
    public let id: UUID
    public var name: String
    public var type: String
    public var bytes: Data
    public var state: CloudAttachmentState = .preparing
    public var attachment: CloudAttachment?
    public var problem: String?

    public init(id: UUID = UUID(), name: String, type: String, bytes: Data) {
        self.id = id; self.name = name; self.type = type; self.bytes = bytes
    }

    /// Size and type are checked before anything leaves the phone.
    public static func validate(name: String, type: String?, size: Int) -> String? {
        guard let type, CloudAttachmentLimits.types.contains(type) else { return "only png, jpeg, pdf or text" }
        if size <= 0 { return "empty file" }
        if size > CloudAttachmentLimits.bytes { return "larger than 10 MB" }
        return nil
    }
}

enum CloudTime {
    static func parse(_ raw: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: raw) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: raw)
    }
}
