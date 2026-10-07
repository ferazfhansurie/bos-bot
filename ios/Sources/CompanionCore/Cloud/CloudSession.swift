import Foundation

public enum CloudSessionInput: Hashable, Sendable {
    case foreground
    case background
    case authRefreshed(generation: Int)
    case authFailed(generation: Int, retryAfter: TimeInterval?)
    /// GET /v2/discovery/sync: the full authorized set, not a delta.
    case discoverySynced(generation: Int, CloudDiscovery)
    case discoveryFailed(generation: Int, retryAfter: TimeInterval?)
    /// The one /v2/realtime socket closed or failed.
    case socketEnded(generation: Int, retryAfter: TimeInterval?)
    case socketLive(generation: Int)
    case retryDue(CloudSessionTimer, generation: Int)
    case accountChanged(CloudAccountKey?)
    case signedOut
}

public enum CloudSessionEffect: Hashable, Sendable {
    case refreshAuth(generation: Int)
    case syncDiscovery(generation: Int)
    /// Runs before anything reopens: drop the cached room and its unsent drafts.
    case removeRoom(CloudRoomRef)
    /// Open /v2/realtime and send the authenticate frame first.
    case openSocket(generation: Int)
    /// Send a subscribe frame from the room's own cursor.
    case subscribe(CloudRoomRef)
    case closeSocket
    /// Lookups for unresolved sends, after authentication.
    case recoverOperations
    case schedule(CloudSessionTimer, after: TimeInterval, generation: Int)
    /// Drop everything shown for the previous account and cancel its callbacks.
    case clearVisibleState(previousGeneration: Int)
    /// Load the new account's own store; the old one is left for its owner.
    case openStore(CloudAccountKey)
    /// Explicit logout: erase local payload, outbox, tokens and previews.
    case eraseStore(CloudAccountKey)
}

public enum CloudSessionTimer: Hashable, Sendable {
    case recovery
    case reconnect
}

/// The phone's cloud lifecycle. Foreground coalesces auth, discovery,
/// resubscribe and operation recovery into one pass; background releases
/// the socket but keeps every cursor and the outbox.
public struct CloudSession: Hashable, Sendable {
    public private(set) var account: CloudAccountKey?
    public private(set) var generation = 0
    public private(set) var isForeground = false
    public private(set) var isRecovering = false
    /// Rooms from the last discovery, in priority order.
    public private(set) var known: [CloudRoomRef] = []
    public private(set) var subscribed: [CloudRoomRef] = []
    /// The room on screen; always first to subscribe.
    public var selected: CloudRoomRef?
    private var recoveryAttempt = 0
    private var socketAttempt = 0

    public init(account: CloudAccountKey?) { self.account = account }

    public mutating func reduce(_ input: CloudSessionInput) -> [CloudSessionEffect] {
        switch input {
        case .foreground:
            isForeground = true
            return startRecovery()

        case .background:
            isForeground = false
            isRecovering = false
            subscribed = []
            socketAttempt = 0
            return [.closeSocket]

        case .authRefreshed(let generation):
            guard current(generation), isRecovering else { return [] }
            return [.syncDiscovery(generation: generation)]

        case .authFailed(let generation, let retryAfter), .discoveryFailed(let generation, let retryAfter):
            guard current(generation), isRecovering else { return [] }
            isRecovering = false
            recoveryAttempt += 1
            return [.schedule(.recovery, after: CloudBackoff.delay(attempt: recoveryAttempt, retryAfter: retryAfter), generation: generation)]

        case .discoverySynced(let generation, let discovery):
            guard current(generation), isRecovering else { return [] }
            isRecovering = false
            recoveryAttempt = 0
            let rooms = discovery.rooms
            // Removals first, so nothing reopens a room the account lost.
            let gone = known.filter { old in !rooms.contains { $0.sameRoom(old) } }
            var effects: [CloudSessionEffect] = gone.map { .removeRoom($0) }
            if let selected, gone.contains(where: { $0.sameRoom(selected) }) { self.selected = nil }
            known = rooms
            effects += resubscribe()
            effects.append(.recoverOperations)
            return effects

        case .socketLive(let generation):
            if current(generation) { socketAttempt = 0 }
            return []

        case .socketEnded(let generation, let retryAfter):
            guard current(generation), isForeground, !subscribed.isEmpty else { return [] }
            subscribed = []
            socketAttempt += 1
            return [.schedule(.reconnect, after: CloudBackoff.delay(attempt: socketAttempt, retryAfter: retryAfter), generation: generation)]

        case .retryDue(.recovery, let generation):
            guard current(generation), isForeground else { return [] }
            return startRecovery()

        case .retryDue(.reconnect, let generation):
            guard current(generation), isForeground, subscribed.isEmpty else { return [] }
            return resubscribe()

        case .accountChanged(let next):
            guard next != account else { return [] }
            let previous = generation
            reset()
            account = next
            var effects: [CloudSessionEffect] = [.closeSocket, .clearVisibleState(previousGeneration: previous)]
            if let next { effects.append(.openStore(next)) }
            if isForeground { effects += startRecovery() }
            return effects

        case .signedOut:
            guard let account else { return [] }
            let previous = generation
            reset()
            self.account = nil
            return [.closeSocket, .clearVisibleState(previousGeneration: previous), .eraseStore(account)]
        }
    }

    /// The selected room first, then discovery order, at most 50 on the one
    /// multiplexed socket.
    private mutating func resubscribe() -> [CloudSessionEffect] {
        var wanted: [CloudRoomRef] = []
        if let selected, let room = known.first(where: { $0.sameRoom(selected) }) { wanted.append(room) }
        for room in known where wanted.count < CloudLimits.subscriptions && !wanted.contains(where: { $0.sameRoom(room) }) {
            wanted.append(room)
        }
        guard wanted != subscribed else { return [] }
        subscribed = wanted
        if wanted.isEmpty { return [.closeSocket] }
        return [.closeSocket, .openSocket(generation: generation)] + wanted.map { .subscribe($0) }
    }

    private mutating func reset() {
        generation += 1
        isRecovering = false
        known = []
        subscribed = []
        selected = nil
        recoveryAttempt = 0
        socketAttempt = 0
    }

    private func current(_ generation: Int) -> Bool { generation == self.generation && account != nil }

    private mutating func startRecovery() -> [CloudSessionEffect] {
        guard account != nil, isForeground, !isRecovering else { return [] }
        isRecovering = true
        return [.refreshAuth(generation: generation)]
    }
}
