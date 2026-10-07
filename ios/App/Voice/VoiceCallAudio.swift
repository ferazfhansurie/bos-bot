// A voice call's microphone and speaker.
//
// One AVAudioEngine for both directions, because Apple's voice processing
// (echo cancellation + noise suppression) works on the pair: the input node
// cancels whatever the output node is playing, which is what lets the caller
// talk over the bot without the bot hearing itself. The engine runs for the
// whole call; mute only stops frames from being sent, as on the desktop.
//
// Capture is resampled to 24 kHz mono and handed out in 2048-sample chunks
// (85 ms) as PCM16. Playback schedules each delta on a sample-accurate
// cursor so replies play gaplessly and so a barge-in knows exactly how much
// of an item was heard.
import AVFoundation
import CompanionCore

final class VoiceCallAudio: @unchecked Sendable {
    enum Failure: LocalizedError {
        case noInput
        var errorDescription: String? { "This phone has no microphone available right now." }
    }

    /// A captured 2048-sample chunk as PCM16 LE, plus its loudness. Called
    /// off the main thread.
    var onCapture: ((Data, Float) -> Void)?
    /// Loudness of what the speaker is playing. Called off the main thread.
    var onSpeakerLevel: ((Float) -> Void)?
    /// The engine was rebuilt (route change, interruption): every scheduled
    /// sample is gone and the playback clock restarted. Called on main.
    var onReset: (() -> Void)?

    static let rate = RealtimeVoice.sampleRate
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let chimes = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: VoiceCallAudio.rate, channels: 1, interleaved: false)!

    // Tap-thread state.
    private var converter: AVAudioConverter?
    private var pending: [Float] = []

    // Main-thread state.
    private var cursor: AVAudioFramePosition = 0
    private var running = false
    private var observers: [NSObjectProtocol] = []

    init() {
        engine.attach(player)
        engine.attach(chimes)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.connect(chimes, to: engine.mainMixerNode, format: format)
    }

    // MARK: Lifecycle

    /// Configure the session and start capturing. Call from main.
    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)
        // Voice processing must be on before the engine starts. The simulator
        // (and some routes) refuse it; the call still works, just without AEC.
        try? engine.inputNode.setVoiceProcessingEnabled(true)
        try installCapture()
        installSpeakerTap()
        engine.prepare()
        try engine.start()
        player.play()
        chimes.play()
        cursor = 0
        running = true
        observe()
    }

    /// Stop everything and give the audio session back. Call from main.
    func stop() {
        guard running else { return }
        running = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        engine.inputNode.removeTap(onBus: 0)
        player.removeTap(onBus: 0)
        player.stop()
        chimes.stop()
        engine.stop()
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func installCapture() throws {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.channelCount > 0, inFormat.sampleRate > 0 else { throw Failure.noInput }
        let converter = AVAudioConverter(from: inFormat, to: format)
        converter?.downmix = true
        self.converter = converter
        pending = []
        let size = AVAudioFrameCount(max(1024, inFormat.sampleRate / 10))
        input.installTap(onBus: 0, bufferSize: size, format: inFormat) { [weak self] buffer, _ in
            self?.capture(buffer)
        }
    }

    private func installSpeakerTap() {
        player.removeTap(onBus: 0)
        player.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let channel = buffer.floatChannelData?[0] else { return }
            let level = RealtimeVoice.rms(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
            self.onSpeakerLevel?(level)
        }
    }

    /// Route changes and interruptions stop the engine underneath us; bring
    /// it back with the new hardware format.
    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restart()
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended
            else { return }
            self?.restart()
        })
    }

    private func restart() {
        guard running else { return }
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(true)
        do {
            try installCapture()
            installSpeakerTap()
            engine.prepare()
            try engine.start()
            player.play()
            chimes.play()
        } catch {
            // Leave it stopped; the call keeps its socket and the next route
            // change gets another try.
        }
        cursor = 0
        onReset?()
    }

    // MARK: Capture

    private func capture(_ buffer: AVAudioPCMBuffer) {
        guard let converter, buffer.frameLength > 0 else { return }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.floatChannelData?[0], out.frameLength > 0 else { return }
        pending.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
        let size = RealtimeVoice.frameSize
        while pending.count >= size {
            let chunk = Array(pending[0..<size])
            pending.removeFirst(size)
            let level = RealtimeVoice.rms(chunk)
            onCapture?(RealtimeVoice.pcm16(from: chunk), level)
        }
    }

    // MARK: Playback

    /// Where the speaker is right now, in 24 kHz samples since the playback
    /// clock last started.
    var now: AVAudioFramePosition {
        guard let nodeTime = player.lastRenderTime, nodeTime.isSampleTimeValid,
              let time = player.playerTime(forNodeTime: nodeTime)
        else { return 0 }
        return time.sampleTime
    }

    /// True while scheduled speech has not finished playing.
    var isPlaying: Bool { running && cursor > now }

    /// Queue samples right after whatever is already queued. Returns the
    /// span they will occupy on the playback clock.
    func schedule(_ samples: [Float]) -> (start: AVAudioFramePosition, end: AVAudioFramePosition)? {
        guard running, !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0]
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
        let current = now
        // A short pre-roll when the queue ran dry, so the first buffer is
        // never scheduled in the past and clipped.
        let start = cursor > current ? cursor : current + AVAudioFramePosition(Self.rate * 0.04)
        player.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: start, atRate: Self.rate))
        cursor = start + AVAudioFramePosition(samples.count)
        return (start, cursor)
    }

    /// Drop everything queued, at once. The playback clock restarts at zero.
    func dropScheduled() {
        guard running else { return }
        player.stop()
        player.play()
        cursor = 0
    }

    func playChime(rising: Bool) {
        guard running, let buffer = Self.chime(rising: rising, format: format) else { return }
        chimes.scheduleBuffer(buffer, at: nil)
    }

    /// The two-note chime: sine, 6 ms attack, (1 - t/dur)^2 decay, gain 0.16.
    static func chime(rising: Bool, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let notes: [(Double, Double)] = rising ? [(659.25, 0.09), (987.77, 0.15)] : [(987.77, 0.09), (659.25, 0.15)]
        let rate = format.sampleRate
        let total = notes.reduce(0) { $0 + Int($1.1 * rate) }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)),
              let channel = buffer.floatChannelData?[0]
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(total)
        var offset = 0
        for (freq, dur) in notes {
            let count = Int(dur * rate)
            for i in 0..<count {
                let t = Double(i) / rate
                let attack = min(1, t / 0.006)
                let decay = pow(1 - t / dur, 2)
                channel[offset + i] = Float(sin(2 * .pi * freq * t) * attack * decay * 0.16)
            }
            offset += count
        }
        return buffer
    }
}
