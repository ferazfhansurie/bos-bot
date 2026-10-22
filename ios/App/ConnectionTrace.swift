import Foundation
import SwiftUI
import UIKit

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

    static func export() throws -> ConnectionTraceExport {
        let prior = try? String(contentsOf: url, encoding: .utf8)
        let events = Array((prior ?? lines.joined(separator: "\n")).split(separator: "\n").suffix(240))
        let body = events.isEmpty ? "No connection events recorded.\n" : events.joined(separator: "\n") + "\n"
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("bos-connection-trace.log")
        try ("BOS connection trace (connection events only)\n" + body).write(to: destination, atomically: true, encoding: .utf8)
        return ConnectionTraceExport(url: destination)
    }
}

struct ConnectionTraceExport: Identifiable {
    let url: URL
    var id: String { url.path }
}

struct ConnectionTraceShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
