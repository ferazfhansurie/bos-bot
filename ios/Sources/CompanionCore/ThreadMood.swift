// How the open thread's face feels when a turn settles: proud when the bot
// finished, sheepish when it hit a wall, curious when it is asking you
// something. Pure, so the rules are tested without a rendered face; the
// header (`ThreadMascot`) only plays what this decides.
import Foundation

public enum ThreadMood: String, CaseIterable, Sendable {
    case proud, sheepish, curious
}

public enum ThreadMoodRules {
    /// A turn longer than this ends with the header's comet burst. Short
    /// turns stay quiet.
    public static let celebrateAfter: TimeInterval = 60

    public static func celebrates(turnSeconds: TimeInterval) -> Bool {
        turnSeconds > celebrateAfter
    }

    /// The mood for the turn that just settled. `messages` is the thread's
    /// visible transcript, oldest first; the turn is everything after the
    /// last line you sent. `feed` is the activity feed's last word on the
    /// thread, when it named one. Nil when nothing came back to react to.
    public static func mood(after messages: [Message], feed: ActivityFeedState? = nil) -> ThreadMood? {
        let start = messages.lastIndex { $0.role == .user }.map { $0 + 1 } ?? messages.startIndex
        let turn = Array(messages[start...])
        // an open question or approval card is the bot asking you
        if turn.contains(where: { $0.card?.isPending == true || $0.secret?.isPending == true }) { return .curious }
        if feed == .failed || feed == .stopped { return .sheepish }
        let replyIndex = turn.lastIndex { $0.kind == .text && !visible($0.text).isEmpty }
        if let replyIndex, visible(turn[replyIndex].text).hasSuffix("?") { return .curious }
        // a failed step after the last reply means the turn ended on it
        if let failed = turn.lastIndex(where: { $0.kind == .activity && $0.tool?.ok == false }),
           failed > (replyIndex ?? -1) { return .sheepish }
        return replyIndex == nil ? nil : .proud
    }

    /// The reply's text without the markdown that can trail a question.
    private static func visible(_ text: String?) -> String {
        (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "*_`)\"'")))
    }
}
