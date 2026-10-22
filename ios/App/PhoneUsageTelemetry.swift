import Foundation
import CompanionCore

/// App-owned adapter. Ephemeral URLSession carries no paired-server tokens,
/// cookies or content to the public usage receiver.
@MainActor final class PhoneUsageTelemetry {
    static let shared = PhoneUsageTelemetry()
    var policy: (() async -> UsageTelemetryPolicy)?
    private var timer: Task<Void, Never>?
    private lazy var telemetry = UsageTelemetry(
        version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
        load: { UserDefaults.standard.data(forKey: "bos.phoneUsage.v1") },
        save: { UserDefaults.standard.set($0, forKey: "bos.phoneUsage.v1") },
        environment: Self.telemetryEnvironment,
        authorize: { [weak self] in await self?.policy?() ?? .unavailable },
        post: { data in
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false
            config.urlCredentialStorage = nil
            config.timeoutIntervalForRequest = 10
            let session = URLSession(configuration: config)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: URL(string: "https://bosbot.my/api/events")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = data
            do {
                let (_, response) = try await session.data(for: request)
                return (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            } catch { return false }
        }
    )
    private static var telemetryEnvironment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        #if DEBUG
        // Fixture/preview builds must never contribute synthetic public events.
        environment["BOS_NO_PING"] = "1"
        #endif
        return environment
    }
    var enabled: Bool { telemetry.enabled }
    func setEnabled(_ enabled: Bool) { telemetry.setEnabled(enabled) }
    func record(_ event: UsageEvent) { telemetry.record(event) }
    func foreground() {
        telemetry.foreground()
        guard timer == nil else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                guard !Task.isCancelled else { return }
                await self?.telemetry.flush()
            }
        }
    }
    func background() {
        timer?.cancel()
        timer = nil
        Task { await telemetry.background() }
    }
}
