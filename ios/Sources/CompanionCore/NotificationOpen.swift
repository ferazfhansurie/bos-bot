import Foundation

/// What a tapped notification or Live Activity does after its fetch fails.
///
/// The open belongs to the tap and the paired connection, never to one
/// stream. A tap from the lock screen usually arrives before the scene turns
/// active, and the foreground `connect()` that follows restarts a stream that
/// was offline; tying the open to that stream's generation dropped it
/// silently and left the person on the chat list. The phone has also only
/// just woken, so the first request often meets a network that is not up yet.
public enum NotificationOpenStep: Equatable, Sendable {
    /// Try the fetch again after this long.
    case retry(milliseconds: Int)
    /// A newer tap or another connection owns the screen now: stay quiet.
    case drop
    /// Out of attempts, or the computer said no: say why.
    case fail
}

public enum NotificationOpenFailure: Equatable, Sendable {
    /// The stream restarted under the fetch (a reconnect, not a refusal).
    case reconnected
    /// The computer could not be reached.
    case unreachable
    /// The computer answered with an error.
    case refused
}

public enum NotificationOpenPolicy {
    public static let maxAttempts = 4

    /// `attempt` is the one that just failed, counting from 0.
    public static func next(after failure: NotificationOpenFailure, attempt: Int, tapIsCurrent: Bool) -> NotificationOpenStep {
        guard tapIsCurrent else { return .drop }
        guard attempt + 1 < maxAttempts else { return .fail }
        switch failure {
        case .reconnected: return .retry(milliseconds: attempt == 0 ? 0 : 300)
        case .unreachable: return .retry(milliseconds: 600 << attempt)
        case .refused: return .fail
        }
    }

    public static func failure(for error: Error) -> NotificationOpenFailure {
        if error is CancellationError { return .reconnected }
        if case APIError.transport = error { return .unreachable }
        if error is URLError { return .unreachable }
        return .refused
    }
}
