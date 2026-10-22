import Foundation

/// The same thread predicates drive every home in the phone's combined inbox.
public enum ThreadListPolicy {
    public static func matches(_ task: BotTask, filter: String, waiting: Set<String>, queued: Set<String> = []) -> Bool {
        switch filter {
        case "waiting": return waiting.contains(task.threadId) || task.activity == "waiting-on-you"
        case "running": return !waiting.contains(task.threadId) && task.activity != "waiting-on-you" && task.isWorking
        case "unread": return task.unread == true
        default: return true
        }
    }

    public static func ordered(_ tasks: [BotTask], pins: [String]) -> [BotTask] {
        let ranks = Dictionary(pins.enumerated().map { ($1, $0) }, uniquingKeysWith: min)
        return tasks.sorted {
            let left = ranks[$0.threadId] ?? Int.max, right = ranks[$1.threadId] ?? Int.max
            if left != right { return left < right }
            let a = $0.lastActivityAt ?? $0.createdAt, b = $1.lastActivityAt ?? $1.createdAt
            return a == b ? $0.threadId < $1.threadId : a > b
        }
    }
}
