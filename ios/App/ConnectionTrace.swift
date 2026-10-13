import Foundation

/// Bounded local connection diagnostics. Never records URLs, credentials,
/// message text, payloads or user identifiers.
@MainActor
enum ConnectionTrace {
    private static var lines: [String] = []
    private static let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("connection-trace.log")
    static func record(_ event: String) {
        if lines.isEmpty, let prior = try? String(contentsOf: url, encoding: .utf8) {
            lines = Array(prior.split(separator: "\n").suffix(180).map(String.init))
        }
        lines.append("\(Date().timeIntervalSince1970) \(event)")
        if lines.count > 240 { lines.removeFirst(lines.count - 180) }
        try? (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
    }
}
