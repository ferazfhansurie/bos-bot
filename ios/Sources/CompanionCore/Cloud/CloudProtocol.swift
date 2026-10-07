import Foundation
import CryptoKit

// The BOS 2.0 cloud room wire contract (slice 1), as the phone reads it.
// shared/cloud-protocol/index.ts owns the schemas; these types mirror them
// and are held to its fixtures.json corpus by CloudCorpusTests.

public enum CloudLimits {
    public static let schemaVersion = 1
    public static let textBytes = 65536
    public static let mentions = 256
    public static let attachments = 32
    public static let snapshotMessages = 50
    public static let sparseIntervals = 256
    public static let subscriptions = 50
    public static let requestSeconds: TimeInterval = 10
}

/// A room sequence. The server sends decimal strings so no client ever
/// rounds a large sequence through a double; comparison is numeric.
public struct CloudSequence: Hashable, Comparable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init?(_ raw: String) {
        guard !raw.isEmpty, raw.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              raw == "0" || raw.first != "0" else { return nil }
        rawValue = raw
    }

    public init(_ value: Int) {
        precondition(value >= 0, "sequences are non-negative")
        rawValue = String(value)
    }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let sequence = CloudSequence(raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "sequence must be a decimal string"))
        }
        self = sequence
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static func < (lhs: CloudSequence, rhs: CloudSequence) -> Bool {
        lhs.rawValue.count == rhs.rawValue.count ? lhs.rawValue < rhs.rawValue : lhs.rawValue.count < rhs.rawValue.count
    }

    public var description: String { rawValue }
}

/// Any JSON value, kept verbatim so event payloads this build does not model
/// survive a decode. Integers stay integers so canonical encoding matches
/// every other client byte for byte.
public enum CloudJSON: Hashable, Codable, Sendable {
    case null
    case bool(Bool)
    case integer(Int)
    case number(Double)
    case string(String)
    case array([CloudJSON])
    case object([String: CloudJSON])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Int.self) { self = .integer(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([CloudJSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: CloudJSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public init<T: Encodable>(encoding value: T) throws {
        self = try JSONDecoder().decode(CloudJSON.self, from: JSONEncoder().encode(value))
    }

    public subscript(key: String) -> CloudJSON? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var isNull: Bool { self == .null }

    /// Re-decodes this value as a modelled type.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }

    /// shared/cloud-protocol `canonicalJson`: compact, object keys sorted by
    /// UTF-16 code unit, array order and exact strings kept, no
    /// normalization. Escapes match JSON.stringify.
    public var canonical: String {
        var out = ""
        write(into: &out)
        return out
    }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let value): out += value ? "true" : "false"
        case .integer(let value): out += String(value)
        case .number(let value):
            out += value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
        case .string(let value): Self.writeString(value, into: &out)
        case .array(let values):
            out += "["
            for (index, value) in values.enumerated() {
                if index > 0 { out += "," }
                value.write(into: &out)
            }
            out += "]"
        case .object(let object):
            out += "{"
            for (index, key) in object.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }).enumerated() {
                if index > 0 { out += "," }
                Self.writeString(key, into: &out)
                out += ":"
                object[key]!.write(into: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ value: String, into out: inout String) {
        out += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }
}

/// The error codes the server can answer with. Unknown codes are kept, so a
/// newer server never breaks an older phone.
public struct CloudErrorCode: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
    public var description: String { rawValue }

    public static let invalidRequest = Self(rawValue: "invalid_request")
    public static let identityUnavailable = Self(rawValue: "identity_unavailable")
    public static let unauthenticated = Self(rawValue: "unauthenticated")
    public static let forbidden = Self(rawValue: "forbidden")
    public static let notFound = Self(rawValue: "not_found")
    public static let operationConflict = Self(rawValue: "operation_conflict")
    public static let operationExpired = Self(rawValue: "operation_expired")
    public static let policyChanged = Self(rawValue: "policy_changed")
    public static let invalidMention = Self(rawValue: "invalid_mention")
    public static let unsupportedAttachment = Self(rawValue: "unsupported_attachment")
    public static let invalidReply = Self(rawValue: "invalid_reply")
    public static let recoveryUnknown = Self(rawValue: "recovery_unknown")
    public static let cursorInvalid = Self(rawValue: "cursor_invalid")
    public static let snapshotExpired = Self(rawValue: "snapshot_expired")
    public static let visibilityChanged = Self(rawValue: "visibility_changed")
    public static let upgradeRequired = Self(rawValue: "upgrade_required")
    public static let readCoverageLimit = Self(rawValue: "read_coverage_limit")
    public static let rateLimited = Self(rawValue: "rate_limited")
    public static let inviteExpired = Self(rawValue: "invite_expired")
    public static let inviteRevoked = Self(rawValue: "invite_revoked")
    public static let inviteUsed = Self(rawValue: "invite_used")
    public static let lastOwner = Self(rawValue: "last_owner")
    public static let unavailable = Self(rawValue: "unavailable")
    public static let deadlineExceeded = Self(rawValue: "deadline_exceeded")
    /// The issuer refused the bearer: sign in again, never retry it.
    public static let sessionInvalid = Self(rawValue: "session_invalid")
    public static let hostInvalid = Self(rawValue: "host_invalid")
    public static let leaseLost = Self(rawValue: "lease_lost")
    public static let controlConflict = Self(rawValue: "control_conflict")
    public static let approvalExpired = Self(rawValue: "approval_expired")
    public static let approvalDecided = Self(rawValue: "approval_decided")
    public static let attachmentUnready = Self(rawValue: "attachment_unready")
    public static let attachmentRejected = Self(rawValue: "attachment_rejected")

    /// Codes that say nothing about whether a send committed.
    public var isIndeterminate: Bool {
        [.identityUnavailable, .unauthenticated, .sessionInvalid, .unavailable, .deadlineExceeded].contains(self)
    }

    /// The bearer is gone for good; slice 1's `unauthenticated` means the same.
    public var isSessionInvalid: Bool { self == .sessionInvalid || self == .unauthenticated }
}

