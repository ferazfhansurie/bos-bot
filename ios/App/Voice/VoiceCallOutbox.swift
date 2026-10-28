// Voice calls v3, the parts that outlive a call (plans/voice-v3/contract.md).
//
// Three durable queues, all on disk in Application Support before anything
// is sent, all safe to resend:
// - the job journal (CompanionCore's VoiceJobJournal): confirmed jobs until
//   POST /api/voice/jobs answers sent or duplicate for each;
// - call-end reports: POST /api/voice/call/end, idempotent on callId;
// - voice memos recorded when a call couldn't connect.
// They drain on confirm, reconnect, call end, app foreground and network back.
//
// Plus the prewarm: a call minted ahead of the tap (≤240 s) so the line
// opens on the first frame.
import AVFoundation
import CompanionCore
import Foundation
import Network
import UserNotifications

@MainActor
final class VoiceCallOutbox {
    static let shared = VoiceCallOutbox()

    private weak var session: Session?
    private let journal = VoiceJobJournal.shared
    private let ends = DurableOutbox<VoiceCallEndRequest>(file: .applicationSupport("voice-call-ends.json"))
    private let memos = DurableOutbox<VoiceMemoItem>(file: .applicationSupport("voice-memos.json"))
    private let monitor = NWPathMonitor()
    private var online = true
    private var draining = false
    private var drainAgain = false
    private var retry: Task<Void, Never>?

    private init() {}

    func attach(_ session: Session) {
        guard self.session !== session else { return }
        self.session = session
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let cameBack = satisfied && !self.online
                    self.online = satisfied
                    if cameBack { self.drainAll() }
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "bos.voice.path"))
    }

    private var client: CompanionClient? { session?.captureSendClient() }

    /// App foreground: everything owed goes out, and the default bot's call
    /// is minted ahead of a tap.
    func foreground() {
        drainAll()
        session?.prewarmDefaultVoiceCall()
    }

    func drainAll() {
        // Not connected yet (a cold launch): try again shortly.
        if client == nil {
            guard retry == nil, !(journal.isEmpty && ends.all.isEmpty && memos.all.isEmpty) else { return }
            retry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                self?.retry = nil
                self?.drainAll()
            }
            return
        }
        Task { _ = await flushJobs() }
        drainEnds()
        drainMemos()
    }

    // MARK: Jobs

    /// Send every journalled job. Entries leave the journal only on sent or
    /// duplicate; a flush that lands jobs from a call that already ended says
    /// so in a notification.
    @discardableResult
    func flushJobs() async -> VoiceJobJournal.FlushOutcome {
        guard !journal.isEmpty, let client else { return VoiceJobJournal.FlushOutcome(remaining: journal.all.count) }
        let outcome = await journal.flush { request in try await client.sendVoiceJobs(request) }
        if outcome.landedAfterCallEnd > 0 { Self.notifySent(outcome.landedAfterCallEnd) }
        return outcome
    }

    private static func notifySent(_ count: Int) {
        let content = UNMutableNotificationContent()
        content.title = "bos"
        content.body = "sent \(count) \(count == 1 ? "job" : "jobs") from your call"
        content.threadIdentifier = "voice-jobs"
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "voice-jobs.\(UUID().uuidString)", content: content, trigger: nil))
    }

    // MARK: Call end

    /// Durable first, then sent. The report is replaced (same callId) if a
    /// later version arrives before it lands.
    func enqueueEnd(_ report: VoiceCallEndRequest, drain: Bool = true) {
        try? ends.put(report)
        if drain { drainEnds() }
    }

    private func drainEnds() {
        guard let client, !ends.all.isEmpty else { return }
        let pending = ends.all
        Task { [ends] in
            for report in pending {
                do {
                    _ = try await client.endVoiceCall(report)
                    ends.remove(report.id)
                } catch {
                    // An old server (404) or a report it can never take:
                    // stop retrying. Anything else waits for the next drain.
                    if Self.isPermanent(error) { ends.remove(report.id) }
                }
            }
        }
    }

    nonisolated static func isPermanent(_ error: Error) -> Bool {
        guard case let APIError.status(code, _) = error else { return false }
        return (400...499).contains(code) && code != 408 && code != 429 && code != 401
    }

    // MARK: Memos

    func enqueueMemo(_ item: VoiceMemoItem) {
        try? memos.put(item)
        drainMemos()
    }

    /// Upload, then send to the called bot as a normal message (the server
    /// transcribes audio attachments), then book event `memo`.
    private func drainMemos() {
        guard !draining else { drainAgain = true; return }
        guard let client, !memos.all.isEmpty else { return }
        draining = true
        let pending = memos.all
        Task { [memos] in
            for var item in pending {
                let url = VoiceMemoRecorder.fileURL(item.fileName)
                guard FileManager.default.fileExists(atPath: url.path) else { memos.remove(item.id); continue }
                do {
                    if item.uploadedPath == nil {
                        let uploaded = try await client.uploadFile(fileURL: url, name: "voice memo.m4a", mime: "audio/mp4", uploadId: item.id)
                        item.uploadedPath = uploaded.path
                        try? memos.put(item)
                    }
                    let attachment = SharedAttachmentReference(path: item.uploadedPath ?? "", kind: .file, displayName: "voice memo.m4a")
                    let text = SharedMessageComposer.compose(instruction: VoiceMemoPolicy.messageText, text: [], urls: [], attachments: [attachment])
                    _ = try await client.send(text: text, to: .bot(id: item.botId, threadId: item.threadId ?? ""), sendId: item.sendId)
                    memos.remove(item.id)
                    try? FileManager.default.removeItem(at: url)
                    try? await client.postVoiceEvent(VoiceCallEventRequest(callId: item.callId, botId: item.botId, event: .memo))
                } catch {
                    if case let APIError.status(code, _) = error, [400, 404, 413].contains(code) {
                        memos.remove(item.id)
                        try? FileManager.default.removeItem(at: url)
                    }
                }
            }
            await MainActor.run {
                self.draining = false
                if self.drainAgain { self.drainAgain = false; self.drainMemos() }
            }
        }
    }

    // MARK: Events

    /// Counters for the computer's voice card. Fire and forget.
    func post(_ event: VoiceCallEvent, callId: String, botId: String) {
        guard let client else { return }
        Task { try? await client.postVoiceEvent(VoiceCallEventRequest(callId: callId, botId: botId, event: event)) }
    }
}

