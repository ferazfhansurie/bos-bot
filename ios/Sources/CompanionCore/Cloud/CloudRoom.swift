import Foundation

public enum CloudRoomEffect: Hashable, Sendable {
    /// Save cursor and projection together.
    case persist
    /// (Re)subscribe on /v2/realtime from this cursor; nil asks for a reset
    /// that carries an initial snapshot.
    case subscribe(cursor: String?, snapshotId: String?)
    /// POST .../snapshot for the selected thread.
    case fetchSnapshot
    case closeStream
    /// The stream carried one of this account's sends; hand it to the outbox.
    case observedOwnSend(CloudMessage)
    /// Policy or membership moved; never-sent drafts need review.
    case audienceChanged
    /// Membership changed: discovery is the authority on what remains.
    case resyncDiscovery
    /// The server moved one of this account's attachments.
    case attachmentUpdated(CloudAttachment)
}

/// A bot's not-yet-committed reply. Memory only; final.commit replaces it.
public struct CloudStreamText: Hashable, Sendable {
    public var binding: CloudRunBinding
    public var deltaIds: Set<String> = []
    public var text = ""
}

/// One room's cache and stream position for the selected thread. Pure:
/// every input returns the effects to run, and the projection and cursor
/// only ever change together.
public struct CloudRoomState: Hashable, Codable, Sendable {
    public static let cachedMessageLimit = 500

    public let workspaceId: String
    public let roomId: String
    /// The selected thread. Other threads' content never moves it.
    public let threadId: String
    /// The signed-in account id; its own sends are handed to the outbox.
    public let me: String
    public var role: CloudRole
    /// Opaque, server-signed; nil until the first snapshot.
    public private(set) var cursor: String?
    /// The pinned snapshot being caught up from, until the stream is live.
    public private(set) var snapshotId: String?
    /// H: the last snapshot's watermark. Nothing at or below it re-applies.
    public private(set) var watermark: CloudSequence?
    /// The highest event sequence folded in; duplicates at or below drop.
    public private(set) var applied: CloudSequence?
    public private(set) var policyRevision: CloudSequence?
    public private(set) var members: [CloudMember] = []
    /// The selected thread's messages, oldest first by sequence.
    public private(set) var messages: [CloudMessage] = []
    public private(set) var read: CloudReadCoverage = .empty
    public private(set) var live = false
    public private(set) var resetRequired = false
    /// A required event this build cannot read; the cursor stays before it.
    public private(set) var upgradeRequired = false
    /// The selected thread's runs and this account's cards, by id. Optional
    /// so caches from before slice 3 still decode.
    private var runStore: [String: CloudInvocation]?
    private var cardStore: [String: CloudApprovalCard]?
    /// Provisional bot text by invocation. Never persisted.
    public private(set) var streaming: [String: CloudStreamText] = [:]

    enum CodingKeys: String, CodingKey {
        case workspaceId, roomId, threadId, me, role, cursor, snapshotId, watermark, applied, policyRevision
        case members, messages, read, live, resetRequired, upgradeRequired, runStore, cardStore
    }

    public init(workspaceId: String, roomId: String, threadId: String, me: String, role: CloudRole = .member) {
        self.workspaceId = workspaceId; self.roomId = roomId; self.threadId = threadId; self.me = me; self.role = role
    }

    public var messageIds: [String] { messages.map(\.messageId) }

    /// Runs oldest source first.
    public var runs: [CloudInvocation] {
        (runStore ?? [:]).values.sorted { ($0.queuedExpiresAt, $0.invocationId) < ($1.queuedExpiresAt, $1.invocationId) }
    }

    public var cards: [CloudApprovalCard] {
        (cardStore ?? [:]).values.sorted { ($0.expiresAt, $0.approvalId) < ($1.expiresAt, $1.approvalId) }
    }

    public func run(_ invocationId: String) -> CloudInvocation? { runStore?[invocationId] }
    public func card(_ approvalId: String) -> CloudApprovalCard? { cardStore?[approvalId] }

    /// A decision or GET answer. Older versions never replace newer ones.
    @discardableResult
    public mutating func apply(card: CloudApprovalCard) -> [CloudRoomEffect] {
        guard card.workspaceId == workspaceId, card.roomId == roomId, card.threadId == threadId, card.actorId == me else { return [] }
        if let old = cardStore?[card.approvalId], old.version > card.version || old == card { return [] }
        cardStore = (cardStore ?? [:]).merging([card.approvalId: card]) { $1 }
        return [.persist]
    }

    /// Foreground resubscribe from the acknowledged cursor.
    public mutating func resubscribe() -> [CloudRoomEffect] {
        if upgradeRequired { return [] }
        return [.subscribe(cursor: cursor, snapshotId: snapshotId)]
    }

