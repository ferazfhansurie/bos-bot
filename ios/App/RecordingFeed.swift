import AVFoundation
import Speech

/// The audio tap and speech-task rotation share only this small locked bridge.
/// Audio is retained independently of speech availability and partial results.
final class RecordingFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var writeFailure = false

    static func directory() throws -> URL {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                              appropriateFor: nil, create: true)
            .appendingPathComponent("Recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return root
    }

    func open(url: URL, format: AVAudioFormat) throws {
        let file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ], commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        lock.lock(); defer { lock.unlock() }
        self.file = file
        writeFailure = false
    }

    func route(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock(); defer { lock.unlock() }
        self.request = request
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        do { try file?.write(from: buffer) } catch { writeFailure = true }
        request?.append(buffer)
    }

    var failed: Bool {
        lock.lock(); defer { lock.unlock() }
        return writeFailure
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        file = nil
    }
}
