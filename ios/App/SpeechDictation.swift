// On-device dictation for the composer.
//
// Same engine as the desktop helper (`electron/resources/speech-helper.swift`):
// `SFSpeechRecognizer` on an `AVAudioEngine` tap, partials streamed into the
// text field, press to stop. Composer mode, not call mode — there is no
// silence endpointing. The phone is better at this than the Mac was: the
// recognizer is in the same process as the field, so there is no helper
// binary, no TCC bundle dance, and no `open -W`.
//
// On-device when the recognizer supports it, so talking to a bot does not
// become talking to Apple's servers. Locales come from `Dictation.localeCandidates`
// rather than a hardcoded en-US, for the same reason the desktop helper
// stopped hardcoding one.
//
// Lives in the app target on purpose. CompanionCore is Foundation-only so
// `swift test` can run without a simulator; Speech and AVAudioEngine are
// the opposite of that.
import AVFoundation
import Combine
import Speech
import CompanionCore
import SwiftUI

@MainActor
final class SpeechDictation: ObservableObject {
    private static let cancellationCodes: [String: Set<Int>] = [
        "kLSRErrorDomain": [209, 216],
        "kAFAssistantErrorDomain": [216],
    ]

    @Published private(set) var isListening = false
    /// True from `start` until capture is running or the attempt fails.
    /// Publishing it keeps the frozen composer base protected while the
    /// system permission sheets are still in flight.
    @Published private(set) var isStarting = false
    @Published private(set) var transcript = ""
    @Published var showingRecorder = false
    @Published private(set) var isFinishing = false
    @Published private(set) var recordingURL: URL?
    @Published private(set) var startedAt: Date?
    @Published private(set) var inputName = "Microphone"
    @Published var meetingMode = false
    private let feed = RecordingFeed()
    private var segment = 0
    private var segmentTask: Task<Void, Never>?
    private var finishTask: Task<Void, Never>?
    private var drainingTasks: [Int: SFSpeechRecognitionTask] = [:]
    private var previewTask: Task<Void, Never>?
    private var healthTask: Task<Void, Never>?
    private var lastCheckpoint = Date.distantPast

    func openRecorder(capturing draft: String) {
        showingRecorder = true
        if !isListening && !isStarting && !isFinishing { start(base: draft) }
    }

    func resume() {
        guard !isFinishing else { return }
        start(base: Dictation.draft(base: base, transcript: transcript))
    }

    func checkCaptureHealth() {
        guard isListening else { return }
        let available = recordingURL.flatMap { try? $0.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage }
        if let available, available < 50_000_000 {
            error = "Storage is almost full. Recording saved and stopped."
            stop()
        } else if let audioEngine, !audioEngine.isRunning {
            interrupt()
        } else if feed.failed {
            error = "Audio couldn't be saved. Recording stopped; free some space before resuming."
            stop()
        } else if Date().timeIntervalSince(lastCheckpoint) > 2 {
            checkpoint()
            lastCheckpoint = Date()
        }
    }

    func checkpoint() {
        guard let recordingURL else { return }
        let text = transcript
        do {
            try text.write(to: recordingURL.deletingPathExtension().appendingPathExtension("txt"), atomically: true, encoding: .utf8)
        } catch {
            self.error = "Couldn't save the transcript. Your audio is still available."
        }
    }

    func interrupt() {
        guard isListening || isStarting else { return }
        error = "Recording interrupted. Your audio and text are saved. Tap Resume when ready."
        stop()
    }
    private var spoken = Dictation.RecordingTranscript()
    @Published private(set) var error: LocalizedStringKey?

    /// Composer text captured when listening started. Frozen for the
    /// session so each partial replaces the last rather than stacking.
    /// ChatView reads this from `onChange(of: transcript)` and must not
    /// substitute the live draft.
    private(set) var base = ""

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var stopping = false
    /// Bumped on every start/stop so an authorization that finishes after
    /// the user already cancelled cannot open the mic.
    private var generation = 0
    private var startTask: Task<Void, Never>?

    func toggle(capturing base: String) {
        if isListening || isStarting {
            stop()
        } else {
            start(base: base)
        }
    }

    private func start(base: String) {
        guard !isListening, !isStarting, !isFinishing else { return }
        error = nil
        self.base = base.trimmingCharacters(in: .whitespacesAndNewlines)
        transcript = ""
        spoken = Dictation.RecordingTranscript()
        segment = 0
        recordingURL = nil
        isStarting = true
        generation += 1
        let gen = generation
        startTask = Task { await actuallyStart(generation: gen) }
    }

