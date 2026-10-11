/// A connection check is not evidence that a bot is asleep or awake.
public enum BotConnectionPhase: Equatable, Sendable {
    case checking, awake, asleep

    public static func resolve(refreshing: Bool, connecting: Bool, live: Bool) -> Self {
        if refreshing || connecting { return .checking }
        return live ? .awake : .asleep
    }
}
