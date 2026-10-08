import CryptoKit
import Foundation

// MARK: - hint

/// The room service's generic push hint (`PushHintSchema` in
/// shared/cloud-protocol): ids only and a fixed preview, never message text.
/// The APNs envelope carries it under `bos_cloud`; anything that doesn't match
/// the schema exactly is not a cloud hint and is ignored.
public struct CloudPushHint: Hashable, Codable, Sendable {
    public static let envelopeKey = "bos_cloud"
    public static let preview = "New activity"

    public var workspaceId: String
    public var roomId: String
    public var eventId: String

    public init?(workspaceId: String, roomId: String, eventId: String) {
        guard [workspaceId, roomId, eventId].allSatisfy(Self.validId) else { return nil }
        self.workspaceId = workspaceId; self.roomId = roomId; self.eventId = eventId
    }

    /// From a delivered notification's userInfo.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let raw = userInfo[Self.envelopeKey] as? [String: Any] else { return nil }
        self.init(fields: raw)
    }

    /// From the raw hint object, as `PushHintSchema` defines it (strict).
    public init?(fields raw: [String: Any]) {
        guard Set(raw.keys) == ["kind", "workspace_id", "room_id", "event_id", "preview"],
              raw["kind"] as? String == "room_sync", raw["preview"] as? String == Self.preview,
              let w = raw["workspace_id"] as? String, let r = raw["room_id"] as? String, let e = raw["event_id"] as? String
        else { return nil }
        self.init(workspaceId: w, roomId: r, eventId: e)
    }

    public init?(json data: Data) {
        guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        self.init(fields: raw)
    }

    /// Notification request id: one alert per committed event, however often it's replayed.
    public var notificationIdentifier: String { "bos.cloud.\(workspaceId).\(roomId).\(eventId)" }

    /// `IdSchema`: 1-128 of [A-Za-z0-9_-].
    static func validId(_ value: String) -> Bool {
        (1...128).contains(value.utf8.count) && value.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95
        }
    }
}

/// Where a tapped hint goes, given the rooms this account can see right now.
public enum CloudPushRoute: Equatable, Sendable {
    case open(CloudRoomRef)
    /// Not in the cached list; sync discovery once and look again.
    case refresh
    /// Still missing after a fresh sync: not this account's room, or access ended.
    case unavailable

    public static func resolve(_ hint: CloudPushHint, in rooms: [CloudRoomRef], synced: Bool) -> CloudPushRoute {
        if let ref = rooms.first(where: { $0.workspaceId == hint.workspaceId && $0.roomId == hint.roomId }) { return .open(ref) }
        return synced ? .unavailable : .refresh
    }
}

// MARK: - registration

/// POST /v2/workspaces/{w}/push-registrations. The device token never leaves
/// the phone: the server binds session, installation and versions only.
public struct CloudPushRegistrationRequest: Hashable, Codable, Sendable {
    public var installationId: String
    public var generation: CloudSequence
    public var tokenVersion: CloudSequence
    public var provider = "apns"
    public var environment = "sandbox"
    public var muted: Bool
    public var mentionsOnly: Bool

    public init(installationId: String, generation: CloudSequence, tokenVersion: CloudSequence, muted: Bool = false, mentionsOnly: Bool = false) {
        self.installationId = installationId; self.generation = generation; self.tokenVersion = tokenVersion
        self.muted = muted; self.mentionsOnly = mentionsOnly
    }

    enum CodingKeys: String, CodingKey {
        case installationId = "installation_id", generation, tokenVersion = "token_version", provider, environment, muted, mentionsOnly = "mentions_only"
    }
}

public struct CloudPushRegistration: Hashable, Codable, Sendable {
    public var registrationId: String
    public var expiresAt: String

    public init(registrationId: String, expiresAt: String) { self.registrationId = registrationId; self.expiresAt = expiresAt }

    public var expiryDate: Date? { CloudDate.parse(expiresAt) }

    enum CodingKeys: String, CodingKey { case registrationId = "registration_id", expiresAt = "expires_at" }
}

/// What this installation has registered for one account, persisted per
/// account. Generation moves on each new sign-in session (the server binds
/// the session); token version moves when APNs hands out a different token.
public struct CloudPushState: Hashable, Codable, Sendable {
    public struct Workspace: Hashable, Codable, Sendable {
        public var registrationId: String
        public var expiresAt: Date
        public var generation: UInt64
        public var tokenVersion: UInt64
        public var renewedAt: Date
    }

