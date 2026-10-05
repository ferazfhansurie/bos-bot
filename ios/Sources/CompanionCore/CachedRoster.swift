import Foundation

/// The roster as last seen, so a cold launch draws the person's
/// conversations at once instead of an empty list while the stream dials.
///
/// Deliberately a lesser copy of `CompanionState`: a short tail of each
/// transcript, no inline screen pixels, and none of the in-flight run state.
/// What was running when the app last left the screen is not known to be
/// running now, and a stale "working" would also restart a Live Activity.
/// A cold launch opens the stream with no cursor, so the server answers
/// `resumed: false` and the full hydrate replaces all of this.
public struct CachedRoster: Codable, Sendable {
    public static let messagesPerThread = 20

    public var bots: [Bot]
    public var rooms: [Room]

    public init(state: CompanionState) {
        bots = state.bots.map { source in
            var bot = source
            bot.busy = nil
            bot.waitingOnTeammate = nil
            bot.tasks = bot.tasks?.map(Self.idle)
            (bot.messages, bot.hasMore) = Self.tail(
                state.messages[bot.threadId],
                hasMore: state.hasMore[bot.threadId]
            )
            bot.activeLeafId = state.activeLeafIds[bot.threadId]
            return bot
        }
        rooms = state.rooms.map { source in
            var room = source
            room.busyBotId = nil
            room.tasks = room.tasks?.map(Self.idle)
            (room.messages, room.hasMore) = Self.tail(
                state.messages[room.threadId],
                hasMore: state.hasMore[room.threadId]
            )
            return room
        }
    }

    public var fleet: Fleet { Fleet(bots: bots, groups: rooms) }

    public var isEmpty: Bool { bots.isEmpty && rooms.isEmpty }

    private static func idle(_ task: BotTask) -> BotTask {
        var task = task
        task.busy = nil
        task.activity = nil
        task.waitingOnTeammate = nil
        return task
    }

    private static func tail(_ messages: [Message]?, hasMore: Bool?) -> ([Message]?, Bool?) {
        guard let messages else { return (nil, nil) }
        let kept = messages.suffix(messagesPerThread).map { source -> Message in
            var message = source
            if message.png != nil {
                message.png = nil
                message.hasImage = true
            }
            return message
        }
        return (kept, hasMore == true || kept.count < messages.count)
    }
}
