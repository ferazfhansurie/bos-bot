import Foundation
import CryptoKit

/// Who the phone is signed in as. Scopes local storage; the raw subject
/// never appears on disk.
public struct CloudAccountKey: Hashable, Codable, Sendable {
    public var service: String
    public var issuer: String
    /// The issuer's immutable subject, never an email or display name.
    public var subject: String

    public init(service: String, issuer: String, subject: String) {
        self.service = service; self.issuer = issuer; self.subject = subject
    }

    /// The on-disk folder name. Length-preserving encoding keeps ("a:b", "c")
    /// and ("a", "b:c") apart.
    public var namespace: String {
        let scope = (try? JSONEncoder().encode([service, issuer, subject])) ?? Data()
        return SHA256.hash(data: scope).map { String(format: "%02x", $0) }.joined()
    }

    public func owns(_ namespace: CloudNamespace) -> Bool {
        namespace.service == service && namespace.issuer == issuer && namespace.subject == subject
    }
}

/// Why a never-sent draft needs the person before it can go out.
public enum CloudHoldReason: String, Hashable, Codable, Sendable {
    /// Older than 24 hours.
    case stale
    /// The app died or the account was re-entered before first dispatch.
    case relaunched
    /// The room's audience or grants changed since it was written.
    case audienceChanged
    /// The message it replies to was rejected.
    case parentRejected
}

public enum CloudOutboxStatus: Hashable, Codable, Sendable {
    /// Saved, never transmitted.
    case draft
    /// Saved, waiting for its turn, a retry-after or the parent's id.
    case waiting(retryAt: Date?)
    /// Never transmitted and needs explicit review first.
    case held(CloudHoldReason)
    /// Transmitted, no answer yet.
    case sending
    /// The answer was lost, or the ledger had no commit yet: asking the
    /// ledger. The envelope is frozen from here on.
    case checking
    /// The ledger cannot say. Reconciliation only: never resent or sealed.
    case recoveryUnknown
    case accepted(CloudAcceptance)
    case rejected(CloudRejection)

    public var isResolved: Bool {
        switch self {
        case .accepted, .rejected: return true
        default: return false
        }
    }

    /// The label the room shows next to the bubble; also the corpus state.
    public var label: CloudOutboxLabel {
        switch self {
        case .draft, .held: return .draft
        case .waiting: return .waiting
        case .sending: return .sending
        case .checking, .recoveryUnknown: return .checking
        case .accepted: return .accepted
        case .rejected: return .rejected
        }
    }

    public var recoveryRequired: Bool { self == .recoveryUnknown }
}

public enum CloudOutboxLabel: String, Hashable, Codable, Sendable {
    case draft, waiting, sending, checking, accepted, rejected
}

public struct CloudOutboxEntry: Hashable, Codable, Sendable, Identifiable {
    public var envelope: CloudSendEnvelope
    /// Frozen at first dispatch; every later submit, lookup and seal carries
    /// exactly this.
    public var digest: String?
    public var status: CloudOutboxStatus
    public var createdAt: Date
    public var windowExpiresAt: Date
    /// A reply to a send that has no canonical id yet.
    public var replyToOperation: CloudOperationID?
    /// Set once the envelope has left the device. It can then never be
    /// edited, re-keyed or silently dropped.
    public var dispatched: Bool
    /// The ledger said not_found: an unchanged replay or a seal is allowed.
    public var notCommitted: Bool
    /// Whether a not_found may be replayed without the person. Only for
    /// sends dispatched in this process; never after relaunch or account
    /// return.
    public var autoReplay: Bool
    public var attempts: Int
    /// Guest drafts live in session memory only.
    public var ephemeral: Bool

    public var id: CloudOperationID { envelope.clientOperationId }

    public init(envelope: CloudSendEnvelope, status: CloudOutboxStatus = .draft, createdAt: Date, windowExpiresAt: Date, replyToOperation: CloudOperationID? = nil, ephemeral: Bool = false) {
        self.envelope = envelope; self.status = status; self.createdAt = createdAt
        self.windowExpiresAt = windowExpiresAt; self.replyToOperation = replyToOperation
        digest = nil; dispatched = false; notCommitted = false; autoReplay = false; attempts = 0
        self.ephemeral = ephemeral
    }
}

/// What the outbox needs done, in order. `persist` always precedes the I/O
/// it protects.
public enum CloudOutboxEffect: Hashable, Sendable {
    case persist
    case submit(CloudSendEnvelope)
    case lookup(CloudOperationID, workspaceId: String)
    /// resolve-not-accepted with the original envelope: returns the existing
    /// acceptance or seals a rejection.
    case seal(CloudSendEnvelope)
    case scheduleWake(after: TimeInterval)
}

