import AVFoundation
import CompanionCore
import CoreTransferable
import UniformTypeIdentifiers

/// A video picked from Photos, copied out of the picker's temporary file.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("picked-\(UUID().uuidString)")
                .appendingPathExtension(received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

/// Phone videos are far bigger than the 90 MB the upload route takes, so a
/// video is re-encoded to an mp4 the way a messaging app does: the best size
/// that fits, stepping down until it does.
enum VideoAttachment {
    enum Failure: LocalizedError {
        case unreadable(String)
        case tooLong(String)

        var errorDescription: String? {
            switch self {
            case let .unreadable(name): "\(name) couldn't be read as a video."
            case let .tooLong(name): "\(name) is too long to send. Trim it and try again."
            }
        }
    }

    static func make(from url: URL, name: String) async throws -> PendingMessageAttachment {
        try Task.checkCancellation()
        let limit = AttachmentPolicy.maximumFileBytes
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? .max
        let type = UTType(filenameExtension: url.pathExtension)
        // Already small enough and a format the mac takes: send it as it is.
        if size <= limit, let type, let mime = type.preferredMIMEType,
           AttachmentPolicy.videoMIMETypes.contains(AttachmentPolicy.normalizedMIME(mime)) {
            return try PendingMessageAttachment(id: UUID(), copying: url, name: fileName(name, type.preferredFilenameExtension ?? "mov"),
                                            mime: AttachmentPolicy.normalizedMIME(mime))
        }

        let asset = AVURLAsset(url: url)
        guard try await asset.load(.isExportable) else { throw Failure.unreadable(name) }
        let presets = [
            AVAssetExportPresetHEVC1920x1080,
            AVAssetExportPreset1280x720,
            AVAssetExportPreset960x540,
            AVAssetExportPreset640x480,
            AVAssetExportPresetMediumQuality,
            AVAssetExportPresetLowQuality,
        ]
        for preset in presets {
            try Task.checkCancellation()
            guard let session = AVAssetExportSession(asset: asset, presetName: preset),
                  session.supportedFileTypes.contains(.mp4) else { continue }
            // Skip the exports that clearly can't fit; the estimate is rough,
            // so anything near the line is still tried and measured.
            if session.estimatedOutputFileLength > Int64(limit) * 3 / 2 { continue }
            let out = FileManager.default.temporaryDirectory
                .appendingPathComponent("video-\(UUID().uuidString)").appendingPathExtension("mp4")
            defer { try? FileManager.default.removeItem(at: out) }
            session.outputURL = out
            session.outputFileType = .mp4
            session.shouldOptimizeForNetworkUse = true
            await withTaskCancellationHandler {
                await withCheckedContinuation { done in session.exportAsynchronously { done.resume() } }
            } onCancel: { session.cancelExport() }
            try Task.checkCancellation()
            guard session.status == .completed else { continue }
            let bytes = (try? out.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? .max
            guard bytes <= limit else { continue }
            return try PendingMessageAttachment(id: UUID(), copying: out, name: fileName(name, "mp4"), mime: "video/mp4")
        }
        throw Failure.tooLong(name)
    }

    private static func fileName(_ name: String, _ ext: String) -> String {
        let stem = (name as NSString).deletingPathExtension
        return "\(stem.isEmpty ? "Video" : stem).\(ext)"
    }
}
