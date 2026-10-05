// What every bot is doing right now, per (bot, thread), from the server's
// activity feed.
//
// The rest of the phone infers a turn from what a thread happens to carry —
// a task's activity string, a busy flag, the last message's tool — which is
// only as fresh as the last bot frame, and only for threads the phone has
// loaded. The feed is the server saying it outright, for every thread at
// once, so a bot working in one chat animates in the list while the person
// reads another.
//
// Two halves arrive separately: a snapshot (`activityFeedSnapshotPath`,
// `{ items }`) on every connect, and `{ kind: "activity", items }` frames on
// the existing event stream (`activityFeedEventName`), each a full
// replacement, deletions included. The contract is the server's
// `shared/activity.ts`. Decoding stays tolerant so a newer server cannot
// fail a frame, and a server without the route leaves the feed empty — an
// empty feed means every view falls back to exactly what it did before.
import Foundation

// MARK: - Wire names

/// Where the activity snapshot lives. A 404 or 405 here (an older server)
/// reads as "no feed" and changes nothing.
public let activityFeedSnapshotPath = "/api/activity"

/// The SSE frame `kind` that carries a pushed activity replacement.
public let activityFeedEventName = "activity"

// MARK: - State

/// A bot's turn in one thread, as the feed names it. Anything this build does
/// not recognise is `.idle`: a newer server's state must never animate a bot
/// the phone cannot explain, nor fail the frame that carried it.
public enum ActivityFeedState: String, CaseIterable, Sendable {
    case idle, thinking, tool, typing, waiting, failed, stopped

    public init(wire: String?) {
        self = wire.flatMap { Self(rawValue: $0.lowercased()) } ?? .idle
    }

    /// A turn is running: the model is thinking, a tool is out, or the
    /// answer is streaming.
    public var isBusy: Bool {
        switch self {
        case .thinking, .tool, .typing: return true
        default: return false
        }
    }

    /// Motion carries meaning: a running turn, or one blocked on someone.
    /// Failed and stopped are settled — they hold still, they do not loop.
    public var animates: Bool { isBusy || self == .waiting }

    /// Which thread a per-bot row shows. The desktop's `resolveGesture`
    /// order: a wait on the person wins, then a tool in flight, then
    /// thought. The settled states rank below anything live, and a failure
    /// above a quiet stop, so the more notable rest is the one kept.
    var rank: Int {
        switch self {
        case .waiting: return 6
        case .tool: return 5
        case .thinking: return 4
        case .typing: return 3
        case .failed: return 2
        case .stopped: return 1
        case .idle: return 0
        }
    }

    /// The desktop's `turnGesture`, applied to the feed: waiting is the wait
    /// gesture; a tool in flight works, or peeks when it is a search tool;
    /// thinking and a streaming answer both read as thought (the desktop's
    /// presence never switches gesture when the answer starts). Settled
    /// states are idle — the still body, never a loop.
    public func mascotActivity(toolName: String? = nil) -> MascotActivity {
        switch self {
        case .waiting: return .waiting
        case .tool:
            return MascotActivityChoreography.searchTools.contains(toolName?.lowercased() ?? "") ? .searching : .working
        case .thinking, .typing: return .thinking
        case .idle, .failed, .stopped: return .idle
        }
    }
}

// MARK: - Entry

/// One (bot, thread) line of the feed.
///
/// Only `botId` and `threadId` are required; a list decodes entry by entry,
/// so one bad line drops alone. `since` is epoch milliseconds whichever way
/// it arrived — a number (ms, or seconds from a server that sends them), a
/// numeric string, or ISO 8601 — and 0 when absent or unreadable, which any
/// dated entry then supersedes.
public struct ActivityFeedEntry: Decodable, Equatable, Sendable {
    public var botId: String
    public var threadId: String
    /// The group or shared room the thread belongs to, when it does.
    public var roomId: String?
    public var state: ActivityFeedState
    /// Epoch milliseconds.
    public var since: Double
    /// The tool in flight, when the server names it. Not in the stated
    /// shape; read if present so a search can peek like the desktop.
    public var toolName: String?

    public init(botId: String, threadId: String, roomId: String? = nil,
                state: ActivityFeedState, since: Double, toolName: String? = nil) {
        self.botId = botId
        self.threadId = threadId
        self.roomId = roomId
        self.state = state
        self.since = since
        self.toolName = toolName
    }