/// The submit, lookup or seal answer the transport hands back.
public enum CloudSubmitResult: Hashable, Sendable {
    case outcome(CloudOperationOutcome)
    case rateLimited(retryAfter: TimeInterval)
    /// Timeout, dropped connection, 5xx, identity outage: no definitive answer.
    case indeterminate
    /// The device had no network, so the request never left it. Not an
    /// outcome either: the frozen envelope waits for the network.
    case offline
}

/// The durable, per-account queue of sends. Pure: every change returns the
/// effects to run, and the caller persists before transmitting.
public struct CloudOutbox: Hashable, Codable, Sendable {
    public private(set) var account: CloudAccountKey
    public internal(set) var entries: [CloudOutboxEntry] = []
    /// Bumped on account switch so late answers for the old account drop.
    public private(set) var generation: Int = 0

    public static let draftReviewAge: TimeInterval = 24 * 60 * 60

    public init(account: CloudAccountKey) { self.account = account }

    public func entry(_ id: CloudOperationID) -> CloudOutboxEntry? { entries.first { $0.id == id } }

    /// What gets written to disk: everything except guest drafts.
    public var persisted: CloudOutbox {
        var copy = self
        copy.entries.removeAll(where: \.ephemeral)
        return copy
    }

    /// Adds a send. Nothing is transmitted before `persist`.
    public mutating func enqueue(_ envelope: CloudSendEnvelope, windowExpiresAt: Date, replyToOperation: CloudOperationID? = nil, ephemeral: Bool = false, now: Date) throws -> [CloudOutboxEffect] {
        try CloudSendValidation.validate(envelope)
        precondition(account.owns(envelope.namespace), "envelope is for another account")
        guard entry(envelope.clientOperationId) == nil else { return [] }
        entries.append(CloudOutboxEntry(envelope: envelope, createdAt: now, windowExpiresAt: windowExpiresAt, replyToOperation: replyToOperation, ephemeral: ephemeral))
        return [.persist] + dispatch(now: now)
    }

    /// Restores a stored entry at a given state, as the corpus `outbox` step
    /// does. A dispatched envelope stays frozen whatever is passed in.
    mutating func persist(_ envelope: CloudSendEnvelope, as label: CloudOutboxLabel, now: Date) {
        let index: Int
        if let existing = entries.firstIndex(where: { $0.id == envelope.clientOperationId }) {
            index = existing
            if !entries[index].dispatched { entries[index].envelope = envelope }
        } else {
            entries.append(CloudOutboxEntry(envelope: envelope, createdAt: now, windowExpiresAt: now.addingTimeInterval(30 * 24 * 60 * 60)))
            index = entries.endIndex - 1
        }
        switch label {
        case .draft: entries[index].status = .draft
        case .waiting: entries[index].status = .waiting(retryAt: nil)
        case .sending, .checking:
            entries[index].status = label == .sending ? .sending : .checking
            entries[index].dispatched = true
            if entries[index].digest == nil { entries[index].digest = entries[index].envelope.digest }
        case .accepted, .rejected: break
        }
    }

    /// Starts the next send in each room whose earlier sends have resolved.
    public mutating func dispatch(now: Date) -> [CloudOutboxEffect] {
        var effects: [CloudOutboxEffect] = []
        var busyRooms = Set<String>()
        var soonestWake: Date?
        for index in entries.indices {
            let room = entries[index].envelope.roomId
            if busyRooms.contains(room) { continue }
            switch entries[index].status {
            case .accepted, .rejected:
                continue
            case .sending, .checking, .recoveryUnknown, .held:
                busyRooms.insert(room)
                continue
            case .waiting(let retryAt?) where retryAt > now:
                busyRooms.insert(room)
                soonestWake = min(soonestWake ?? retryAt, retryAt)
                continue
            case .draft, .waiting:
                busyRooms.insert(room)
            }
            if let parent = entries[index].replyToOperation {
                switch entry(parent)?.status {
                case .accepted(let acceptance)?:
                    entries[index].envelope.replyToMessageId = acceptance.messageId
                    entries[index].replyToOperation = nil
                case .rejected?, nil:
                    entries[index].status = .held(.parentRejected)
                    effects.append(.persist)
                    continue
                default:
                    if entries[index].status != .waiting(retryAt: nil) {
                        entries[index].status = .waiting(retryAt: nil)
                        effects.append(.persist)
                    }
                    continue
                }
            }
            if !entries[index].dispatched, entries[index].windowExpiresAt <= now {
                entries[index].status = .rejected(CloudRejection(clientOperationId: entries[index].id.rawValue, digest: nil, reason: .operationExpired))
                busyRooms.remove(room)
                effects.append(.persist)
                continue
            }
            effects += transmit(at: index)
        }
        if let soonestWake { effects.append(.scheduleWake(after: soonestWake.timeIntervalSince(now))) }
        return effects
    }