    /// Background: release the socket, keep cursor and projection.
    public mutating func background() -> [CloudRoomEffect] {
        live = false
        return [.closeStream]
    }

    public mutating func receive(_ frame: CloudFrame) -> [CloudRoomEffect] {
        switch frame {
        case .batch(let batch): return apply(batch)
        case .reset(let reset):
            guard reset.workspaceId == workspaceId, reset.roomId == roomId else { return [] }
            live = false
            resetRequired = true
            if let snapshot = reset.snapshot {
                let effects = apply(snapshot)
                if !effects.isEmpty { return effects + [.subscribe(cursor: snapshot.cursor, snapshotId: snapshot.snapshotId)] }
            }
            return [.fetchSnapshot]
        case .error(let code):
            live = false
            if code == .upgradeRequired {
                upgradeRequired = true
                return [.closeStream, .persist]
            }
            if code == .cursorInvalid || code == .snapshotExpired || code == .visibilityChanged {
                resetRequired = true
                return [.fetchSnapshot]
            }
            return [.closeStream]
        case .heartbeat:
            return []
        }
    }

    /// Atomically replaces the selected projection, cursor and read state.
    /// The outbox lives elsewhere and is untouched.
    @discardableResult
    public mutating func apply(_ snapshot: CloudSnapshot) -> [CloudRoomEffect] {
        guard snapshot.workspaceId == workspaceId, snapshot.roomId == roomId, snapshot.threadId == threadId else { return [] }
        messages = Self.capped(snapshot.messages.filter { $0.threadId == threadId }.sorted { $0.sequence < $1.sequence })
        members = snapshot.members
        read = snapshot.read
        runStore = Dictionary(snapshot.activeRuns.filter { $0.threadId == threadId }.map { ($0.invocationId, $0) }) { $1 }
        cardStore = Dictionary(snapshot.cards.filter { $0.threadId == threadId && $0.actorId == me }.map { ($0.approvalId, $0) }) { $1 }
        streaming = [:]
        policyRevision = snapshot.policyRevision
        cursor = snapshot.cursor
        snapshotId = snapshot.snapshotId
        watermark = snapshot.watermark
        applied = snapshot.watermark
        live = false
        resetRequired = false
        upgradeRequired = false
        return [.persist]
    }

    /// The server's merged private coverage replaces ours. Sync, push and
    /// presence never call this; only an explicit read does.
    public mutating func apply(_ coverage: CloudReadCoverage) -> [CloudRoomEffect] {
        read = coverage
        return [.persist]
    }

    public var unreadCount: Int { read.unreadCount(in: messages, me: me) }

    // MARK: - Batches

    private enum Step {
        case upsert(CloudMessage)
        case audience(resync: Bool, policy: CloudSequence?)
        case run(CloudInvocation)
        case claimed(CloudRunBinding, hostId: String, lease: String, model: CloudModel)
        case delta(CloudRunBinding, id: String, text: String)
        case final(CloudRunBinding, CloudMessage)
        case stop(CloudRunBinding, revision: CloudSequence, observed: Bool)
        case card(CloudApprovalCard)
        case attachment(CloudAttachment)
        case presence(hostId: String, online: Bool)
        case skip
    }