    func finishRecording() async {
        stop()
        while isFinishing {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    func stopImmediately() {
        stop()
        if isFinishing { finish() }
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        isStarting = false
        guard isListening else { return }
        isListening = false
        previewTask?.cancel()
        isFinishing = true
        segmentTask?.cancel()
        feed.route(nil)
        if tapInstalled {
            audioEngine?.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        audioEngine?.stop()
        feed.close()
        recognitionRequest?.endAudio()
        checkpoint()
        // Give the recognizer the final buffer, rather than cancelling the
        // final word with the microphone. A bounded drain keeps UI responsive.
        finishTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            self?.finish()
        }
    }

    private func finish() {
        finishTask?.cancel()
        finishTask = nil
        stopping = true
        generation += 1
        teardown()
        isFinishing = false
        checkpoint()
    }

    // MARK: - Authorization

    private func actuallyStart(generation gen: Int) async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-store-preview"),
           ProcessInfo.processInfo.arguments.contains("-recording-preview") {
            startPreview(generation: gen)
            return
        }
        #endif
        let speech = await requestSpeechAuthorization()
        guard gen == generation, !Task.isCancelled else {
            return
        }
        if speech != .authorized { error = Self.speechDeniedMessage }

        let mic = await AVAudioApplication.requestRecordPermission()
        guard gen == generation, !Task.isCancelled else {
            return
        }
        guard mic else {
            isStarting = false
            error = Self.micDeniedMessage
            return
        }

        do {
            try beginCapture(generation: gen, speechAuthorized: speech == .authorized)
            isStarting = false
        } catch CaptureError.noRecognizer {
            isStarting = false
            error = "Dictation isn't available for this language."
            teardown()
        } catch {
            isStarting = false
            self.error = "Couldn't start the microphone."
            teardown()
        }
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    // MARK: - Capture

    private func beginCapture(generation gen: Int, speechAuthorized: Bool) throws {
        let recognizer = speechAuthorized ? Dictation.localeCandidates()
            .compactMap { SFSpeechRecognizer(locale: $0) }
            .first { $0.isAvailable } : nil
        if speechAuthorized, recognizer == nil {
            error = "Live transcription is unavailable. Your audio will still be saved."
        }
        self.recognizer = recognizer

        let session = AVAudioSession.sharedInstance()
        // `.record` rather than `.playAndRecord`: this is composer
        // dictation, not a call, and holding the playback route would
        // duck whatever else is on the phone for no reason.
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let engine = AVAudioEngine()
        // Keep the engine on self before start() so a throw still has
        // something for teardown to remove the tap from. A local engine
        // that fails to start would leave tapInstalled true and the next
        // teardown would removeTap on a new engine that has none — which
        // is an exception, not a no-op.
        audioEngine = engine

        // The tap format is only valid after the session is active.
        // Installing against a 0-channel format is the usual "it works
        // in the sample and fails here" failure.
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0 else {
            throw CaptureError.silentInput
        }
        guard format.sampleRate > 0 else { throw CaptureError.silentInput }
        let directory = try RecordingFeed.directory()
        let url = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("caf")
        try feed.open(url: url, format: format)
        recordingURL = url
        startedAt = Date()
        inputName = session.currentRoute.inputs.first?.portName ?? "Microphone"
        try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [feed] buffer, _ in
            feed.append(buffer)
            MicLevel.measure(buffer)
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()

        stopping = false
        isListening = true

        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        beginRecognition(generation: gen)
        healthTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self, self.isListening else { return }
                self.checkCaptureHealth()
            }
        }
    }

