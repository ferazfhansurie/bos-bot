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

    static func forBot(_ bot: Bot, last: Message?) -> MausState {
        let activity = MascotActivityChoreography.activity(runtime: bot.activity, busy: bot.busy == true,
            waitingOnTeammate: bot.waitingOnTeammate == true,
            pendingRequest: last?.card?.isPending == true || last?.secret?.isPending == true,
            toolName: last?.tool?.name)
        switch activity {
        case .thinking: return .thinking
        case .searching: return .searching
        case .working: return .working
        case .waiting: return .listening
        default: return .idle
        }
    }

    /// The runtime face for the exact open conversation, including its
    /// pending request and actual live reasoning stream.
    static func forChat(_ chat: Chat, in state: CompanionState) -> MausState {
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
}
