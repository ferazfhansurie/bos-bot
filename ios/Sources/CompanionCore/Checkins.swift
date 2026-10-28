import Foundation

/// 3.0 check-ins (shared/checkins.ts): what the chief's three daily looks put
/// in front of the person, read from GET /api/checkins and answered with one
/// tap each. Go ahead starts a fresh thread on the owning bot on the computer;
/// the phone never runs anything itself.
public struct CheckinsSnapshot: Decodable, Sendable, Equatable {
    public var items: [CheckinItem]
    public var counts: CheckinCounts
    public var setUp: Bool
    public var chiefBotId: String?
    public var slots: [String]

    public init(items: [CheckinItem] = [], counts: CheckinCounts = .init(), setUp: Bool = false, chiefBotId: String? = nil, slots: [String] = []) {
        self.items = items
        self.counts = counts
        self.setUp = setUp
        self.chiefBotId = chiefBotId
        self.slots = slots
    }

    private enum CodingKeys: String, CodingKey { case items, counts, setUp, chiefBotId, slots }

    /// One unreadable item must not blank the list: it is dropped and the
    /// rest still render.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        var items: [CheckinItem] = []
        if var list = try? container.nestedUnkeyedContainer(forKey: .items) {
            while !list.isAtEnd {
                if let item = try? list.decode(CheckinItem.self) {
                    items.append(item)
                } else {
                    _ = try? list.decode(Discarded.self)
                }
            }
        }
        self.items = items
        counts = (try? container.decode(CheckinCounts.self, forKey: .counts)) ?? .init()
        setUp = (try? container.decode(Bool.self, forKey: .setUp)) ?? false
        chiefBotId = try? container.decode(String.self, forKey: .chiefBotId)
        slots = (try? container.decode([String].self, forKey: .slots)) ?? []
    }

    private struct Discarded: Decodable {}

    /// Share of today already cleared, for the ring (0...1).
    public var clearedShare: Double {
        let cleared = counts.done + counts.no
        let total = items.count + cleared
        return total == 0 ? 0 : Double(cleared) / Double(total)
    }
}

public struct CheckinCounts: Decodable, Sendable, Equatable {
    public var later: Int
    public var done: Int
    public var no: Int

    public init(later: Int = 0, done: Int = 0, no: Int = 0) {
        self.later = later
        self.done = done
        self.no = no
    }
}

public struct CheckinSource: Decodable, Sendable, Equatable, Hashable {
    public var type: String
    public var ref: String
    public var url: String?
    public var label: String?
    public var botId: String?
}

public struct CheckinItem: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var botId: String
    /// did · broke · decide · tonight; an unknown kind reads as decide.
    public var kind: String
    public var title: String
    public var why: String
    public var sources: [CheckinSource]
    public var draft: String?
    public var plan: String?

    private enum CodingKeys: String, CodingKey { case id, botId, kind, title, why, sources, draft, plan }

    public init(id: String, botId: String, kind: String, title: String, why: String, sources: [CheckinSource] = [], draft: String? = nil, plan: String? = nil) {
        self.id = id
        self.botId = botId
        self.kind = kind
        self.title = title
        self.why = why
        self.sources = sources
        self.draft = draft
        self.plan = plan
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        botId = try container.decode(String.self, forKey: .botId)
        kind = (try? container.decode(String.self, forKey: .kind)) ?? "decide"
        title = try container.decode(String.self, forKey: .title)
        why = (try? container.decode(String.self, forKey: .why)) ?? ""
        sources = (try? container.decode([CheckinSource].self, forKey: .sources)) ?? []
        draft = try? container.decode(String.self, forKey: .draft)
        plan = try? container.decode(String.self, forKey: .plan)
    }

    /// The bot that owns the work: its first thread source's bot (the chief
    /// often proposes for a teammate), else the proposer. Approve runs there.
    public var ownerBotId: String {
        sources.first(where: { $0.type == "thread" && $0.botId != nil })?.botId ?? botId
    }

    /// The buttons this item offers, primary first, as (action, label).
    /// A "did" report only needs an ack.
    public var actions: [(action: String, label: String)] {
        if kind == "did" { return [("done", "Got it"), ("no", "No")] }
        let primary = kind == "broke" ? "Fix it" : draft != nil ? "Send" : "Go ahead"
        return [("approve", primary), ("done", "Done"), ("not-now", "Not now"), ("no", "No")]
    }
}

/// POST /api/checkins/:id/:action answers with the item and the fresh list.
struct CheckinActionResponse: Decodable {
    var snapshot: CheckinsSnapshot

    init(from decoder: Decoder) throws {
        snapshot = try CheckinsSnapshot(from: decoder)
    }
}