// MARK: - Prewarm

/// A call minted before the tap. Only for a computer that has answered a
/// v3 plan before: an older server would book a prewarm as a real call.
@MainActor
final class VoiceCallWarmer {
    static let shared = VoiceCallWarmer()
    private var inflight: [String: Task<Void, Never>] = [:]
    private static let v3Key = "voiceCall.v3Computers"

    static func markV3(_ connectionID: String?, _ isV3: Bool) {
        guard let connectionID else { return }
        var known = Set(UserDefaults.standard.stringArray(forKey: v3Key) ?? [])
        let changed = isV3 ? known.insert(connectionID).inserted : known.remove(connectionID) != nil
        if changed { UserDefaults.standard.set(known.sorted(), forKey: v3Key) }
    }

    static func knowsV3(_ connectionID: String?) -> Bool {
        guard let connectionID else { return false }
        return (UserDefaults.standard.stringArray(forKey: v3Key) ?? []).contains(connectionID)
    }

    func prewarm(botId: String, language: String?, client: CompanionClient) {
        guard Self.knowsV3(client.connection.id), inflight[botId] == nil,
              !VoicePrewarmCache.shared.hasFresh(botId: botId, now: Date()) else { return }
        let callId = UUID().uuidString.lowercased()
        inflight[botId] = Task { [weak self] in
            if let start = try? await client.voiceCall(botId: botId, language: language, callId: callId, prewarm: true),
               start.plan.isV3 {
                VoicePrewarmCache.shared.store(botId: botId, language: language, callId: start.callId ?? callId, start: start, at: Date())
            }
            self?.inflight[botId] = nil
        }
    }

    /// A dial waits briefly for a prewarm already on its way.
    func settle(botId: String) async {
        guard let task = inflight[botId] else { return }
        let waited = Task { await task.value }
        let timeout = Task { try? await Task.sleep(for: .seconds(3)); waited.cancel() }
        await waited.value
        timeout.cancel()
    }
}

// MARK: - Memo recorder

/// Records the caller when the line can't connect: m4a, on disk, queued on
/// hang-up for the bot that was called.
@MainActor
final class VoiceMemoRecorder {
    let item: VoiceMemoItem
    private var recorder: AVAudioRecorder?

    static func directory() -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return root.appendingPathComponent("BosBot/voice-memos", isDirectory: true)
    }

    static func fileURL(_ name: String) -> URL { directory().appendingPathComponent(name) }

    init(callId: String, botId: String, threadId: String) {
        let id = UUID().uuidString
        item = VoiceMemoItem(id: id, callId: callId, botId: botId, threadId: threadId,
                             fileName: "\(id.lowercased()).m4a", recordedAt: Date().timeIntervalSince1970 * 1000)
    }

    func start() throws {
        try FileManager.default.createDirectory(at: Self.directory(), withIntermediateDirectories: true)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        let recorder = try AVAudioRecorder(url: Self.fileURL(item.fileName), settings: [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ])
        guard recorder.record() else { throw APIError.transport("Couldn't record a memo.") }
        self.recorder = recorder
    }

    /// The memo, or nil when nothing worth sending was recorded.
    func stop() -> VoiceMemoItem? {
        guard let recorder else { return nil }
        let seconds = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let url = Self.fileURL(item.fileName)
        guard seconds >= 1 else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        try? (url as NSURL).setResourceValue(URLFileProtection.completeUntilFirstUserAuthentication, forKey: .fileProtectionKey)
        return item
    }

    func discard() {
        recorder?.stop()
        recorder = nil
        try? FileManager.default.removeItem(at: Self.fileURL(item.fileName))
    }
}
