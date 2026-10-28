// The CarPlay call screen: the pure half.
//
// CarPlay's voice control template shows one state at a time out of at most
// five it was built with, each a short title and an animated image. A call
// has seven things worth showing, so the screen keeps two sets of five and
// rebuilds the template when the next state is not in the one on screen.
// The app target owns the scene, the template and the images; this file
// decides what to show and what the buttons do.
import Foundation

public enum CarVoiceState: String, CaseIterable, Sendable {
    case listening, thinking, talking, sending, saved, reconnecting, offline

    /// Longest first; CarPlay shows the first that fits. Apple asks for
    /// short labels, so none runs past two words.
    public func titles(botName: String) -> [String] {
        let name = botName.lowercased()
        switch self {
        case .listening: return ["listening", "listen"]
        case .thinking: return ["thinking"]
        case .talking: return ["\(name) talking", "talking"]
        case .sending: return ["sending to \(name)", "sending"]
        case .saved: return ["job saved", "saved"]
        case .reconnecting: return ["reconnecting", "reconnect"]
        case .offline: return ["saved offline", "offline"]
        }
    }

    /// The mascot's face for this state.
    public var face: GlyphFaceState {
        switch self {
        case .listening: return .waiting
        case .thinking: return .thinking
        case .talking: return .happy
        case .sending: return .working
        case .saved: return .finished
        case .reconnecting: return .searching
        case .offline: return .asleep
        }
    }

    /// Saved plays once and holds; everything else loops while it lasts.
    public var repeats: Bool { self != .saved }
}

/// The engine as the car screen sees it: the app maps its own call phase
/// and activity onto these.
public enum CarCallPhase: Sendable { case connecting, live, reconnecting, ended, failed }
public enum CarCallActivity: Sendable { case idle, listening, thinking, speaking }

/// A job the call is handing off, from the engine's job events.
public enum CarJobEvent: Equatable, Sendable {
    case sending
    case saved
    case savedOffline
    case failed
}

public struct CarVoiceMoment: Sendable {
    public var phase: CarCallPhase
    public var activity: CarCallActivity
    public var job: CarJobEvent?
    public var jobAt: Date?

    public init(phase: CarCallPhase, activity: CarCallActivity, job: CarJobEvent? = nil, jobAt: Date? = nil) {
        self.phase = phase
        self.activity = activity
        self.job = job
        self.jobAt = jobAt
    }
}

public enum CarVoice {
    /// How long "job saved" / "saved offline" stay up before the call's own
    /// state comes back.
    public static let savedHoldSeconds: Double = 3
    /// A send that never answers stops claiming "sending" after this.
    public static let sendingHoldSeconds: Double = 20

    /// The state to show, or nil once the call is over (the screen closes).
    public static func state(for moment: CarVoiceMoment, now: Date) -> CarVoiceState? {
        switch moment.phase {
        case .ended, .failed: return nil
        default: break
        }
        if let job = moment.job, let at = moment.jobAt {
            let age = now.timeIntervalSince(at)
            switch job {
            case .sending where age < sendingHoldSeconds: return .sending
            case .saved where age < savedHoldSeconds: return .saved
            case .savedOffline where age < savedHoldSeconds || moment.phase == .reconnecting: return .offline
            default: break
            }
        }
        switch moment.phase {
        case .reconnecting: return .reconnecting
        case .connecting: return .thinking
        default: break
        }
        switch moment.activity {
        case .speaking: return .talking
        case .thinking: return .thinking
        case .listening, .idle: return .listening
        }
    }

    /// When the screen should look again without an engine change: the end
    /// of a hold, or nil when nothing is timed.
    public static func nextCheck(for moment: CarVoiceMoment) -> Date? {
        guard let job = moment.job, let at = moment.jobAt else { return nil }
        switch job {
        case .sending: return at.addingTimeInterval(sendingHoldSeconds)
        case .saved, .savedOffline: return at.addingTimeInterval(savedHoldSeconds)
        case .failed: return nil
        }
    }

    // MARK: State sets

    public static let maxStates = 5
    /// What a call shows most: the work going out and landing.
    public static let primarySet: [CarVoiceState] = [.listening, .thinking, .talking, .sending, .saved]
    /// When the line drops.
    public static let fallbackSet: [CarVoiceState] = [.listening, .thinking, .talking, .reconnecting, .offline]

