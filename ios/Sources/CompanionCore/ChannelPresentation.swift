import Foundation

public enum ChannelMemberStatus: String, Sendable {
    case working, idle, offline
    public static func resolve(room: Room, bot: Bot, hostLive: Bool) -> Self {
        guard hostLive, bot.remote?.online != false, bot.remote?.availability != "offline" else { return .offline }
        let active = room.activeBotIds ?? room.busyBotId.map { [$0] } ?? []
        return active.contains(bot.id) ? .working : .idle
    }
}

public enum ChannelTextPresentation {
    public static func canCollapse(_ message: Message) -> Bool {
        message.role == .bot && message.kind == .text && message.card == nil && message.tool == nil && message.secret == nil && message.comm == nil
    }
    /// Only the unfinished trailing token is replaced, so prior mentions and prose survive.
    public static func mentionQuery(_ draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@"), at == draft.startIndex || draft[draft.index(before: at)].isWhitespace else { return nil }
        let query = String(draft[draft.index(after: at)...])
        guard !query.contains(where: { $0.isNewline }), !query.hasSuffix(" ") else { return nil }
        return query
    }
    public static func insertingMention(_ name: String, into draft: String) -> String {
        guard mentionQuery(draft) != nil, let at = draft.lastIndex(of: "@") else { return draft }
        return String(draft[..<at]) + "@" + name + " "
    }
}

/// A settings sheet belongs to the pairing generation that opened it. Going
/// away and back to the same host cannot revive its pending operations.
public struct RoomSettingsContext: Equatable, Sendable {
    public let connectionID: String
    public let generation: Int
    public init(connectionID: String, generation: Int) {
        self.connectionID = connectionID; self.generation = generation
    }
    public func permits(_ current: RoomSettingsContext?) -> Bool { self == current }
}