    /// Validates the whole batch before touching anything: one unreadable
    /// required event blocks all of it, keeping the old projection and
    /// cursor.
    private mutating func apply(_ batch: CloudEventBatch) -> [CloudRoomEffect] {
        guard batch.workspaceId == workspaceId, batch.roomId == roomId, !upgradeRequired else { return [] }
        var floor = applied
        var steps: [(CloudSequence, Step)] = []
        for event in batch.events {
            guard event.workspaceId == workspaceId, event.roomId == roomId else { return [] }
            if let floor, event.sequence <= floor { continue }
            guard let step = Self.read(event) else {
                upgradeRequired = true
                live = false
                return [.closeStream, .persist]
            }
            steps.append((event.sequence, step))
            floor = event.sequence
        }

        var effects: [CloudRoomEffect] = [.persist]
        var audience = false, resync = false
        for (sequence, step) in steps {
            applied = sequence
            switch step {
            case .upsert(let message):
                if message.actorId == me, message.botId == nil { effects.append(.observedOwnSend(message)) }
                guard message.threadId == threadId else { continue }
                upsert(message)
            case .run(let run):
                guard run.threadId == threadId else { continue }
                if let old = runStore?[run.invocationId], old.fenceGen > run.fenceGen { continue }
                runStore = (runStore ?? [:]).merging([run.invocationId: run]) { $1 }
                if run.state.finished || streaming[run.invocationId]?.binding != run.binding { streaming[run.invocationId] = nil }
            case .claimed(let binding, let hostId, let lease, let model):
                guard var run = runStore?[binding.invocationId], binding.fenceGen > run.fenceGen else { continue }
                run.attempt = binding.attempt; run.fenceGen = binding.fenceGen
                run.hostId = hostId; run.leaseExpiresAt = lease; run.model = model; run.state = .leased
                runStore?[binding.invocationId] = run
                streaming[binding.invocationId] = nil
            case .delta(let binding, let id, let text):
                guard let run = runStore?[binding.invocationId], run.binding == binding, !run.state.finished else { continue }
                var stream = streaming[binding.invocationId].flatMap { $0.binding == binding ? $0 : nil } ?? CloudStreamText(binding: binding)
                guard stream.deltaIds.insert(id).inserted else { continue }
                stream.text += text
                streaming[binding.invocationId] = stream
            case .final(let binding, let message):
                streaming[binding.invocationId] = nil
                guard message.threadId == threadId else { continue }
                upsert(message)
                if var run = runStore?[binding.invocationId], run.binding == binding {
                    run.resultMessageId = message.messageId
                    runStore?[binding.invocationId] = run
                }
            case .stop(let binding, let revision, let observed):
                guard var run = runStore?[binding.invocationId], run.binding == binding else { continue }
                if observed { run.stoppedObserved = true } else { run.stopRequested = true }
                if revision > run.controlRevision { run.controlRevision = revision }
                runStore?[binding.invocationId] = run
            case .card(let card):
                apply(card: card)
            case .attachment(let attachment):
                effects.append(.attachmentUpdated(attachment))
            case .presence(let hostId, let online):
                for (id, run) in runStore ?? [:] where run.hostId == hostId { runStore?[id]?.hostOnline = online }
            case .audience(let needsResync, let policy):
                audience = true
                resync = resync || needsResync
                if let policy { policyRevision = policy }
            case .skip:
                continue
            }
        }
        // Empty or fully filtered pages still advance.
        cursor = batch.cursor
        live = batch.live
        // Caught up to B: the cursor alone now says where to resume.
        if live { snapshotId = nil }
        if audience { effects.append(.audienceChanged) }
        if resync { effects.append(.resyncDiscovery) }
        return effects
    }

    /// Nil means this build cannot read a required event.
    private static func read(_ event: CloudEvent) -> Step? {
        guard event.schemaVersion <= CloudLimits.schemaVersion else { return event.required ? nil : .skip }
        switch event.kind {
        case CloudEventKind.messageCreated, CloudEventKind.messageUpdated, CloudEventKind.messageDeleted:
            guard let message = try? event.payload["message"]?.decode(CloudMessage.self),
                  message.workspaceId == event.workspaceId, message.roomId == event.roomId else { return event.required ? nil : .skip }
            return .upsert(message)
        case CloudEventKind.policyChanged:
            return .audience(resync: false, policy: event.payload["policy_revision"]?.stringValue.flatMap(CloudSequence.init))
        case CloudEventKind.membershipChanged:
            return .audience(resync: true, policy: nil)
        case CloudEventKind.invocationOffered, CloudEventKind.runUpdated:
            guard let run = try? event.payload["invocation"]?.decode(CloudInvocation.self),
                  run.workspaceId == event.workspaceId, run.roomId == event.roomId else { return event.required ? nil : .skip }
            return .run(run)
        case CloudEventKind.invocationClaimed:
            guard let p = Self.payload(event, ClaimedPayload.self) else { return event.required ? nil : .skip }
            return .claimed(p.binding, hostId: p.hostId, lease: p.leaseExpiresAt, model: p.model)
        case CloudEventKind.streamDelta:
            guard let p = Self.payload(event, DeltaPayload.self) else { return event.required ? nil : .skip }
            return .delta(p.binding, id: p.deltaId, text: p.text)
        case CloudEventKind.finalCommit:
            guard let p = Self.payload(event, FinalPayload.self),
                  p.message.workspaceId == event.workspaceId, p.message.roomId == event.roomId else { return event.required ? nil : .skip }
            return .final(p.binding, p.message)
        case CloudEventKind.stopRequested, CloudEventKind.stopObserved:
            guard let p = Self.payload(event, StopPayload.self) else { return event.required ? nil : .skip }
            return .stop(p.binding, revision: p.controlRevision, observed: event.kind == CloudEventKind.stopObserved)
        case CloudEventKind.approvalUpdated:
            guard let card = try? event.payload["card"]?.decode(CloudApprovalCard.self),
                  card.workspaceId == event.workspaceId, card.roomId == event.roomId else { return event.required ? nil : .skip }
            return .card(card)
        case CloudEventKind.attachmentUpdated:
            guard let attachment = try? event.payload["attachment"]?.decode(CloudAttachment.self),
                  attachment.workspaceId == event.workspaceId, attachment.roomId == event.roomId else { return event.required ? nil : .skip }
            return .attachment(attachment)
        case CloudEventKind.presence:
            guard let p = Self.payload(event, PresencePayload.self) else { return .skip }
            return .presence(hostId: p.hostId, online: p.online)
        default:
            return event.required ? nil : .skip
        }
    }