    /// The set the template needs for `wanted`: the one on screen when it
    /// already holds it (no rebuild), else the set that does.
    public static func set(for wanted: CarVoiceState, current: [CarVoiceState]?) -> [CarVoiceState] {
        if let current, current.contains(wanted) { return current }
        return primarySet.contains(wanted) ? primarySet : fallbackSet
    }

    // MARK: Who you're talking to

    /// The order the switch button walks.
    public static let rotation = ["bos", "oracle", "cash"]

    /// The bot after `current` in the rotation, skipping any missing or
    /// hidden. The current bot is placed by id, else by name (a bos on
    /// another paired computer is still bos). A bot outside the rotation
    /// switches to its first member. Nil when there is no one else.
    public static func nextBot(after current: Bot, in bots: [Bot]) -> Bot? {
        let lineup = rotation.compactMap { name in
            bots.first { $0.hidden != true && $0.name.lowercased() == name }
        }
        guard !lineup.isEmpty else { return nil }
        let name = current.name.lowercased()
        guard let index = lineup.firstIndex(where: { $0.id == current.id }) ?? lineup.firstIndex(where: { $0.name.lowercased() == name })
        else { return lineup.first }
        let next = lineup[(index + 1) % lineup.count]
        return next.id == current.id || next.name.lowercased() == name ? nil : next
    }

    /// The bot a fresh car call rings: bos, else the first in the rotation,
    /// else the first visible bot.
    public static func firstBot(in bots: [Bot]) -> Bot? {
        for name in rotation {
            if let bot = bots.first(where: { $0.hidden != true && $0.name.lowercased() == name }) { return bot }
        }
        return bots.first { $0.hidden != true }
    }

    // MARK: Anything need me?

    /// Instructions for the "need me?" button: the voice reads out what is
    /// waiting on the caller, from the same attention list the roster shows.
    /// Approvals and questions first, then unread replies; work in progress
    /// is a count, not a list.
    public static func needMeInstructions(_ threads: [AttentionThread], limit: Int = 4) -> String {
        let waiting = threads.filter { $0.task.activity == "waiting-on-you" }
        let unread = threads.filter { $0.task.activity != "waiting-on-you" && $0.task.unread == true }
        let working = threads.filter { $0.task.activity != "waiting-on-you" && $0.task.unread != true }.count
        let lead = "The caller tapped \"anything need me?\" on the car screen. Answer in at most three short spoken sentences; do not call send_task for this."
        if waiting.isEmpty && unread.isEmpty {
            let busy = working > 0 ? " \(working) \(working == 1 ? "job is" : "jobs are") still running." : ""
            return lead + " Tell them nothing is waiting on them right now.\(busy)"
        }
        // titles are the user's thread titles, not ours: one line, no
        // quotes, short, so a title can't pose as part of the instructions
        func clean(_ text: String, _ cap: Int) -> String {
            let flat = text.components(separatedBy: .newlines).joined(separator: " ")
                .replacingOccurrences(of: "\"", with: "").trimmingCharacters(in: .whitespaces)
            return flat.count > cap ? String(flat.prefix(cap)).trimmingCharacters(in: .whitespaces) + "…" : flat
        }
        func describe(_ thread: AttentionThread) -> String {
            let title = clean(thread.task.title, 60)
            let bot = clean(thread.botName, 24)
            return title.isEmpty ? bot : "\(bot): \(title)"
        }
        var parts: [String] = []
        if !waiting.isEmpty {
            parts.append("Waiting on their answer: " + waiting.prefix(limit).map(describe).joined(separator: "; ") + ".")
        }
        let room = max(0, limit - waiting.count)
        if !unread.isEmpty, room > 0 {
            parts.append("Unread replies: " + unread.prefix(room).map(describe).joined(separator: "; ") + ".")
        }
        let shown = min(waiting.count, limit) + min(unread.count, room)
        let rest = waiting.count + unread.count - shown
        if rest > 0 { parts.append("And \(rest) more.") }
        if working > 0 { parts.append("\(working) \(working == 1 ? "job is" : "jobs are") still running.") }
        return lead + " Read this out plainly, waiting items first: " + parts.joined(separator: " ")
    }
}
