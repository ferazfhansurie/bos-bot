// The car's view of a bot's Live Activity: what CarPlay (and the watch's
// Smart Stack) draws from the activity's small family. One glance, at
// arm's length, so every line is a word or two and never wraps.
//
// The widget only draws what this decides; the phone's island and lock
// screen keep their own richer views.
import Foundation

/// What a live voice call is doing, as the car and the island say it. The
/// voice engine reports it through `LiveActivityCoordinator.updateCall`.
public enum LiveCallPhase: Equatable, Sendable {
    case connecting
    case listening
    case thinking
    case speaking
    /// A job is on its way to this bot's chat.
    case sending(to: String)
    /// The bot took the job; it is in the thread now.
    case jobSaved
    case reconnecting

    public var word: String {
        switch self {
        case .connecting: return "calling"
        case .listening: return "listening"
        case .thinking: return "thinking"
        case .speaking: return "talking"
        case let .sending(bot):
            let name = bot.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? "sending the job" : "sending to \(name)"
        case .jobSaved: return "job saved"
        case .reconnecting: return "reconnecting"
        }
    }
}

public enum CarGlance {
    /// "3 working · 1 needs you", or nil when one bot (or none) is busy:
    /// a lone bot's own card already says it.
    public static func summary(working: Int, needsYou: Int) -> String? {
        guard working + needsYou > 1 else { return nil }
        var parts: [String] = []
        if working > 0 { parts.append("\(working) working") }
        if needsYou > 0 { parts.append("\(needsYou) \(needsYou == 1 ? "needs" : "need") you") }
        return parts.joined(separator: " · ")
    }

    /// The job, in five words or fewer: "ios: live activity polish for
    /// carplay" → "ios: live activity polish for…".
    public static func shortTitle(_ title: String?, maxWords: Int = 5) -> String? {
        guard let title else { return nil }
        let words = title.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return nil }
        guard words.count > maxWords else { return words.joined(separator: " ") }
        return words.prefix(maxWords).joined(separator: " ") + "…"
    }

    /// The one state word: the call's phase while a call is live, else
    /// working / needs you / done.
    public static func stateWord(_ content: BotActivityContent) -> String {
        if let call = content.call?.trimmingCharacters(in: .whitespacesAndNewlines), !call.isEmpty { return call }
        if content.isDone { return "done" }
        if content.needsYou { return "needs you" }
        return "working"
    }

    /// The one line under the state: the result when done, the ask when it
    /// needs you, else the job's title (or what it is doing, untitled).
    public static func detail(_ content: BotActivityContent) -> String? {
        let line = content.line.trimmingCharacters(in: .whitespacesAndNewlines)
        if content.call == nil, content.isDone || content.needsYou, !line.isEmpty { return line }
        // a call with no job running has nothing more to say than its word
        return shortTitle(content.threadTitle) ?? (line.isEmpty || line == stateWord(content) ? nil : line)
    }

    /// The clock the car shows: the call's while one is live, else the job's.
    public static func since(_ content: BotActivityContent) -> Date {
        content.call != nil ? (content.callSince ?? content.since) : content.clockStart
    }

    /// Which of several bots' activities the system should put forward:
    /// a call, then a bot waiting on you, then working, then done.
    public static func relevance(_ content: BotActivityContent) -> Double {
        if content.call != nil { return 100 }
        if content.needsYou { return 80 }
        if content.isWorking { return 50 }
        return 10
    }
}