/// `{error, retry_after?}`, the body of every /v2 failure.
public struct CloudError: Error, Hashable, Codable, Sendable {
    public var error: CloudErrorCode
    public var retryAfter: Double?

    public init(_ error: CloudErrorCode, retryAfter: Double? = nil) {
        self.error = error; self.retryAfter = retryAfter
    }

    enum CodingKeys: String, CodingKey { case error, retryAfter = "retry_after" }
}

public enum CloudRole: String, Codable, Hashable, Sendable {
    case owner, admin, member, guest
}

public enum CloudActorKind: String, Codable, Hashable, Sendable {
    case human, bot
}

/// Who and where a send is admitted for. Bound into the signed window.
public struct CloudNamespace: Hashable, Codable, Sendable {
    public var service: String
    public var issuer: String
    public var subject: String
    public var accountId: String
    public var workspaceId: String
    public var epoch: String

    public init(service: String, issuer: String, subject: String, accountId: String, workspaceId: String, epoch: String) {
        self.service = service; self.issuer = issuer; self.subject = subject
        self.accountId = accountId; self.workspaceId = workspaceId; self.epoch = epoch
    }

    enum CodingKeys: String, CodingKey {
        case service, issuer, subject, accountId = "account_id", workspaceId = "workspace_id", epoch
    }
}

/// A selected mention: a half-open UTF-16 span of the exact message text.
public struct CloudMention: Hashable, Codable, Sendable {
    public var kind: CloudActorKind
    public var id: String
    public var start: Int
    public var end: Int

    public init(kind: CloudActorKind, id: String, start: Int, end: Int) {
        self.kind = kind; self.id = id; self.start = start; self.end = end
    }
}

/// A server-signed 30-day admission window, from POST operation-windows.
public struct CloudSendWindow: Hashable, Codable, Sendable {
    public var namespace: CloudNamespace
    public var windowId: String
    public var windowToken: String
    public var issuedAt: String
    public var expiresAt: String

    public init(namespace: CloudNamespace, windowId: String, windowToken: String, issuedAt: String, expiresAt: String) {
        self.namespace = namespace; self.windowId = windowId; self.windowToken = windowToken
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case namespace, windowId = "window_id", windowToken = "window_token", issuedAt = "issued_at", expiresAt = "expires_at"
    }