    public var mascotActivity: MascotActivity { state.mascotActivity(toolName: toolName) }

    private enum CodingKeys: String, CodingKey { case botId, threadId, roomId, state, since, toolName, tool }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        botId = try container.decode(String.self, forKey: .botId)
        threadId = try container.decode(String.self, forKey: .threadId)
        roomId = (try? container.decodeIfPresent(String.self, forKey: .roomId)) ?? nil
        state = ActivityFeedState(wire: (try? container.decodeIfPresent(String.self, forKey: .state)) ?? nil)
        since = Self.epochMilliseconds(container, .since)
        toolName = ((try? container.decodeIfPresent(String.self, forKey: .toolName)) ?? nil)
            ?? ((try? container.decodeIfPresent(String.self, forKey: .tool)) ?? nil)
    }

    private static func epochMilliseconds(_ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Double {
        if let number = try? container.decode(Double.self, forKey: key) { return milliseconds(number) }
        guard let text = try? container.decode(String.self, forKey: key) else { return 0 }
        if let number = Double(text) { return milliseconds(number) }
        for options: ISO8601DateFormatter.Options in [[.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime]] {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            if let date = formatter.date(from: text) { return date.timeIntervalSince1970 * 1000 }
        }
        return 0
    }

    /// Below 1e11 cannot be milliseconds of any real turn (that is 1973),
    /// so it is seconds from a server that sends them.
    private static func milliseconds(_ value: Double) -> Double {
        value > 0 && value < 1e11 ? value * 1000 : max(0, value)
    }
}

/// The snapshot body: `{ items }`, or a bare list or one under
/// `entries`/`activity` from an earlier draft.
/// Unreadable lines drop one by one; an unreadable body is an empty feed.
public struct ActivityFeedSnapshot: Decodable, Sendable {
    public var entries: [ActivityFeedEntry]

    private enum CodingKeys: String, CodingKey { case items, entries, activity }

    public init(entries: [ActivityFeedEntry]) { self.entries = entries }

    public init(from decoder: Decoder) throws {
        if let list = try? decoder.singleValueContainer().decode([Lossy<ActivityFeedEntry>].self) {
            entries = list.compactMap(\.value)
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let list = (try? container.decode([Lossy<ActivityFeedEntry>].self, forKey: .items))
            ?? (try? container.decode([Lossy<ActivityFeedEntry>].self, forKey: .entries))
            ?? (try? container.decode([Lossy<ActivityFeedEntry>].self, forKey: .activity))
            ?? []
        entries = list.compactMap(\.value)
    }

    /// What an activity frame carries. The server sends `items`, a full
    /// replacement; a list under `entries`/`activity` is read the same way.
    /// A single object under `entry`/`activity`, or the fields flat beside
    /// `kind`, is one update to merge. A non-empty list none of whose lines
    /// read is a shape this build does not know: an empty update, never an
    /// empty replacement that would wipe the feed on a glitch.
    static func frameEntries(from decoder: Decoder) -> (entries: [ActivityFeedEntry], replace: Bool) {
        enum Keys: String, CodingKey { case items, entries, activity, entry }
        if let container = try? decoder.container(keyedBy: Keys.self) {
            for key in [Keys.items, .entries, .activity] {
                if let list = try? container.decode([Lossy<ActivityFeedEntry>].self, forKey: key) {
                    let entries = list.compactMap(\.value)
                    return entries.isEmpty && !list.isEmpty ? ([], false) : (entries, true)
                }
            }
            for key in [Keys.entry, .activity] {
                if let single = try? container.decode(ActivityFeedEntry.self, forKey: key) { return ([single], false) }
            }
        }
        return ((try? ActivityFeedEntry(from: decoder)).map { [$0] } ?? [], false)
    }
}

// MARK: - Feed

/// The feed as the phone holds it: the newest entry per (bot, thread).
///
/// A plain value with pure folds, like `CompanionState` around it. Pushes
/// older than what is stored are ignored, so a replayed or reordered frame
/// cannot rewind a bot. Nothing here forgets a thread on its own: an idle
/// entry is information (it is what stops an older busy push winning).
public struct ActivityFeed: Equatable, Sendable {
    private struct Slot: Equatable, Sendable {
        var entry: ActivityFeedEntry
        /// Local order of arrival, for `apply(snapshot:preservingUpdatesAfter:)`.
        var revision: Int
    }

