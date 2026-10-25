#if DEBUG
import CompanionCore
import Foundation
import os

/// Debug-only refresh timing. With `-perf-probe` the app appends one JSON
/// line per mark to Documents/perf.jsonl and emits a matching signpost
/// (Points of Interest), so pull-to-refresh, foreground and cold-launch
/// latency can be measured the same way every run. A mark named `seen`
/// fires the first time a `PERF-<n>` token appears in folded state: the
/// moment a change made on the server is actually on screen.
@MainActor enum PerfProbe {
    static let enabled = ProcessInfo.processInfo.arguments.contains("-perf-probe")
    private static let signposts = OSLog(subsystem: "com.openmausbot.companion", category: .pointsOfInterest)
    private static var seen = Set<String>()
    private static let file: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
        .appendingPathComponent("perf.jsonl")

    static func mark(_ name: String, _ detail: String = "", at time: Double = Date().timeIntervalSince1970) {
        guard enabled, let file else { return }
        os_signpost(.event, log: signposts, name: "bos.perf", "%{public}s %{public}s", name, detail)
        let line = #"{"t":\#(time),"name":"\#(name)","detail":"\#(detail)"}"# + "\n"
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: file)
        }
    }

    /// The process start, read once from the kernel, so cold launch is
    /// measured from exec rather than from the first SwiftUI body.
    static func markLaunch() {
        guard enabled else { return }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        if sysctl(&mib, 4, &info, &size, nil, 0) == 0 {
            let start = info.kp_proc.p_un.__p_starttime
            mark("process.start", at: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
        }
        mark("app.init")
    }

    static func scan(_ text: String?, source: String) {
        guard enabled, let text, let range = text.range(of: "PERF-") else { return }
        let token = "PERF-" + text[range.upperBound...].prefix { $0.isNumber }
        guard seen.insert(token).inserted else { return }
        mark("seen", "\(token) \(source)")
    }

    static func scan(_ fleet: Fleet, source: String) {
        guard enabled else { return }
        for bot in fleet.bots { for message in bot.messages ?? [] { scan(message.text, source: source) } }
    }

    /// `-perf-pair-address 127.0.0.1:PORT -perf-pair-code CODE` pairs an
    /// unpaired simulator with an isolated fixture server without the UI.
    static var pairing: (Connection, String)? {
        let defaults = UserDefaults.standard
        guard enabled, let address = defaults.string(forKey: "perf-pair-address"),
              let code = defaults.string(forKey: "perf-pair-code"),
              let connection = Connection.parse(address) else { return nil }
        return (connection, code)
    }
}
#endif
