// Actual runtime activity chooses choreography. Idle bot role/profile text
// never creates work; pending user or teammate waits win over busy flags.
import Foundation
import CompanionCore

extension MausState {
    /// The desktop's legacy names, kept so an older bot record still resolves.
    private static let legacy: [String: MausState] = [
        "deadpan": .idle, "friendly": .happy, "focused": .working, "thinking": .thinking,
        "excited": .excited, "sleepy": .drowsy, "surprised": .surprised, "skeptical": .suspicious,
        "worried": .scared, "mischievous": .playful,
    ]

    /// Resolves any stored value — current, legacy or junk — to a real state.
    static func normalize(_ value: String?) -> MausState? {
        guard let value, !value.isEmpty else { return nil }
        return MausState(rawValue: value) ?? legacy[value]
    }

    var activityChoreography: MascotActivity {
        switch self {
        case .thinking: return .thinking
        case .searching: return .searching
        case .working: return .working
        case .listening: return .waiting
        case .celebrate: return .finished
        default: return .idle
        }
    }

    /// The face that carries a choreography — the inverse of
    /// `activityChoreography`. Finished has no resting face of its own; the
    /// celebration is a one-shot the completion ledger plays over idle.
    static func face(for activity: MascotActivity) -> MausState {
        switch activity {
        case .thinking: return .thinking
        case .searching: return .searching
        case .working: return .working
        case .waiting: return .listening
        case .idle, .finished: return .idle
        }
    }

    /// The face for a feed entry, by the desktop's mapping (see
    /// `ActivityFeedState.mascotActivity`). Failed and stopped settle to the
    /// idle face: still, never looping.
    static func forFeed(_ entry: ActivityFeedEntry) -> MausState {
        face(for: entry.mascotActivity)
    }

    static func forBot(_ bot: Bot, last: Message?) -> MausState {
        face(for: MascotActivityChoreography.activity(runtime: bot.tasks?.first { $0.threadId == bot.threadId }?.activity, busy: bot.currentTaskBusy == true,
            waitingOnTeammate: bot.waitingOnTeammate == true,
            pendingRequest: last?.card?.isPending == true || last?.secret?.isPending == true,
            toolName: last?.tool?.name))
    }

    /// The face for a row that stands for the whole conversation — the chat
    /// list, the island, updates. When the server's activity feed names this
    /// bot it is the truth, and its busiest thread wins, so a bot working in
    /// another thread still animates its row. Otherwise the face is read
    /// from the exact open thread, its pending request and live reasoning.
    static func forChat(_ chat: Chat, in state: CompanionState) -> MausState {
        switch chat {
        case let .bot(bot):
            if let live = state.activityFeed.busiest(bot: bot.id) { return forFeed(live) }
        case let .room(room):
            if let live = state.activityFeed.busiest(room: room.id, thread: room.threadId) { return forFeed(live) }
        }
        let transcript = state.visibleTranscript(forThread: chat.threadId)
        let pending = transcript.last { $0.card?.isPending == true || $0.secret?.isPending == true }
        switch chat {
        case let .bot(bot):
            let mapped = forBot(bot, last: pending ?? transcript.last)
            if mapped == .working, state.reasoning[bot.threadId]?.isEmpty == false { return .thinking }
            return mapped
        case .room: return pending != nil ? .listening : (chat.busy ? .working : .idle)
        }
    }

    /// The feed's face for exactly this (bot, thread) — the open chat's
    /// header. Nil when the feed has not named the thread, so the caller
    /// keeps its own default; another thread being busy never leaks in.
    static func forThread(_ chat: Chat, in state: CompanionState) -> MausState? {
        guard case let .bot(bot) = chat,
              let live = state.activityFeed.entry(bot: bot.id, thread: bot.threadId) else { return nil }
        return forFeed(live)
    }
}