    public var expiryDate: Date? { CloudDate.parse(expiresAt) }
}

/// client_operation_id = window id + "." + random nonce.
public struct CloudOperationID: Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(windowId: String, nonce: String = CloudOperationID.randomNonce()) { rawValue = "\(windowId).\(nonce)" }
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
    public var description: String { rawValue }

    /// `window.nonce`, both parts [A-Za-z0-9_-], the nonce 16 to 128 long.
    public static func isValid(_ raw: String) -> Bool {
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        func idChars(_ part: Substring) -> Bool {
            part.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" }
        }
        return parts.count == 2 && !parts[0].isEmpty && (16...128).contains(parts[1].count) && idChars(parts[0]) && idChars(parts[1])
    }

    public static func randomNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
    }
}

/// Everything a send carries, frozen before its first transmission. A retry
/// sends exactly this under exactly this key; nothing is re-derived.
public struct CloudSendEnvelope: Hashable, Codable, Sendable {
    public var kind: String
    public var namespace: CloudNamespace
    public var clientOperationId: CloudOperationID
    public var windowToken: String
    public var roomId: String
    public var threadId: String
    public var text: String
    public var mentions: [CloudMention]
    public var attachmentIds: [String]
    public var replyToMessageId: String?
    public var expectedPolicyRevision: CloudSequence

    public init(window: CloudSendWindow, operation: CloudOperationID? = nil, roomId: String, threadId: String, text: String, mentions: [CloudMention] = [], replyToMessageId: String? = nil, expectedPolicyRevision: CloudSequence) {
        kind = "message.send"
        namespace = window.namespace
        clientOperationId = operation ?? CloudOperationID(windowId: window.windowId)
        windowToken = window.windowToken
        self.roomId = roomId; self.threadId = threadId; self.text = text; self.mentions = mentions
        attachmentIds = []
        self.replyToMessageId = replyToMessageId
        self.expectedPolicyRevision = expectedPolicyRevision
    }

    enum CodingKeys: String, CodingKey {
        case kind, namespace, clientOperationId = "client_operation_id", windowToken = "window_token"
        case roomId = "room_id", threadId = "thread_id", text, mentions, attachmentIds = "attachment_ids"
        case replyToMessageId = "reply_to_message_id", expectedPolicyRevision = "expected_policy_revision"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(namespace, forKey: .namespace)
        try c.encode(clientOperationId, forKey: .clientOperationId)
        try c.encode(windowToken, forKey: .windowToken)
        try c.encode(roomId, forKey: .roomId)
        try c.encode(threadId, forKey: .threadId)
        try c.encode(text, forKey: .text)
        try c.encode(mentions, forKey: .mentions)
        try c.encode(attachmentIds, forKey: .attachmentIds)
        // The key is required and nullable: the digest covers the null.
        try c.encode(replyToMessageId, forKey: .replyToMessageId)
        try c.encode(expectedPolicyRevision, forKey: .expectedPolicyRevision)
    }

    /// SHA-256 over the canonical JSON, the same digest the server stores
    /// and returns in receipts.
    public var digest: String {
        CloudDigest.sha256((try? CloudJSON(encoding: self).canonical) ?? "")
    }
}

public enum CloudDigest {
    public static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public enum CloudSendValidationError: Error, Hashable, Sendable {
    case textTooLarge(bytes: Int)
    case tooManyMentions
    case invalidMention(id: String)
    case unsupportedAttachment
    case invalidOperationId
}

public enum CloudSendValidation {
    /// The send schema's checks, run before anything is queued: text within
    /// 64 KiB, mention spans in bounds, ordered without overlap, never
    /// splitting a surrogate pair, and at most 32 distinct attachment ids.
    public static func validate(_ envelope: CloudSendEnvelope) throws {
        let bytes = envelope.text.utf8.count
        if bytes > CloudLimits.textBytes { throw CloudSendValidationError.textTooLarge(bytes: bytes) }
        if envelope.mentions.count > CloudLimits.mentions { throw CloudSendValidationError.tooManyMentions }
        if envelope.attachmentIds.count > CloudLimits.attachments || Set(envelope.attachmentIds).count != envelope.attachmentIds.count
            || !envelope.attachmentIds.allSatisfy(CloudID.isValid) { throw CloudSendValidationError.unsupportedAttachment }
        if !CloudOperationID.isValid(envelope.clientOperationId.rawValue) { throw CloudSendValidationError.invalidOperationId }
        if let bad = firstInvalidMention(text: envelope.text, mentions: envelope.mentions) {
            throw CloudSendValidationError.invalidMention(id: bad.id)
        }
    }

