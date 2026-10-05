import Foundation

public enum NotificationRequestState: Equatable, Sendable {
    case notRequired, pending(String), settled, unavailable
}

extension NotificationTarget {
    public func requestState(in messages: [Message]) -> NotificationRequestState {
        guard isBlocking else { return .notRequired }
        guard let requestId,
              let message = messages.first(where: { $0.card?.requestId == requestId && (messageId == nil || $0.id == messageId) }) else { return .unavailable }
        return message.card?.isPending == true ? .pending(message.id) : .settled
    }
}

public enum NotificationPresentation: Equatable, Sendable {
    case quiet, list, alert

    public static func resolve(enabled: Bool, visible: Bool, blocking: Bool) -> Self {
        guard enabled else { return .quiet }
        if visible { return blocking ? .list : .quiet }
        return .alert
    }

    /// Reconnect can fold many missed updates at once. Keep one notice per
    /// conversation, preferring a blocking request over a completion.
    public static func coalescedIndices(_ notices: [(String, Bool)]) -> [Int] {
        var selected: [String: Int] = [:]
        for (index, notice) in notices.enumerated() {
            if let previous = selected[notice.0], notices[previous].1 && !notice.1 { continue }
            selected[notice.0] = index
        }
        return selected.values.sorted()
    }
}

public struct NotificationReplayLedger: Sendable {
    public private(set) var ids: [String]
    private let limit: Int
    public init(ids: [String] = [], limit: Int = 512) {
        self.limit = max(1, limit)
        self.ids = Array(ids.suffix(max(1, limit)))
    }
    public mutating func insert(_ id: String) -> Bool {
        guard !ids.contains(id) else { return false }
        ids.append(id)
        if ids.count > limit { ids.removeFirst(ids.count - limit) }
        return true
    }
}
