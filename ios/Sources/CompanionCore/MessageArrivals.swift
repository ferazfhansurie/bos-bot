// Which messages landed while a chat was open, so only those spring in.
//
// Whatever was on screen when the chat opened, and older pages loaded above
// it, stay still. Mirrors src/lib/message-arrivals.ts on desktop. A class,
// not observable state: the chat view updates it while it draws, and an
// arrival is decided once, on the draw that first sees the message.
public final class MessageArrivals {
    public static let window: Double = 0.4

    private var threadId: String?
    /// Newest message time when the chat opened; earlier pages never animate.
    private var baseline = -Double.infinity
    private var known: Set<String> = []
    private var arrivedAt: [String: Double] = [:]

    public init() {}

    /// `at` is the message time (ms); `now` is seconds, any clock.
    public func track(threadId: String, messages: [(id: String, at: Double)], now: Double) {
        if self.threadId != threadId {
            self.threadId = threadId
            baseline = messages.map(\.at).max() ?? -Double.infinity
            known = Set(messages.map(\.id))
            arrivedAt = [:]
            return
        }
        for message in messages where !known.contains(message.id) {
            known.insert(message.id)
            if message.at >= baseline { arrivedAt[message.id] = now }
        }
        arrivedAt = arrivedAt.filter { now - $0.value < Self.window }
    }

    public func isArriving(_ id: String) -> Bool { arrivedAt[id] != nil }
}