    private func beginRecognition(generation gen: Int) {
        guard let recognizer, isListening else { return }
        segment += 1
        let currentSegment = segment
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        recognitionRequest = request
        feed.route(request)
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, recognitionError in
            Task { @MainActor in
                self?.handle(
                    segment: currentSegment,
                    result: result,
                    recognitionError: recognitionError,
                    generation: gen
                )
            }
        }
        segmentTask?.cancel()
        segmentTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(50))
            guard !Task.isCancelled, let self, self.isListening else { return }
            self.rotateRecognition(generation: gen)
        }
    }

    private func rotateRecognition(generation gen: Int) {
        // Audio remains continuous on disk while speech starts a fresh task.
        let oldRequest = recognitionRequest
        let oldTask = recognitionTask
        let oldSegment = segment
        if let oldTask { drainingTasks[oldSegment] = oldTask }
        beginRecognition(generation: gen)
        oldRequest?.endAudio()
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard let self, self.generation == gen else { return }
            self.drainingTasks.removeValue(forKey: oldSegment)?.cancel()
        }
    }

    private func handle(
        segment callbackSegment: Int,
        result: SFSpeechRecognitionResult?,
        recognitionError: Error?,
        generation gen: Int
    ) {
        // A cancelled task can still deliver a partial or a 209 after the
        // next session has already started. `isListening` is true then too,
        // so generation is what keeps this callback from rewriting the
        // new draft or stopping the new capture.
        guard gen == generation, !stopping, isListening || isFinishing else { return }
        if let result {
            spoken.apply(
                segment: callbackSegment,
                text: result.bestTranscription.formattedString,
                endsUtterance: result.speechRecognitionMetadata != nil
            )
            transcript = spoken.text
            if Date().timeIntervalSince(lastCheckpoint) > 2 {
                checkpoint()
                lastCheckpoint = Date()
            }
            // Finalization ends one speech task, never the recording.
            if result.isFinal {
                guard callbackSegment == segment else { return }
                if isFinishing {
                    if drainingTasks.isEmpty { finish() }
                } else { rotateRecognition(generation: gen) }
                return
            }
        }
        guard callbackSegment == segment, let recognitionError else { return }
        let ns = recognitionError as NSError
        // Speech uses separate internal domains for local-recognizer and
        // assistant cancellation. Keep the observed codes scoped to their
        // domains: other values (notably assistant 1110, no speech) are real
        // recognition failures and should remain visible.
        if isFinishing { finish(); return }
        if ns.domain == "kAFAssistantErrorDomain", ns.code == 1110 {
            // Silence is not a stop command. Keep the audio, re-arm speech.
            rotateRecognition(generation: gen)
            return
        }
        if Self.cancellationCodes[ns.domain]?.contains(ns.code) == true { return }
        self.error = "Live transcription paused. Audio is still recording; stop and resume to retry."
        feed.route(nil)
        segmentTask?.cancel()
    }

    private func teardown() {
        segmentTask?.cancel()
        healthTask?.cancel()
        drainingTasks.values.forEach { $0.cancel() }
        drainingTasks.removeAll()
        feed.route(nil)
        feed.close()
        MicLevel.reset()
        // Drop the tap before ending the request: a buffer that arrives
        // after endAudio() can fail the task instead of being ignored.
        if let engine = audioEngine {
            if tapInstalled {
                engine.inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
            if engine.isRunning { engine.stop() }
        }
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        audioEngine = nil
        recognizer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    #if DEBUG
    // Synthetic audio fixture: exercises real encoding, persistence and native
    // controls without opening a microphone or requesting Speech permissions.
    private func startPreview(generation gen: Int) {
        do {
            let url = try RecordingFeed.directory().appendingPathComponent(UUID().uuidString).appendingPathExtension("caf")
            let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
            try feed.open(url: url, format: format)
            recordingURL = url
            startedAt = Date()
            inputName = "Fixture microphone"
            stopping = false
            isStarting = false
            isListening = true
            previewTask = Task { [weak self] in
                for tick in 0..<120 {
                    guard !Task.isCancelled, let self, self.generation == gen, self.isListening else { return }
                    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 24_000)!
                    buffer.frameLength = 24_000
                    for frame in 0..<24_000 {
                        buffer.floatChannelData![0][frame] = tick % 3 == 1 ? 0 : Float(sin(Double(frame) * 2 * .pi * 440 / 48_000)) * 0.08
                    }
                    self.feed.append(buffer)
                    self.spoken.apply(segment: 1, text: tick < 2 ? "Take your time" : "Take your time. The meeting starts slowly.")
                    self.transcript = self.spoken.text
                    self.checkCaptureHealth()
                    try? await Task.sleep(for: .milliseconds(500))
                }
                self?.stop()
            }
        } catch {
            isStarting = false
            self.error = "Fixture recording failed."
        }
    }
    #endif

    private enum CaptureError: Error {
        case silentInput
        case noRecognizer
    }

    static let speechDeniedMessage: LocalizedStringKey =
        "Dictation needs Speech Recognition access. Enable it in Settings → BOS."
    static let micDeniedMessage: LocalizedStringKey =
        "Dictation needs Microphone access. Enable it in Settings → BOS."
}

/// How loud the mic is right now, 0...1, for the empty thread's mascot to
/// pulse with. Not published: it changes with every buffer, and the only
/// reader is a canvas that is already drawing each frame.
enum MicLevel {
    private static let lock = NSLock()
    private static var value: Float = 0

    static var current: Float {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    static func reset() {
        lock.lock(); value = 0; lock.unlock()
    }

    /// RMS of the first channel, mapped from about -50...-10 dB onto 0...1.
    static func measure(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        let rms = (sum / Float(count)).squareRoot()
        let db = 20 * log10(max(rms, 1e-6))
        let level = min(max((db + 50) / 40, 0), 1)
        lock.lock(); value = level; lock.unlock()
    }
}
