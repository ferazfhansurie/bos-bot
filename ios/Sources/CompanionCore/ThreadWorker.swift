// The 3.0 thread worker's pure half: what the bot standing at the end of the
// thread shows while a turn runs. The view (App/ThreadWorker.swift) only
// draws what this decides.
//
// A port of the desktop: src/components/v3/thread-worker.ts, plus the face,
// line and reaction choices in src/components/v3/ThreadWorker.tsx, so both
// apps pick the same words and faces for the same turn.
import Foundation

/// Whether a send made while the bot works has been read yet.
public enum SteerRead: String, Equatable, Sendable {
    case waiting, read
}

public enum ThreadWorker {
    /// Seconds of silence before the worker says it is still on it.
    public static let slowSeconds: Double = 45
    /// How long the done hop holds before the worker walks home.
    public static let doneSeconds: Double = 1.6
    /// How often the "still on it" clock looks again: coarse, not per frame.
    public static let clockSeconds: Double = 5

    /// Lines, verbatim from the desktop's en locale (v3.worker.*).
    public static let gotItLines = ["got it", "ooh, noted", "heard you. adding that in", "on it", "ok, folding that in"]
    public static let slowLines = ["still on it. big one", "still thinking. this one's chunky", "digging deep, hang tight", "taking its time. worth it"]
    public static let doneLines = ["done", "all yours", "there you go", "that's a wrap"]
    static let doneFaces: [GlyphFaceState] = [.celebrate, .proud, .finished, .happy]

    /// A tool the turn ran (not a bot⇄bot chip, not a failed-turn row).
    public static func isStep(_ message: Message) -> Bool {
        guard message.kind == .activity, let tool = message.tool, message.comm == nil else { return false }
        return !tool.name.hasPrefix("error:")
    }

    /// The running turn's tool steps: everything after the person's last
    /// message that started a turn (a mid-turn send joins the turn, it does
    /// not start a new one).
    public static func turnSteps(_ messages: [Message]) -> [Message] {
        var start = 0
        for index in messages.indices.reversed() where messages[index].role == .user && messages[index].steered != true {
            start = index + 1
            break
        }
        return messages[start...].filter(isStep)
    }

    /// The last few finished steps, oldest first: the faded trail.
    public static func doneTrail(_ steps: [Message], size: Int = 3) -> [Message] {
        Array(steps.filter { $0.tool?.ok != nil }.suffix(size))
    }

    /// Each mid-turn send's state for its bubble. Words the turn took count
    /// as read once anything new lands after them: a tool already running
    /// only updates its own row, so the next new row comes from a model call
    /// that had the words in it. An unknown delivery keeps its own warning
    /// and is left out. A turn that ended took them too.
    public static func steerReads(_ messages: [Message], busy: Bool) -> [String: SteerRead] {
        var reads: [String: SteerRead] = [:]
        var laterNews = !busy
        for message in messages.reversed() {
            guard message.role == .user else {
                laterNews = true
                continue
            }
            guard message.steered == true, message.steerDelivery != "outcome_unknown" else { continue }
            reads[message.id] = laterNews ? .read : .waiting
        }
        return reads
    }

    /// When something last happened in the turn: the newest row or the start.
    public static func lastNewsAt(_ messages: [Message], since: Double?) -> Double? {
        guard let since else { return nil }
        return max(since, messages.last?.at ?? 0)
    }

    /// Silent long enough to say it is still on it. Times are ms, as on the wire.
    public static func isSlow(now: Double, lastNews: Double?, finishing: Bool, needsYou: Bool) -> Bool {
        guard !finishing, !needsYou, let lastNews else { return false }
        return now - lastNews >= slowSeconds * 1000
    }

    /// One of the options, the same one for the same seed: the desktop's
    /// djb2 over UTF-16 code units, wrapping at 32 bits like `| 0`.
    public static func pick<T>(_ options: [T], seed: String) -> T {
        var hash: Int32 = 5381
        for unit in seed.utf16 {
            hash = (hash &<< 5) &+ hash &+ Int32(unit)
        }
        // Math.abs on a 32-bit int is exact in JS, so widen before abs.
        return options[Int(abs(Int64(hash)) % Int64(options.count))]
    }

    /// "1 step" / "4 steps".
    public static func stepCount(_ count: Int) -> String {
        count == 1 ? "1 step" : "\(count) steps"
    }

    /// The face the worker wears; nil keeps the face its tool gives it.
    public static func face(finishing: Bool, stepCount: Int, turnKey: String,
                            reaction: Reaction?, needsYou: Bool, slow: Bool) -> GlyphFaceState? {
        if finishing { return stepCount >= 10 ? .nailedIt : pick(doneFaces, seed: turnKey) }
        if let reaction {
            return reaction.kind == .read ? pick([GlyphFaceState.wink, .happy], seed: reaction.id) : .noticed
        }
        if needsYou { return .waiting }
        if slow { return .determined }
        return nil
    }

    /// The bubble it says, when it has something to say: done, or got it.
    public static func say(finishing: Bool, turnKey: String, reaction: Reaction?) -> String? {
        if finishing { return pick(doneLines, seed: turnKey) }
        if let reaction, reaction.kind == .read { return pick(gotItLines, seed: reaction.id) }
        return nil
    }

    public static func slowLine(turnKey: String) -> String { pick(slowLines, seed: turnKey) }

    /// Seeds which line and face a turn picks; stable for the whole turn.
    public static func turnKey(threadId: String, since: Double?) -> String {
        "\(threadId):\(since.map { formatMillis($0) } ?? "0")"
    }

    /// A ms stamp as JS prints a number: no ".0" on a whole one.
    static func formatMillis(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }

    /// Noticed the moment words arrive mid-turn, then read once taken in.
    public struct Reaction: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable { case noticed, read }
        public var kind: Kind
        public var id: String
        public init(kind: Kind, id: String) { self.kind = kind; self.id = id }

        /// How long the reaction holds before the worker goes back to work.
        public var holdSeconds: Double { kind == .read ? 2.4 : 1.4 }
    }

    /// The worker's memory of the steers it has reacted to. Whatever was
    /// already sent when it appeared is old news; each later change of a
    /// steer's read state is one reaction.
    public struct Reactions: Equatable, Sendable {
        public private(set) var oldNews: String?
        public private(set) var seen: [String: SteerRead] = [:]

        public init(oldNews: String?) { self.oldNews = oldNews }

        /// The newest steer and its state now; a reaction when it is news.
        public mutating func note(id: String?, read: SteerRead?) -> Reaction? {
            guard let id, let read, id != oldNews else { return nil }
            let before = seen[id]
            seen[id] = read
            guard before != read else { return nil }
            return Reaction(kind: read == .read ? .read : .noticed, id: id)
        }
    }
}

public extension LiveActivityLine {
    /// What one tool step did, in words, finished or not (the worker's trail
    /// of done steps). The desktop's `toolLabel`.
    static func stepLabel(for message: Message) -> String {
        guard let tool = message.tool else { return working }
        if let spoken = tool.spoken, !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return sentenceCase(spoken)
        }
        let words = Set(words(in: toolName(tool.name)))
        for fallback in fallbacks where !fallback.words.isDisjoint(with: words) { return fallback.label }
        return working
    }
}
