// Who an @ can tag, how a typed query ranks them, and where a message's
// mentions sit so they can be drawn as tokens.
//
// The rules mirror the desktop composer (src/components/Composer.tsx and
// src/lib/mentions.ts): a room offers @everyone plus its members (no
// @everyone in a DM), a bot's chat offers every other visible local bot,
// and a tag is plain `@name` text — the server routes on the text, so
// nothing here changes what goes over the wire.
import Foundation

/// One name the @ drawer can tag: a bot, or the room's @everyone.
public struct MentionTarget: Identifiable, Hashable, Sendable {
    public static let everyoneID = "__everyone__"

    public let id: String
    /// Exactly what is written after the @.
    public let name: String
    /// The bot's role, searched as well as shown. Empty for @everyone.
    public let subtitle: String
    public let bot: Bot?

    public var isEveryone: Bool { id == Self.everyoneID && bot == nil }

    public init(bot: Bot) {
        self.id = bot.id
        self.name = bot.name
        self.subtitle = bot.title
        self.bot = bot
    }

    private init(id: String, name: String) {
        self.id = id
        self.name = name
        self.subtitle = ""
        self.bot = nil
    }

    /// `@everyone`: every visible member of a room, as the server reads it.
    public static let everyone = MentionTarget(id: everyoneID, name: "everyone")
}

/// A target that matched the query, with what to highlight. Offsets are in
/// characters of `target.name` / `target.subtitle`.
public struct MentionMatch: Identifiable, Hashable, Sendable {
    public let target: MentionTarget
    public let nameHighlights: [Range<Int>]
    public let subtitleHighlight: Range<Int>?
    public var id: String { target.id }

    public init(target: MentionTarget, nameHighlights: [Range<Int>] = [], subtitleHighlight: Range<Int>? = nil) {
        self.target = target
        self.nameHighlights = nameHighlights
        self.subtitleHighlight = subtitleHighlight
    }
}