    public static func firstInvalidMention(text: String, mentions: [CloudMention]) -> CloudMention? {
        let units = Array(text.utf16)
        func boundary(_ n: Int) -> Bool {
            !(n > 0 && n < units.count && UTF16.isLeadSurrogate(units[n - 1]) && UTF16.isTrailSurrogate(units[n]))
        }
        var end = 0
        for mention in mentions.sorted(by: { $0.start < $1.start }) {
            if mention.start < end || mention.end <= mention.start || mention.end > units.count || !boundary(mention.start) || !boundary(mention.end) {
                return mention
            }
            end = mention.end
        }
        return nil
    }
}

/// A committed room message (or its tombstone).
public struct CloudMessage: Hashable, Codable, Sendable {
    public var workspaceId: String
    public var roomId: String
    public var threadId: String
    public var messageId: String
    public var actorId: String
    public var clientOperationId: String
    public var sequence: CloudSequence
    public var version: Int
    public var text: String
    public var mentions: [CloudMention]
    public var replyToMessageId: String?
    public var deleted: Bool
    /// Set on a bot's final; `actorId` is then the host owner, for audit.
    public var botId: String?
    /// Absent on messages from before slice 4.
    public var attachmentIds: [String]?
    public var createdAt: String

    public init(workspaceId: String, roomId: String, threadId: String, messageId: String, actorId: String, clientOperationId: String, sequence: CloudSequence, version: Int = 1, text: String, mentions: [CloudMention] = [], replyToMessageId: String? = nil, deleted: Bool = false, botId: String? = nil, attachmentIds: [String]? = nil, createdAt: String) {
        self.workspaceId = workspaceId; self.roomId = roomId; self.threadId = threadId; self.messageId = messageId
        self.actorId = actorId; self.clientOperationId = clientOperationId; self.sequence = sequence; self.version = version
        self.text = text; self.mentions = mentions; self.replyToMessageId = replyToMessageId
        self.deleted = deleted; self.botId = botId; self.attachmentIds = attachmentIds; self.createdAt = createdAt
    }

    public var attachments: [String] { attachmentIds ?? [] }

    enum CodingKeys: String, CodingKey {
        case workspaceId = "workspace_id", roomId = "room_id", threadId = "thread_id", messageId = "message_id"
        case actorId = "actor_id", clientOperationId = "client_operation_id", sequence, version, text, mentions
        case replyToMessageId = "reply_to_message_id", deleted, botId = "bot_id", attachmentIds = "attachment_ids", createdAt = "created_at"
    }
}

/// One room event from replay or the live stream.
public struct CloudEvent: Hashable, Codable, Sendable {
    public var schemaVersion: Int
    public var workspaceId: String
    public var roomId: String
    public var eventId: String
    public var sequence: CloudSequence
    public var kind: String
    public var required: Bool
    public var payload: [String: CloudJSON]

