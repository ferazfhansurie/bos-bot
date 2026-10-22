import Foundation

/// Missing policy on an older server is not consent to phone telemetry.
public struct AnonymousUsagePolicy: Codable, Sendable {
    public let enabled: Bool?
    public let disabledByEnv: Bool?
    public var allowsTelemetry: Bool { enabled == true && disabledByEnv != true }
}

public enum UsageTelemetryPolicy { case allowed, denied, unavailable }
public enum UsageEvent: String, Codable { case install, open, pairSuccess = "pair_success", pushOK = "push_ok" }

/// Small, content-free queue. Storage and transport are injected so tests never
/// use the app's preferences, paired hosts or the public receiver.
@MainActor public final class UsageTelemetry {
    private struct Event: Codable, Equatable {
        let name: UsageEvent
        let at: String
    }
    private struct WireEvent: Encodable {
        let name: UsageEvent
        let at: String
        let props: [String: String] = [:]
    }
    private struct State: Codable {
        var installID = UUID().uuidString.lowercased()
        var installed = false
        var enabled = true
        var events: [Event] = []
    }
    private struct Payload: Encodable {
        let install_id: String
        let version: String
        let platform = "ios"
        let events: [WireEvent]
    }
    private var state: State
    private var active = false
    private var flushing = false
    private var queueRevision = 0
    private let version: String
    private let save: (Data) -> Void
    private let authorize: () async -> UsageTelemetryPolicy
    private let post: (Data) async -> Bool
    private let environmentAllowed: Bool
    public var enabled: Bool { state.enabled && environmentAllowed }

    public init(version: String, load: () -> Data?, save: @escaping (Data) -> Void,
                environment: [String: String] = ProcessInfo.processInfo.environment,
                authorize: @escaping () async -> UsageTelemetryPolicy, post: @escaping (Data) async -> Bool) {
        self.version = version
        self.save = save
        self.authorize = authorize
        self.post = post
        environmentAllowed = Self.environmentAllows(environment)
        state = load().flatMap { try? JSONDecoder().decode(State.self, from: $0) } ?? State()
        state.events = Array(state.events.suffix(200))
        if !enabled { state.events = []; queueRevision += 1 }
        persist()
    }

    public static func environmentAllows(_ environment: [String: String]) -> Bool {
        environment["BOS_NO_PING"] != "1"
    }
    public func setEnabled(_ enabled: Bool) {
        state.enabled = enabled
        if !enabled { state.events = []; queueRevision += 1 }
        persist()
    }
    public func foreground() {
        guard !active else { return }
        active = true
        if !state.installed {
            state.installed = true
            record(.install)
        }
        record(.open)
    }
    public func background() async {
        active = false
        await flush()
    }
    public func record(_ name: UsageEvent) {
        guard enabled else { return }
        state.events.append(Event(name: name, at: ISO8601DateFormatter().string(from: Date())))
        if state.events.count > 200 { queueRevision += 1 }
        state.events = Array(state.events.suffix(200))
        persist()
    }
    public func flush() async {
        guard enabled, !flushing, !state.events.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        switch await authorize() {
        case .unavailable: return
        case .denied:
            state.events = []
            queueRevision += 1
            persist()
            return
        case .allowed: break
        }
        guard enabled else { return }
        let batch = Array(state.events.prefix(50))
        let revision = queueRevision
        guard !batch.isEmpty, let body = try? JSONEncoder().encode(Payload(install_id: state.installID, version: version, events: batch.map { WireEvent(name: $0.name, at: $0.at) })) else { return }
        if await post(body), queueRevision == revision, Array(state.events.prefix(batch.count)) == batch {
            state.events.removeFirst(batch.count)
            persist()
        }
    }
    private func persist() {
        if let data = try? JSONEncoder().encode(state) { save(data) }
    }
}