    public var installationId: String
    public var generation: UInt64 = 1
    public var tokenVersion: UInt64 = 0
    /// SHA-256 of the last APNs token, to notice a change. Never the token.
    public var tokenDigest: String?
    public var workspaces: [String: Workspace] = [:]

    public init(installationId: String) { self.installationId = installationId }
}

public enum CloudPushAction: Hashable, Sendable {
    case register(workspaceId: String, CloudPushRegistrationRequest)
    case revoke(workspaceId: String, registrationId: String)
}

/// Decides when to register, renew and revoke. Pure; the model runs the
/// actions and reports back. Renewal is authenticated and foreground only.
public struct CloudPushRegistrar: Hashable, Sendable {
    /// Renew when less than this is left on a registration.
    public static let renewBefore: TimeInterval = 24 * 3600
    /// Don't renew the same workspace more often than this (guest
    /// registrations end with the session, so they always look close).
    public static let minimumInterval: TimeInterval = 3600

    public private(set) var state: CloudPushState

    public init(state: CloudPushState) { self.state = state }

    /// A new sign-in session: everything registered under the old one is stale.
    public mutating func sessionStarted() {
        state.generation += 1
    }

    /// APNs gave a token. Only a different token bumps the version.
    public mutating func tokenReceived(_ token: Data) {
        let digest = SHA256.hash(data: token).map { String(format: "%02x", $0) }.joined()
        guard digest != state.tokenDigest else { return }
        state.tokenDigest = digest
        state.tokenVersion += 1
    }

    /// Notifications allowed or not, against the workspaces discovery returned.
    public func plan(workspaces: [String], authorized: Bool, now: Date) -> [CloudPushAction] {
        var actions: [CloudPushAction] = []
        let wanted = authorized ? Set(workspaces) : []
        for (id, registered) in state.workspaces.sorted(by: { $0.key < $1.key }) where !wanted.contains(id) {
            actions.append(.revoke(workspaceId: id, registrationId: registered.registrationId))
        }
        for id in workspaces.sorted() where wanted.contains(id) && needsRenewal(state.workspaces[id], now: now) {
            actions.append(.register(workspaceId: id, request))
        }
        return actions
    }

    private func needsRenewal(_ registered: CloudPushState.Workspace?, now: Date) -> Bool {
        guard let registered else { return true }
        if registered.generation != state.generation || registered.tokenVersion != state.tokenVersion { return true }
        if registered.expiresAt <= now { return true }
        return registered.expiresAt.timeIntervalSince(now) < Self.renewBefore
            && now.timeIntervalSince(registered.renewedAt) >= Self.minimumInterval
    }

    private var request: CloudPushRegistrationRequest {
        CloudPushRegistrationRequest(installationId: state.installationId,
                                     generation: CloudSequence(String(state.generation))!,
                                     tokenVersion: CloudSequence(String(state.tokenVersion))!)
    }

    public mutating func registered(_ workspaceId: String, _ request: CloudPushRegistrationRequest, _ result: CloudPushRegistration, now: Date) {
        // Keeps the versions that were sent, so a sign-in or new token while
        // the request was out still renews on the next plan.
        guard let expiry = result.expiryDate,
              let generation = UInt64(request.generation.rawValue), let version = UInt64(request.tokenVersion.rawValue)
        else { return }
        state.workspaces[workspaceId] = .init(registrationId: result.registrationId, expiresAt: expiry, generation: generation, tokenVersion: version, renewedAt: now)
    }

    /// The server holds a newer generation for this installation (restored
    /// backup, another build): step past it on the next plan.
    public mutating func conflicted(_ workspaceId: String) {
        state.generation += 1
        state.workspaces[workspaceId] = nil
    }

    /// Revoked, or the workspace is gone; either way nothing is held here.
    public mutating func revoked(_ workspaceId: String) {
        state.workspaces[workspaceId] = nil
    }

    /// Everything to revoke before signing out.
    public var revokeAll: [CloudPushAction] {
        state.workspaces.sorted(by: { $0.key < $1.key }).map { .revoke(workspaceId: $0.key, registrationId: $0.value.registrationId) }
    }
}