    public init(schemaVersion: Int = CloudLimits.schemaVersion, workspaceId: String, roomId: String, eventId: String, sequence: CloudSequence, kind: String, required: Bool = true, payload: [String: CloudJSON]) {
        self.schemaVersion = schemaVersion; self.workspaceId = workspaceId; self.roomId = roomId; self.eventId = eventId
        self.sequence = sequence; self.kind = kind; self.required = required; self.payload = payload
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", workspaceId = "workspace_id", roomId = "room_id"
        case eventId = "event_id", sequence, kind, required, payload
    }
}

public enum CloudEventKind {
    public static let messageCreated = "message.created"
    public static let messageUpdated = "message.updated"
    public static let messageDeleted = "message.deleted"
    public static let policyChanged = "room.policy_changed"
    public static let membershipChanged = "room.membership_changed"
    public static let presence = "presence"
    public static let invocationOffered = "invocation.offered"
    public static let invocationClaimed = "invocation.claimed"
    public static let streamDelta = "stream.delta"
    public static let finalCommit = "final.commit"
    public static let stopRequested = "stop.requested"
    public static let stopObserved = "stop.observed"
    public static let runUpdated = "run.updated"
    public static let approvalUpdated = "approval.updated"
    public static let attachmentUpdated = "attachment.updated"
    /// The workspace moved to a new authority epoch at a migration cutover.
    public static let authorityChanged = "authority_changed"
    public static let all: Set<String> = [messageCreated, messageUpdated, messageDeleted, policyChanged, membershipChanged, presence,
                                          invocationOffered, invocationClaimed, streamDelta, finalCommit, stopRequested, stopObserved,
                                          runUpdated, approvalUpdated, attachmentUpdated, authorityChanged]
}

public struct CloudMember: Hashable, Codable, Sendable {
    public var accountId: String
    public var role: CloudRole
    public init(accountId: String, role: CloudRole) { self.accountId = accountId; self.role = role }
    enum CodingKeys: String, CodingKey { case accountId = "account_id", role }
}

public struct CloudThreadSummary: Hashable, Codable, Sendable {
    public var threadId: String
    public var archived: Bool
    enum CodingKeys: String, CodingKey { case threadId = "thread_id", archived }
}

/// One viewed run, inclusive at both ends. On the wire: `[lo, hi]`.
public struct CloudReadInterval: Hashable, Codable, Sendable {
    public var low: CloudSequence
    public var high: CloudSequence

    public init(_ low: CloudSequence, _ high: CloudSequence) {
        precondition(low <= high, "interval runs forward")
        self.low = low; self.high = high
    }

    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        low = try c.decode(CloudSequence.self)
        high = try c.decode(CloudSequence.self)
        guard low <= high, c.isAtEnd else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "interval must be [lo, hi] with lo <= hi"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(low)
        try c.encode(high)
    }

    public func contains(_ sequence: CloudSequence) -> Bool { low <= sequence && sequence <= high }
}

/// Private read state for one account in one thread: everything up to
/// `prefix`, plus at most 256 viewed intervals. The server merges; the
/// phone only reports runs that were actually on screen together.
public struct CloudReadCoverage: Hashable, Codable, Sendable {
    public var prefix: CloudSequence
    public var intervals: [CloudReadInterval]
    /// The independent "mark unread" attention marker.
    public var attention: Bool

    public init(prefix: CloudSequence = CloudSequence(0), intervals: [CloudReadInterval] = [], attention: Bool = false) {
        self.prefix = prefix; self.intervals = intervals; self.attention = attention
    }

    public static let empty = CloudReadCoverage()

    public func covers(_ sequence: CloudSequence) -> Bool {
        sequence <= prefix || intervals.contains { $0.contains(sequence) }
    }

    /// At the bound, coverage stays conservative and the room offers an
    /// explicit Mark read at the acknowledged head.
    public var atLimit: Bool { intervals.count >= CloudLimits.sparseIntervals }

    /// Other actors' undeleted messages not yet covered, each counted once.
    /// Sync, push and presence never change this; only read state does.
    public func unreadCount(in messages: [CloudMessage], me: String) -> Int {
        var seen = Set<String>()
        return messages.reduce(0) { count, message in
            guard message.actorId != me, !message.deleted, seen.insert(message.messageId).inserted,
                  !covers(message.sequence) else { return count }
            return count + 1
        }
    }

    /// The runs to report for what is on screen. `loaded` is the thread's
    /// contiguously loaded messages, oldest first; a run never bridges a
    /// message that was loaded but not visible.
    public static func viewedRuns(visible: Set<String>, loaded: [CloudMessage]) -> [CloudReadInterval] {
        var runs: [CloudReadInterval] = []
        var current: (CloudSequence, CloudSequence)?
        for message in loaded {
            if visible.contains(message.messageId) {
                current = (current?.0 ?? message.sequence, message.sequence)
            } else if let run = current {
                runs.append(CloudReadInterval(run.0, run.1))
                current = nil
            }
        }
        if let run = current { runs.append(CloudReadInterval(run.0, run.1)) }
        return runs
    }
}