    /// botId → threadId → slot, so a per-bot row reads only its own threads.
    private var slots: [String: [String: Slot]] = [:]
    /// Bumped by every change. Take it before fetching a snapshot and pass
    /// it back, and pushes that arrived during the fetch survive the swap.
    public private(set) var revision = 0

    public init() {}

    public var isEmpty: Bool { slots.isEmpty }

    public var entries: [ActivityFeedEntry] {
        slots.values.flatMap { $0.values.map(\.entry) }
    }

    /// Replace the feed with the server's snapshot. A thread the snapshot
    /// omits is idle — except one pushed after `mark` (a revision read
    /// before the fetch began), which is newer than the snapshot can know.
    /// Where both name a thread, the later `since` wins.
    public mutating func apply(snapshot: [ActivityFeedEntry], preservingUpdatesAfter mark: Int? = nil) {
        revision += 1
        var next: [String: [String: Slot]] = [:]
        for entry in snapshot {
            if let held = next[entry.botId]?[entry.threadId], held.entry.since > entry.since { continue }
            next[entry.botId, default: [:]][entry.threadId] = Slot(entry: entry, revision: revision)
        }
        for (botId, threads) in slots {
            for (threadId, slot) in threads {
                if let fresh = next[botId]?[threadId] {
                    if slot.entry.since > fresh.entry.since { next[botId]![threadId] = slot }
                } else if let mark, slot.revision > mark {
                    next[botId, default: [:]][threadId] = slot
                }
            }
        }
        slots = next
    }

    /// Fold one pushed entry. Returns false — and changes nothing — when it
    /// is older than the entry already held for its (bot, thread).
    @discardableResult
    public mutating func apply(update entry: ActivityFeedEntry) -> Bool {
        if let held = slots[entry.botId]?[entry.threadId], entry.since < held.entry.since { return false }
        revision += 1
        slots[entry.botId, default: [:]][entry.threadId] = Slot(entry: entry, revision: revision)
        return true
    }

    /// A deleted bot's threads can never be mentioned again.
    public mutating func remove(bot botId: String) {
        guard slots.removeValue(forKey: botId) != nil else { return }
        revision += 1
    }

    public mutating func removeAll() {
        guard !slots.isEmpty else { return }
        slots.removeAll()
        revision += 1
    }

    // MARK: Reading

    /// Exactly this (bot, thread); nil when the feed has never named it.
    public func entry(bot botId: String, thread threadId: String) -> ActivityFeedEntry? {
        slots[botId]?[threadId]?.entry
    }

    public func state(bot botId: String, thread threadId: String) -> ActivityFeedState? {
        entry(bot: botId, thread: threadId)?.state
    }

    /// For rows that stand for a whole bot: its busiest thread, by the
    /// desktop's precedence, the most recent among equals. Nil when the
    /// feed knows nothing of this bot, so the caller keeps its fallback.
    public func busiest(bot botId: String) -> ActivityFeedEntry? {
        Self.busiest(slots[botId]?.values.lazy.map(\.entry))
    }

    /// Any bot in exactly this thread — one thread row of a group.
    public func busiest(thread threadId: String) -> ActivityFeedEntry? {
        Self.busiest(slots.values.lazy.compactMap { $0[threadId]?.entry })
    }

    /// For a row that stands for a whole group: the busiest member working
    /// anywhere in it, matched by room id or by the group's current thread.
    public func busiest(room roomId: String, thread threadId: String? = nil) -> ActivityFeedEntry? {
        Self.busiest(slots.values.lazy.flatMap(\.values).map(\.entry).filter {
            $0.roomId == roomId || (threadId != nil && $0.threadId == threadId)
        })
    }

    /// One bot inside one room — a shared room's member strip.
    public func busiest(bot botId: String, room roomId: String) -> ActivityFeedEntry? {
        Self.busiest(slots[botId]?.values.lazy.map(\.entry).filter { $0.roomId == roomId })
    }

    private static func busiest<S: Sequence>(_ entries: S?) -> ActivityFeedEntry? where S.Element == ActivityFeedEntry {
        entries?.max { a, b in
            a.state.rank == b.state.rank ? a.since < b.since : a.state.rank < b.state.rank
        }
    }
}