    /// Folds in a submit, lookup or seal answer. Answers for another
    /// generation, or for a send already resolved, are dropped.
    public mutating func answered(_ id: CloudOperationID, result: CloudSubmitResult, generation: Int, now: Date) -> [CloudOutboxEffect] {
        guard generation == self.generation, let index = entries.firstIndex(where: { $0.id == id }) else { return [] }
        switch entries[index].status {
        case .sending, .checking, .recoveryUnknown: return apply(result, at: index, now: now)
        default: return []
        }
    }

    /// The room stream carried this send's commit: it is accepted whatever
    /// the submit call is still doing.
    public mutating func observed(_ message: CloudMessage, now: Date) -> [CloudOutboxEffect] {
        guard let index = entries.firstIndex(where: { $0.id.rawValue == message.clientOperationId && $0.envelope.roomId == message.roomId }),
              entries[index].envelope.namespace.accountId == message.actorId else { return [] }
        if case .accepted = entries[index].status { return [] }
        entries[index].status = .accepted(CloudAcceptance(clientOperationId: message.clientOperationId, digest: entries[index].digest ?? entries[index].envelope.digest, messageId: message.messageId, roomId: message.roomId, threadId: message.threadId, sequence: message.sequence, redacted: false))
        return [.persist] + dispatch(now: now)
    }

    /// After relaunch or account return: anything that left the device is
    /// checked against the ledger and never replayed without the person;
    /// anything that never left needs review before it goes.
    public mutating func recoverAfterLaunch(now: Date) -> [CloudOutboxEffect] {
        var effects: [CloudOutboxEffect] = []
        for index in entries.indices where !entries[index].status.isResolved {
            entries[index].autoReplay = false
            if entries[index].dispatched {
                if entries[index].status != .recoveryUnknown { entries[index].status = .checking }
                effects.append(.lookup(entries[index].id, workspaceId: entries[index].envelope.namespace.workspaceId))
            } else if case .held = entries[index].status {
                continue
            } else {
                entries[index].status = .held(now.timeIntervalSince(entries[index].createdAt) > Self.draftReviewAge ? .stale : .relaunched)
            }
        }
        return effects.isEmpty ? [] : [.persist] + effects
    }

    /// Marks never-sent drafts in a room for review after its audience or
    /// grants changed. Dispatched sends keep their original envelope.
    public mutating func audienceChanged(roomId: String) -> [CloudOutboxEffect] {
        var changed = false
        for index in entries.indices where entries[index].envelope.roomId == roomId && !entries[index].dispatched && !entries[index].status.isResolved {
            entries[index].status = .held(.audienceChanged)
            changed = true
        }
        return changed ? [.persist] : []
    }

    /// Access to a room ended: its never-sent drafts go; dispatched sends
    /// stay until the ledger resolves them.
    public mutating func roomRemoved(roomId: String) -> [CloudOutboxEffect] {
        let before = entries.count
        entries.removeAll { $0.envelope.roomId == roomId && !$0.dispatched }
        return entries.count == before ? [] : [.persist]
    }

    /// The person reviewed a held draft and chose to send it as is.
    public mutating func release(_ id: CloudOperationID, now: Date) -> [CloudOutboxEffect] {
        guard let index = entries.firstIndex(where: { $0.id == id }), case .held = entries[index].status, !entries[index].dispatched else { return [] }
        if now.timeIntervalSince(entries[index].createdAt) > Self.draftReviewAge { entries[index].createdAt = now }
        entries[index].status = .draft
        return [.persist] + dispatch(now: now)
    }

    /// The person chose to send a not-yet-committed send again: the same
    /// envelope under the same key.
    public mutating func resend(_ id: CloudOperationID, now: Date) -> [CloudOutboxEffect] {
        guard let index = entries.firstIndex(where: { $0.id == id }), entries[index].status == .checking, entries[index].notCommitted,
              entries[index].windowExpiresAt > now else { return [] }
        return transmit(at: index)
    }

    /// The person gave up on a not-yet-committed send: ask the server to
    /// seal it. Recovery-unknown sends can never be sealed.
    public mutating func giveUp(_ id: CloudOperationID) -> [CloudOutboxEffect] {
        guard let entry = entry(id), entry.status == .checking, entry.notCommitted else { return [] }
        return [.seal(entry.envelope)]
    }

