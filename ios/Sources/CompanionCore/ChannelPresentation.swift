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

/// The room header's stack: working bots first so the busy ones are always
/// visible, a few faces, and a count for the rest.
public struct ChannelRoster: Sendable {
    public let shown: [Bot]
    public let overflow: Int
    public let working: Set<String>

    public init(room: Room, members: [Bot], hostLive: Bool, limit: Int = 4) {
        let status = Dictionary(members.map { ($0.id, ChannelMemberStatus.resolve(room: room, bot: $0, hostLive: hostLive)) }, uniquingKeysWith: { a, _ in a })
        let working = Set(members.filter { status[$0.id] == .working }.map(\.id))
        let ordered = members.filter { working.contains($0.id) } + members.filter { !working.contains($0.id) }
        self.shown = Array(ordered.prefix(limit))
        self.overflow = max(0, ordered.count - limit)
        self.working = working
    }
}

/// The @ drawer. Picks are held beside the draft and written back as plain
/// `@name` text on send, so the server routes them exactly as typed ones.
public enum ChannelMentionPicker {
    /// Name prefix first, then anywhere in the name or role.
    public static func matching(_ bots: [Bot], query: String) -> [Bot] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return bots }
        let prefix = bots.filter { $0.name.lowercased().hasPrefix(q.lowercased()) }
        let rest = bots.filter { bot in
            !prefix.contains { $0.id == bot.id }
                && (bot.name.localizedCaseInsensitiveContains(q) || bot.title.localizedCaseInsensitiveContains(q))
        }
        return prefix + rest
    }

    /// The draft without the unfinished `@query` the drawer is filtering on.
    public static func removingQuery(from draft: String) -> String {
        guard ChannelTextPresentation.mentionQuery(draft) != nil, let at = draft.lastIndex(of: "@") else { return draft }
        return String(draft[..<at])
    }

    /// What goes to the server: each pick as `@name`, ahead of the message,
    /// skipping any name the draft already mentions.
    public static func outgoing(_ draft: String, picks: [Bot]) -> String {
        var body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // a bare @ left open from the drawer is not part of the message
        if body == "@" || body.hasSuffix(" @") { body = String(body.dropLast()).trimmingCharacters(in: .whitespacesAndNewlines) }
        let lower = body.lowercased()
        let tags = picks.map { "@" + $0.name }.filter { tag in
            !lower.contains(tag.lowercased() + " ") && !lower.hasSuffix(tag.lowercased())
        }
        return (tags + (body.isEmpty ? [] : [body])).joined(separator: " ")
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
