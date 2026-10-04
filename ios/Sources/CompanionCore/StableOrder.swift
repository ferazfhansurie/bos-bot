import Foundation

/// The roster's row order, held still while a finger is on it.
///
/// Rows sort by latest activity, so with several bots posting the list
/// reshuffled several times a second, and a tap landed on whichever row had
/// just moved under the finger. The order shown now changes only when nobody
/// is touching the list, and at most once per `interval`; a row's content
/// still updates in place in between.
public struct StableOrder: Equatable, Sendable {
    /// The order on screen. Empty until the first `settle`.
    public private(set) var shown: [String] = []
    public private(set) var held = false
    private var lastApplied: Date = .distantPast
    public let interval: TimeInterval

    public init(interval: TimeInterval = 1.5) {
        self.interval = interval
    }

    /// The live order arranged the way the screen should show it: rows keep
    /// their shown places, a row that is new to the list goes in at the top,
    /// and a row that left is dropped.
    public func arrange(_ live: [String]) -> [String] {
        guard !shown.isEmpty else { return live }
        let present = Set(live)
        let known = Set(shown)
        return live.filter { !known.contains($0) } + shown.filter { present.contains($0) }
    }

    /// A finger came down on the list, or lifted off it.
    public mutating func hold(_ touching: Bool) { held = touching }

    /// Take the live order if nothing is in the way. Returns when to try
    /// again if the change has to wait, nil when there is nothing pending.
    @discardableResult
    public mutating func settle(_ live: [String], now: Date = Date()) -> TimeInterval? {
        if shown.isEmpty { shown = live; lastApplied = now; return nil }
        guard live != shown else { return nil }
        guard !held else { return interval }
        let wait = interval - now.timeIntervalSince(lastApplied)
        guard wait <= 0 else { return wait }
        shown = live
        lastApplied = now
        return nil
    }

    /// Lifting a finger counts as a change, so the order waits a full
    /// interval after the touch before it moves.
    public mutating func release(now: Date = Date()) {
        held = false
        lastApplied = now
    }
}