/// The reset projection: one consistent watermark H and what was true at it.
public struct CloudSnapshot: Hashable, Codable, Sendable {
    public var snapshotId: String
    public var expiresAt: String
    public var workspaceId: String
    public var roomId: String
    public var threadId: String
    public var watermark: CloudSequence
    public var frontier: CloudSequence
    public var cursor: String
    public var policyRevision: CloudSequence
    /// The selected thread's latest messages (at most 50).
    public var messages: [CloudMessage]
    public var members: [CloudMember]
    public var threads: [CloudThreadSummary]
    public var capabilities: [String]
    public var read: CloudReadCoverage
    public var activeRuns: [CloudInvocation]
    public var cards: [CloudApprovalCard]

    enum CodingKeys: String, CodingKey {
        case snapshotId = "snapshot_id", expiresAt = "expires_at", workspaceId = "workspace_id", roomId = "room_id"
        case threadId = "thread_id", watermark, frontier, cursor, policyRevision = "policy_revision"
        case messages, members, threads, capabilities, read, activeRuns = "active_runs", cards
    }
}

public struct CloudEventBatch: Hashable, Codable, Sendable {
    public var workspaceId: String
    public var roomId: String
    public var events: [CloudEvent]
    /// Opaque, signed; resubscribe with it.
    public var cursor: String
    /// How far the server scanned, including filtered events this account
    /// cannot see. Empty pages still advance.
    public var scannedSequence: CloudSequence
    public var frontier: CloudSequence
    public var live: Bool

    enum CodingKeys: String, CodingKey {
        case workspaceId = "workspace_id", roomId = "room_id", events, cursor
        case scannedSequence = "scanned_sequence", frontier, live
    }
}

public struct CloudReset: Hashable, Codable, Sendable {
    public enum Reason: String, Codable, Hashable, Sendable {
        case cursorInvalid = "cursor_invalid", visibilityChanged = "visibility_changed", overflow, snapshotExpired = "snapshot_expired"
    }
    public var workspaceId: String
    public var roomId: String
    public var reason: Reason
    public var snapshot: CloudSnapshot?

    enum CodingKeys: String, CodingKey { case workspaceId = "workspace_id", roomId = "room_id", reason, snapshot }
}

/// Frames from /v2/realtime.
public enum CloudFrame: Hashable, Sendable, Decodable {
    case batch(CloudEventBatch)
    case reset(CloudReset)
    case error(CloudErrorCode)
    case heartbeat

    enum CodingKeys: String, CodingKey { case type, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "event_batch": self = .batch(try CloudEventBatch(from: decoder))
        case "reset_required": self = .reset(try CloudReset(from: decoder))
        case "error": self = .error(try c.decode(CloudErrorCode.self, forKey: .error))
        case "heartbeat": self = .heartbeat
        case let other: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown frame \(other)")
        }
    }
}

/// Frames the phone sends on /v2/realtime.
public enum CloudOutboundFrame: Hashable, Sendable, Encodable {
    /// Always first: the bearer never goes in the URL.
    case authenticate(bearer: String)
    case subscribe(workspaceId: String, roomId: String, threadId: String, cursor: String?, snapshotId: String?)

    enum CodingKeys: String, CodingKey {
        case type, bearer, workspaceId = "workspace_id", roomId = "room_id", threadId = "thread_id", cursor, snapshotId = "snapshot_id"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .authenticate(let bearer):
            try c.encode("authenticate", forKey: .type)
            try c.encode(bearer, forKey: .bearer)
        case .subscribe(let workspaceId, let roomId, let threadId, let cursor, let snapshotId):
            try c.encode("subscribe", forKey: .type)
            try c.encode(workspaceId, forKey: .workspaceId)
            try c.encode(roomId, forKey: .roomId)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(cursor, forKey: .cursor)
            try c.encodeIfPresent(snapshotId, forKey: .snapshotId)
        }
    }
}