    /// Discards a send that never left the device, or a resolved one.
    public mutating func discard(_ id: CloudOperationID) -> [CloudOutboxEffect] {
        guard let index = entries.firstIndex(where: { $0.id == id }), !entries[index].dispatched || entries[index].status.isResolved else { return [] }
        entries.remove(at: index)
        return [.persist]
    }

    /// A scheduled wake: start whatever is due, replay not-yet-committed
    /// sends that may replay on their own, and re-ask the ledger about the
    /// rest. Lookups are idempotent.
    public mutating func wake(now: Date) -> [CloudOutboxEffect] {
        var effects: [CloudOutboxEffect] = []
        for index in entries.indices where entries[index].status == .checking {
            if entries[index].notCommitted {
                if entries[index].autoReplay, entries[index].windowExpiresAt > now { effects += transmit(at: index) }
            } else {
                effects.append(.lookup(entries[index].id, workspaceId: entries[index].envelope.namespace.workspaceId))
            }
        }
        return dispatch(now: now) + effects
    }

    /// Account switch: the old account's queue stays in its own store,
    /// untouched; late callbacks for it are dropped.
    public mutating func switchAccount(to account: CloudAccountKey, entries: [CloudOutboxEntry] = []) {
        self.account = account
        self.entries = entries
        generation += 1
    }

    private mutating func transmit(at index: Int) -> [CloudOutboxEffect] {
        if entries[index].digest == nil {
            entries[index].digest = entries[index].envelope.digest
            entries[index].autoReplay = true
        }
        entries[index].status = .sending
        entries[index].dispatched = true
        entries[index].notCommitted = false
        entries[index].attempts += 1
        return [.persist, .submit(entries[index].envelope)]
    }

    private mutating func apply(_ result: CloudSubmitResult, at index: Int, now: Date) -> [CloudOutboxEffect] {
        switch result {
        case .outcome(.accepted(let acceptance)):
            guard acceptance.digest == entries[index].digest || entries[index].digest == nil else {
                // A receipt for different bytes under this key is not ours.
                entries[index].status = .recoveryUnknown
                return [.persist]
            }
            entries[index].status = .accepted(acceptance)
            return [.persist] + dispatch(now: now)
        case .outcome(.rejected(var rejection)):
            if rejection.clientOperationId.isEmpty { rejection.clientOperationId = entries[index].id.rawValue }
            entries[index].status = .rejected(rejection)
            return [.persist] + dispatch(now: now)
        case .outcome(.notFound):
            // Not committed yet, and not proof it never will be. Keep the
            // frozen envelope and look again later.
            entries[index].status = .checking
            entries[index].notCommitted = true
            return [.persist, .scheduleWake(after: CloudBackoff.delay(attempt: entries[index].attempts))]
        case .outcome(.recoveryUnknown):
            entries[index].status = .recoveryUnknown
            entries[index].autoReplay = false
            return [.persist]
        case .rateLimited(let retryAfter):
            if entries[index].status == .sending {
                entries[index].status = .checking
                entries[index].notCommitted = true
                return [.persist, .scheduleWake(after: retryAfter)]
            }
            return [.scheduleWake(after: retryAfter)]
        case .offline:
            // Nothing reached the server. A send waits, unchanged and still
            // frozen, for the network; a lookup just asks again later. The
            // app wakes the outbox when the network returns; the long wake
            // is only a backstop.
            if entries[index].status == .sending {
                entries[index].status = .waiting(retryAt: nil)
                return [.persist, .scheduleWake(after: CloudBackoff.cap)]
            }
            return [.scheduleWake(after: CloudBackoff.cap)]
        case .indeterminate:
            let wasChecking = entries[index].status == .checking
            entries[index].status = .checking
            entries[index].notCommitted = false
            if wasChecking {
                entries[index].attempts += 1
                return [.persist, .scheduleWake(after: CloudBackoff.delay(attempt: entries[index].attempts))]
            }
            return [.persist, .lookup(entries[index].id, workspaceId: entries[index].envelope.namespace.workspaceId)]
        }
    }
}

/// Full-jitter exponential backoff, capped at 30 seconds.
public enum CloudBackoff {
    public static let base: TimeInterval = 0.5
    public static let cap: TimeInterval = 30

    public static func ceiling(attempt: Int) -> TimeInterval {
        min(cap, base * pow(2, Double(max(0, attempt))))
    }

    public static func delay(attempt: Int, retryAfter: TimeInterval? = nil) -> TimeInterval {
        if let retryAfter { return max(0, retryAfter) }
        var generator = SystemRandomNumberGenerator()
        return Double.random(in: 0...ceiling(attempt: attempt), using: &generator)
    }
}
