import Foundation

/// Transport registration only. This deliberately makes no delivery guarantee.
public enum PushRegistrationState: Equatable, Sendable {
    case notRegistered, registering, registered, deliveryUnavailable, failed

    public static func summary(_ states: [Self]) -> String {
        guard !states.isEmpty else { return "Connect a computer" }
        if states.contains(.registering) { return "Setting up" }
        let registered = states.filter { $0 == .registered }.count
        if registered == states.count { return "Registered" }
        if registered > 0 { return "Partly registered" }
        if states.contains(.deliveryUnavailable) { return "Push not set up on this BOS" }
        if states.contains(.failed) { return "Setup needs retry" }
        return "Awaiting registration"
    }
}

/// Older servers acknowledge registration without saying whether APNs is set up.
/// Explicit false means registration cannot currently deliver a notification.
public struct PushTokenRegistrationResponse: Decodable, Sendable {
    public var deliveryConfigured: Bool?
    public var state: PushRegistrationState { deliveryConfigured == false ? .deliveryUnavailable : .registered }
}
