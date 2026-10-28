// What the system surfaces outside the app know about your bots: the home
// and lock screen widgets, and the notification extensions.
//
// The app writes one snapshot into the App Group whenever its bots change;
// every extension only reads it. Plain Foundation and no CompanionCore, so
// the notification service extension can compile it too.
import Foundation

/// One bot, as a widget or a notification draws it.
struct BotGlance: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    /// A MausPalette colour name or "#RRGGBB".
    var color: String
    var body: String?
    /// nil is the glyph face.
    var eyes: String?
    /// "needsYou" · "working" · "done" · "idle"
    var status: String
    /// The face for what it is doing right now (`MausState` raw).
    var face: String
    /// What it is doing, in plain words, or the reply's first line once done.
    var line: String
    var threadId: String?
    var threadTitle: String?
    /// When the current job began (or, once done, when it finished).
    var since: Date?
    /// The plan's step in progress and its size, when it has one.
    var stepIndex: Int? = nil
    var stepCount: Int? = nil

    /// "3/5" while working from a plan.
    var fraction: String? {
        guard isWorking, let stepCount, stepCount >= 2, let stepIndex, stepIndex >= 1 else { return nil }
        return "\(min(stepIndex, stepCount))/\(stepCount)"
    }

    var needsYou: Bool { status == "needsYou" }
    var isWorking: Bool { status == "working" }
    var isDone: Bool { status == "done" }
    var isBusy: Bool { needsYou || isWorking }

    /// The deep link that opens this bot's thread.
    var link: URL? {
        var parts = URLComponents()
        parts.scheme = "bosbot"
        parts.host = "thread"
        parts.queryItems = [URLQueryItem(name: "bot", value: id), URLQueryItem(name: "thread", value: threadId ?? "")]
        return threadId?.isEmpty == false ? parts.url : URL(string: "bosbot://")
    }
}

struct BotRosterSnapshot: Codable, Hashable, Sendable {
    var bots: [BotGlance]
    var updatedAt: Date

    /// Most urgent first: needs you, then working, then just finished, then
    /// everyone else in the person's own order.
    var ranked: [BotGlance] {
        let rank = ["needsYou": 0, "working": 1, "done": 2]
        return bots.enumerated().sorted { a, b in
            let ra = rank[a.element.status] ?? 3, rb = rank[b.element.status] ?? 3
            return ra == rb ? a.offset < b.offset : ra < rb
        }.map(\.element)
    }

    /// A busy status the app could not refresh for this long is a guess, not
    /// the truth: the app was closed mid-turn. Show those bots at rest.
    func settled(now: Date = Date(), after limit: TimeInterval = 45 * 60) -> BotRosterSnapshot {
        guard now.timeIntervalSince(updatedAt) > limit else { return self }
        var copy = self
        copy.bots = bots.map { bot in
            guard bot.isBusy || bot.isDone else { return bot }
            var calm = bot
            calm.status = "idle"
            calm.face = "idle"
            calm.line = ""
            return calm
        }
        return copy
    }
}

enum BotRosterStore {
    static let group = "group.com.aihlete.aios.shared"
    private static let key = "glance.roster.v1"

    static func load() -> BotRosterSnapshot? {
        guard let data = UserDefaults(suiteName: group)?.data(forKey: key) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try? decoder.decode(BotRosterSnapshot.self, from: data)
    }

    /// True when anything a surface draws changed.
    @discardableResult
    static func save(_ snapshot: BotRosterSnapshot) -> Bool {
        if let old = load(), old.bots == snapshot.bots { return false }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(snapshot) else { return false }
        UserDefaults(suiteName: group)?.set(data, forKey: key)
        return true
    }

    static func bot(_ id: String) -> BotGlance? {
        load()?.bots.first { $0.id == id }
    }
}

/// The face a notification wears: the mood of what the bot said.
enum NotificationMood {
    /// Every mood a notification can show, as `GlyphFaceState` raw values.
    static let all = ["happy", "finished", "waiting", "thinking", "failed", "idle"]

    /// `kind` is the server's notification kind (approval, question, done,
    /// turn-failed, …) or the push's `type` (voice_ring, voice_work_done).
    static func glyph(kind: String?, title: String, body: String) -> String {
        let text = (title + " " + body).lowercased()
        switch kind {
        case "approval", "question", "takeover": return "waiting"
        case "routine-failed", "turn-failed", "incident": return "failed"
        case "routine-deferred": return "thinking"
        case "voice_ring": return "happy"
        default: break
        }
        // hit a wall: sheepish, never alarmed
        let walls = ["couldn't", "could not", "can't", "cannot", "failed", "blocked", "stuck", "error", "didn't work", "not able"]
        if walls.contains(where: text.contains) { return "failed" }
        if body.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("?") { return "waiting" }
        let wins = ["done", "shipped", "installed", "fixed", "finished", "ready", "landed", "merged", "booked"]
        if kind == "done" || kind == "voice_work_done" || wins.contains(where: text.contains) { return "finished" }
        return "happy"
    }

    /// One short word for the mood, shown next to the face.
    static func word(_ glyph: String) -> String {
        switch glyph {
        case "waiting": return "needs you"
        case "failed": return "hit a wall"
        case "finished": return "done"
        case "thinking": return "thinking"
        case "idle": return "here"
        default: return "says hi"
        }
    }
}

/// Notification categories the content extension draws a live face for.
/// The app's own update/approval categories keep their identifiers; pushes
/// that arrive without one get `bot`.
enum BotNotificationCategory {
    static let bot = "BOS_BOT"
    static let update = "OPENMAUS_UPDATE"
    static let approval = "OPENMAUS_APPROVAL"
    static let voiceDone = "VOICE_WORK_DONE"
    /// bos bot 3.0: a tool approval answerable from the banner itself.
    static let answerPermission = "BOS_ANSWER_PERMISSION"
    static let allowAction = "BOS_ALLOW"
    static let denyAction = "BOS_DENY"
}

enum BotGlanceWidgetKind {
    /// The home and lock screen widgets that show every bot's face.
    static let bots = "com.aihlete.aios.bots"
}