public struct CloudAcceptance: Hashable, Codable, Sendable {
    public var clientOperationId: String
    public var digest: String
    public var messageId: String
    public var roomId: String
    public var threadId: String
    public var sequence: CloudSequence
    public var redacted: Bool

    public init(clientOperationId: String, digest: String, messageId: String, roomId: String, threadId: String, sequence: CloudSequence, redacted: Bool) {
        self.clientOperationId = clientOperationId; self.digest = digest; self.messageId = messageId
        self.roomId = roomId; self.threadId = threadId; self.sequence = sequence; self.redacted = redacted
    }

    enum CodingKeys: String, CodingKey {
        case clientOperationId = "client_operation_id", digest, messageId = "message_id", roomId = "room_id"
        case threadId = "thread_id", sequence, redacted
    }
}

public struct CloudRejection: Hashable, Codable, Sendable {
    public var clientOperationId: String
    /// Nil only for a rejection the phone derived from an error body.
    public var digest: String?
    public var reason: CloudErrorCode

    public init(clientOperationId: String, digest: String?, reason: CloudErrorCode) {
        self.clientOperationId = clientOperationId; self.digest = digest; self.reason = reason
    }

    enum CodingKeys: String, CodingKey { case clientOperationId = "client_operation_id", digest, reason }
}

/// The authoritative answer to "did this operation commit".
public enum CloudOperationOutcome: Hashable, Sendable, Codable {
    case accepted(CloudAcceptance)
    case rejected(CloudRejection)
    /// Not committed yet: an unchanged replay or a seal is allowed.
    case notFound
    /// The ledger cannot say. Reconcile only; never resend or replace.
    case recoveryUnknown

    enum CodingKeys: String, CodingKey { case status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .status) {
        case "accepted": self = .accepted(try CloudAcceptance(from: decoder))
        case "rejected": self = .rejected(try CloudRejection(from: decoder))
        case "not_found": self = .notFound
        case "recovery_unknown": self = .recoveryUnknown
        case let other: throw DecodingError.dataCorruptedError(forKey: .status, in: c, debugDescription: "unknown operation status \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .accepted(let acceptance):
            try c.encode("accepted", forKey: .status)
            try acceptance.encode(to: encoder)
        case .rejected(let rejection):
            try c.encode("rejected", forKey: .status)
            try rejection.encode(to: encoder)
        case .notFound: try c.encode("not_found", forKey: .status)
        case .recoveryUnknown: try c.encode("recovery_unknown", forKey: .status)
        }
    }
}

/// GET /v2/discovery/sync: the full set of rooms this account can see.
public struct CloudDiscovery: Hashable, Codable, Sendable {
    public struct Workspace: Hashable, Codable, Sendable {
        public var workspaceId: String
        public var role: CloudRole
        public var rooms: [Room]
        enum CodingKeys: String, CodingKey { case workspaceId = "workspace_id", role, rooms }
    }
    public struct Room: Hashable, Codable, Sendable {
        public var roomId: String
        public var threadId: String
        public var policyRevision: CloudSequence
        enum CodingKeys: String, CodingKey { case roomId = "room_id", threadId = "thread_id", policyRevision = "policy_revision" }
    }
    public var workspaces: [Workspace]

    public var rooms: [CloudRoomRef] {
        workspaces.flatMap { workspace in
            workspace.rooms.map { CloudRoomRef(workspaceId: workspace.workspaceId, roomId: $0.roomId, threadId: $0.threadId, role: workspace.role) }
        }
    }
}

public struct CloudRoomRef: Hashable, Codable, Sendable {
    public var workspaceId: String
    public var roomId: String
    public var threadId: String
    /// Guest content stays in session memory only.
    public var role: CloudRole

    public init(workspaceId: String, roomId: String, threadId: String, role: CloudRole = .member) {
        self.workspaceId = workspaceId; self.roomId = roomId; self.threadId = threadId; self.role = role
    }

    public func sameRoom(_ other: CloudRoomRef) -> Bool { workspaceId == other.workspaceId && roomId == other.roomId }
}

enum CloudDate {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