public enum MentionPool {
    /// Who this chat's composer can tag, in the order the drawer lists them.
    public static func targets(for chat: Chat, bots: [Bot]) -> [MentionTarget] {
        switch chat {
        case let .room(room):
            let byID = Dictionary(bots.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            // Hidden members are not routed by the server's mention parser,
            // so a tag offered for one would land nowhere.
            let members = room.memberIds.compactMap { byID[$0] }.filter { $0.hidden != true && !$0.name.isEmpty }
            guard !members.isEmpty else { return [] }
            return (room.dm == true ? [] : [MentionTarget.everyone]) + members.map(MentionTarget.init(bot:))
        case let .bot(current):
            // A 1:1 tag reaches the other bot through ask_bot on this Mac,
            // which cannot reach a bot relayed from another one.
            return bots.filter { $0.id != current.id && $0.hidden != true && $0.remote == nil && !$0.name.isEmpty }
                .map(MentionTarget.init(bot:))
        }
    }

    /// The names a message's text can mention here, for drawing them as
    /// tokens. Wider than `targets`: a reply may name a bot this phone can
    /// no longer tag, and it should still read as a mention.
    public static func peers(for chat: Chat, bots: [Bot]) -> (peers: [MentionPeer], everyone: Bool) {
        switch chat {
        case let .room(room):
            let byID = Dictionary(bots.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            return (room.memberIds.compactMap { byID[$0] }.map(MentionPeer.init(bot:)), room.dm != true)
        case let .bot(current):
            return (bots.filter { $0.id != current.id }.map(MentionPeer.init(bot:)), false)
        }
    }
}

public enum MentionRanking {
    /// Best first: name prefix, then a word inside the name, then anywhere in
    /// the name, then a word of the role, then the letters of the name in
    /// order (`frg` → Forge).
    /// Stable within each tier, so the room's own order breaks ties.
    public static func rank(_ targets: [MentionTarget], query: String) -> [MentionMatch] {
        let q = Array(query.trimmingCharacters(in: .whitespaces).lowercased())
        guard !q.isEmpty else { return targets.map { MentionMatch(target: $0) } }
        var tiers: [[MentionMatch]] = Array(repeating: [], count: 5)
        for target in targets {
            let name = lowered(target.name)
            if let at = find(q, in: name) {
                let range = at..<(at + q.count)
                let tier = at == 0 ? 0 : isWordStart(name, at) ? 1 : 2
                tiers[tier].append(MentionMatch(target: target, nameHighlights: [range]))
            } else if let at = wordStart(q, in: lowered(target.subtitle)) {
                tiers[3].append(MentionMatch(target: target, subtitleHighlight: at..<(at + q.count)))
            } else if q.count >= 2, let hits = subsequence(q, in: name) {
                tiers[4].append(MentionMatch(target: target, nameHighlights: hits))
            }
        }
        return tiers.flatMap { $0 }
    }

    /// Lowercased per character, so offsets stay those of the original.
    private static func lowered(_ text: String) -> [Character] {
        text.map { Character($0.lowercased().count == 1 ? $0.lowercased() : String($0)) }
    }

    private static func find(_ needle: [Character], in haystack: [Character]) -> Int? {
        guard needle.count <= haystack.count else { return nil }
        for start in 0...(haystack.count - needle.count) where haystack[start..<(start + needle.count)].elementsEqual(needle) {
            return start
        }
        return nil
    }

    /// A role matches from the start of one of its words: "front" finds
    /// "Frontend builder", but a lone "p" does not pull in every role with
    /// a p somewhere in it.
    private static func wordStart(_ needle: [Character], in haystack: [Character]) -> Int? {
        guard needle.count <= haystack.count else { return nil }
        for start in 0...(haystack.count - needle.count)
        where (start == 0 || !(haystack[start - 1].isLetter || haystack[start - 1].isNumber))
            && haystack[start..<(start + needle.count)].elementsEqual(needle) {
            return start
        }
        return nil
    }

    private static func isWordStart(_ name: [Character], _ at: Int) -> Bool {
        guard at > 0 else { return true }
        let before = name[at - 1]
        return before.isWhitespace || before == "-" || before == "_" || before == "." || (before.isNumber != name[at].isNumber)
    }

    /// Every query letter in order; consecutive hits merge into one range.
    private static func subsequence(_ needle: [Character], in haystack: [Character]) -> [Range<Int>]? {
        var ranges: [Range<Int>] = []
        var index = 0
        for character in needle {
            while index < haystack.count, haystack[index] != character { index += 1 }
            guard index < haystack.count else { return nil }
            if let last = ranges.last, last.upperBound == index {
                ranges[ranges.count - 1] = last.lowerBound..<(index + 1)
            } else {
                ranges.append(index..<(index + 1))
            }
            index += 1
        }
        return ranges
    }
}

/// A name a message can mention, and the colour its token wears.
public struct MentionPeer: Hashable, Sendable {
    public let id: String
    public let name: String
    public let color: String?
    public let hidden: Bool

    public init(id: String, name: String, color: String? = nil, hidden: Bool = false) {
        self.id = id; self.name = name; self.color = color; self.hidden = hidden
    }

    public init(bot: Bot) {
        self.init(id: bot.id, name: bot.name, color: bot.color, hidden: bot.hidden == true)
    }
}

/// Where the mentions in a piece of text are, as the desktop finds them for
/// display: a known name right after a standalone @, whole word, longest
/// name first so `@pix2` never reads as `@pix`.
public enum MentionSpans {
    public struct Span: Equatable, Sendable {
        /// Character offsets in the text, the @ included.
        public let range: Range<Int>
        /// The peer named; nil for @everyone.
        public let peer: MentionPeer?
    }

    public static func find(in text: String, peers: [MentionPeer], everyone: Bool = false) -> [Span] {
        guard text.contains("@") else { return [] }
        let candidates = peers.filter { !$0.hidden && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            .sorted { $0.name.count > $1.name.count }
            .map { (peer: $0, name: Array($0.name.lowercased())) }
        let lower = Array(text).map { Character($0.lowercased().count == 1 ? $0.lowercased() : String($0)) }
        let everyoneName = Array("everyone")
        var spans: [Span] = []
        var at = 0
        while at < lower.count {
            defer { at += 1 }
            guard lower[at] == "@", at == 0 || lower[at - 1].isWhitespace else { continue }
            let rest = lower[(at + 1)...]
            func endsWord(_ length: Int) -> Bool {
                let next = rest.dropFirst(length).first
                return next.map { !($0.isLetter || $0.isNumber || $0 == "_") } ?? true
            }
            if everyone, rest.starts(with: everyoneName), endsWord(everyoneName.count) {
                spans.append(Span(range: at..<(at + 1 + everyoneName.count), peer: nil))
                at += everyoneName.count
                continue
            }
            if let hit = candidates.first(where: { rest.starts(with: $0.name) && endsWord($0.name.count) }) {
                spans.append(Span(range: at..<(at + 1 + hit.name.count), peer: hit.peer))
                at += hit.name.count
            }
        }
        return spans
    }
}

extension ChannelMentionPicker {
    /// What goes to the server: each pick as `@name`, ahead of the message,
    /// skipping any name the draft already mentions. Plain text, the same
    /// shape a typed tag has.
    public static func outgoing(_ draft: String, targets: [MentionTarget]) -> String {
        var body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if body == "@" || body.hasSuffix(" @") { body = String(body.dropLast()).trimmingCharacters(in: .whitespacesAndNewlines) }
        let lower = body.lowercased()
        let tags = targets.map { "@" + $0.name }.filter { tag in
            let tag = tag.lowercased()
            return !lower.contains(tag + " ") && !lower.contains(tag + "\n") && !lower.hasSuffix(tag)
        }
        return (tags + (body.isEmpty ? [] : [body])).joined(separator: " ")
    }
}