    private static func payload<T: Decodable>(_ event: CloudEvent, _ type: T.Type) -> T? {
        try? CloudJSON.object(event.payload).decode(T.self)
    }

    private struct ClaimedPayload: Decodable {
        var invocationId: String, attempt: Int, fenceGen: CloudSequence, hostId: String, model: CloudModel, leaseExpiresAt: String
        var binding: CloudRunBinding { CloudRunBinding(invocationId: invocationId, attempt: attempt, fenceGen: fenceGen) }
        enum CodingKeys: String, CodingKey {
            case invocationId = "invocation_id", attempt, fenceGen = "fence_gen", hostId = "host_id", model, leaseExpiresAt = "lease_expires_at"
        }
    }

    private struct DeltaPayload: Decodable {
        var invocationId: String, attempt: Int, fenceGen: CloudSequence, deltaId: String, text: String
        var binding: CloudRunBinding { CloudRunBinding(invocationId: invocationId, attempt: attempt, fenceGen: fenceGen) }
        enum CodingKeys: String, CodingKey { case invocationId = "invocation_id", attempt, fenceGen = "fence_gen", deltaId = "delta_id", text }
    }

    private struct FinalPayload: Decodable {
        var invocationId: String, attempt: Int, fenceGen: CloudSequence, message: CloudMessage
        var binding: CloudRunBinding { CloudRunBinding(invocationId: invocationId, attempt: attempt, fenceGen: fenceGen) }
        enum CodingKeys: String, CodingKey { case invocationId = "invocation_id", attempt, fenceGen = "fence_gen", message }
    }

    private struct StopPayload: Decodable {
        var invocationId: String, attempt: Int, fenceGen: CloudSequence, controlRevision: CloudSequence
        var binding: CloudRunBinding { CloudRunBinding(invocationId: invocationId, attempt: attempt, fenceGen: fenceGen) }
        enum CodingKeys: String, CodingKey { case invocationId = "invocation_id", attempt, fenceGen = "fence_gen", controlRevision = "control_revision" }
    }

    private struct PresencePayload: Decodable {
        var hostId: String, online: Bool
        enum CodingKeys: String, CodingKey { case hostId = "host_id", online }
    }

    private mutating func upsert(_ message: CloudMessage) {
        if let index = messages.firstIndex(where: { $0.messageId == message.messageId }) {
            if message.version >= messages[index].version { messages[index] = message }
            return
        }
        let index = messages.firstIndex { $0.sequence > message.sequence } ?? messages.endIndex
        messages.insert(message, at: index)
        messages = Self.capped(messages)
    }

    private static func capped(_ messages: [CloudMessage]) -> [CloudMessage] {
        messages.count > cachedMessageLimit ? Array(messages.suffix(cachedMessageLimit)) : messages
    }
}

/// What the phone shows for the signed-in account: the selected room's
/// projection and the account's outbox. Account switch clears both, and
/// callbacks for another account are ignored.
public struct CloudProjection: Hashable, Sendable {
    public private(set) var account: CloudAccountKey
    public var room: CloudRoomState
    public var outbox: CloudOutbox

    public init(account: CloudAccountKey, room: CloudRoomState, outbox: CloudOutbox? = nil) {
        self.account = account
        self.room = room
        self.outbox = outbox ?? CloudOutbox(account: account)
    }

    public var namespace: String { account.subject }

    /// A submit, lookup or seal answer. Answers tagged for another account
    /// are dropped before they touch anything.
    public mutating func operation(_ id: CloudOperationID, result: CloudSubmitResult, account: CloudAccountKey? = nil, now: Date) -> [CloudOutboxEffect] {
        if let account, account != self.account { return [] }
        return outbox.answered(id, result: result, generation: outbox.generation, now: now)
    }

    public mutating func receive(_ frame: CloudFrame, now: Date) -> (room: [CloudRoomEffect], outbox: [CloudOutboxEffect]) {
        let effects = room.receive(frame)
        var outboxEffects: [CloudOutboxEffect] = []
        for case .observedOwnSend(let message) in effects { outboxEffects += outbox.observed(message, now: now) }
        return (effects, outboxEffects)
    }

    /// Switches the visible account. The previous account's queue stays in
    /// its own store and never dispatches as the new one.
    public mutating func switchAccount(to next: CloudAccountKey, room: CloudRoomState, entries: [CloudOutboxEntry] = []) {
        account = next
        self.room = room
        outbox.switchAccount(to: next, entries: entries)
    }
}
