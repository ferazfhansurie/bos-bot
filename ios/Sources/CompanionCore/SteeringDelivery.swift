import Foundation

public enum SteeringStatus: Hashable, Sendable {
    case sentDuringReply, acceptedDuringReply, uncertain
}

extension Message {
    public var steeringStatus: SteeringStatus? {
        guard role == .user else { return nil }
        switch steerDelivery {
        case "transport_written": return .sentDuringReply
        case "provider_accepted": return .acceptedDuringReply
        case "outcome_unknown": return .uncertain
        default: return steered == true ? .sentDuringReply : nil
        }
    }
}

/// A successful HTTP request can still mean refusal or uncertain delivery.
/// Neither a pipe write nor a provider acknowledgement proves model consumption.
public struct SteerReceipt: Decodable, Sendable {
    public var steered: Bool?
    public var interrupted: Bool?
    public var outcomeUnknown: Bool?
    public var queued: Bool?
    public var reason: String?
    public var threadId: String?
    public var messages: [Message]?
    public var queueIds: [String]?
    public var delivery: String?

    /// Apply authoritative delivery immediately even when its SSE frame is late.
    /// Refused or unscoped receipts leave the queue alone for SSE to reconcile.
    @discardableResult
    public func apply(to state: inout CompanionState, expectedThreadId: String) -> Bool {
        guard threadId == expectedThreadId, steered == true || outcomeUnknown == true || (interrupted == true && queued != true) else { return false }
        for var message in messages ?? [] {
            if message.steerDelivery == nil {
                message.steerDelivery = outcomeUnknown == true ? "outcome_unknown" : delivery
            }
            state.apply(.message(threadId: expectedThreadId, message: message))
        }
        for queueId in queueIds ?? [] {
            state.consumeQueued(queueId: queueId, threadId: expectedThreadId)
        }
        return true
    }
}
