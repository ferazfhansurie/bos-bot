#if DEBUG
// Measurement only. `-autopilot scroll|typing|switch` drives the same three
// scenarios as MultiBotStreamingUITests from inside the app, so a run can be
// measured with no UI test attached. A UI test reads the accessibility tree
// of the whole screen on every query, and that work lands on this app's main
// thread; comparing the two passes separates the test's cost from the app's.
import Foundation

enum Autopilot {
    static var scenario: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-autopilot"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    private static let logPath = "/tmp/bos-autopilot.log"
    static func log(_ line: String) {
        let stamped = String(format: "%.3f ", Date().timeIntervalSince1970) + line + "\n"
        if let handle = FileHandle(forWritingAtPath: logPath) {
            handle.seekToEndOfFile(); handle.write(Data(stamped.utf8)); try? handle.close()
        } else {
            try? Data(stamped.utf8).write(to: URL(fileURLWithPath: logPath))
        }
    }

    /// The host script waits for this file, then copies the probe.
    static func finish() {
        log("DONE")
        // one more probe write lands within half a second
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            try? Data("done".utf8).write(to: URL(fileURLWithPath: "/tmp/bos-autopilot-done"))
        }
    }

    /// Set by ChatView when it appears and disappears, for switch timings.
    @MainActor static var chatAppeared: (() -> Void)?
    @MainActor static var chatDisappeared: (() -> Void)?
}
#endif
