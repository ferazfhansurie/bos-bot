#if DEBUG
// Measurement only, behind -stream-preview: how long the main thread keeps
// a keystroke waiting while a run streams, and how often the chat redraws.
import Foundation
import Darwin

final class MainThreadProbe: @unchecked Sendable {
    static let shared = MainThreadProbe()
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("-stream-preview") }

    private let lock = NSLock()
    private var samples: [Double] = []
    private var chatBodies = 0
    private var listBodies = 0
    /// `-probe-always`: measure the whole run, not just while typing, so
    /// scrolling and switching chats count too.
    static var always: Bool { ProcessInfo.processInfo.arguments.contains("-probe-always") }
    private var recording = false
    private var started = false
    private var mainThread: thread_act_t = 0
    private var cpuAtStart = 0.0, wallAtStart = 0.0

    /// User + system CPU seconds the main thread has used.
    private func mainCPU() -> Double {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { thread_info(mainThread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1e6
            + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1e6
    }

    /// Called from the composer: measure only while there is a draft.
    func typing(_ active: Bool) {
        guard Self.enabled else { return }
        lock.lock(); recording = active || Self.always; lock.unlock()
        guard active else { return }
        start()
    }

    /// Begin sampling; called on the main thread.
    func start() {
        guard Self.enabled, !started else { return }
        if Self.always { lock.lock(); recording = true; lock.unlock() }
        started = true
        mainThread = mach_thread_self()  // called on the main thread
        cpuAtStart = mainCPU(); wallAtStart = Date().timeIntervalSince1970
        Thread.detachNewThread { [self] in
            while true {
                let sent = DispatchTime.now().uptimeNanoseconds
                let done = DispatchSemaphore(value: 0)
                var waited = 0.0
                DispatchQueue.main.async {
                    waited = Double(DispatchTime.now().uptimeNanoseconds - sent) / 1_000_000
                    done.signal()
                }
                done.wait()
                lock.lock()
                if recording { samples.append(waited) }
                lock.unlock()
                write()
                Thread.sleep(forTimeInterval: 0.008)
            }
        }
    }

    var isTyping: Bool { lock.lock(); defer { lock.unlock() }; return recording }

    func chatBody() {
        guard Self.enabled else { return }
        lock.lock(); if recording { chatBodies += 1 }; lock.unlock()
    }

    func listBody() {
        guard Self.enabled else { return }
        lock.lock(); if recording { listBodies += 1 }; lock.unlock()
    }

    private var lastWrite = Date.distantPast
    private func write() {
        guard Date().timeIntervalSince(lastWrite) > 0.5 else { return }
        lastWrite = Date()
        lock.lock()
        let sorted = samples.sorted(), bodies = chatBodies, lists = listBodies
        lock.unlock()
        guard !sorted.isEmpty else { return }
        func pct(_ p: Double) -> Double { sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
        let over16 = sorted.filter { $0 > 16.7 }.count, over50 = sorted.filter { $0 > 50 }.count
        let json: [String: Any] = [
            "samples": sorted.count, "p50_ms": pct(0.5), "p95_ms": pct(0.95), "p99_ms": pct(0.99),
            "max_ms": sorted.last!,
            "main_cpu_per_s": (mainCPU() - cpuAtStart) / max(0.001, Date().timeIntervalSince1970 - wallAtStart), "over_16ms": over16, "over_50ms": over50, "chat_body_evals": bodies, "list_body_evals": lists,
            "seconds": Date().timeIntervalSince1970 - wallAtStart
        ]
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: "/tmp/bos-typing-probe.json"))
        }
    }
}
#endif
