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

/// Keep clips that already fit and Files imports intact. Oversized Photos clips get one
/// upload-sized export, with a lower-resolution retry only if needed.
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

    static func make(from url: URL, name: String, optimizeForUpload: Bool = true) async throws -> PendingMessageAttachment {
        let worker = Task.detached(priority: .userInitiated) {
            try await prepare(from: url, name: name, optimizeForUpload: optimizeForUpload)
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: { worker.cancel() }
    }

    private static func prepare(from url: URL, name: String, optimizeForUpload: Bool) async throws -> PendingMessageAttachment {
        try Task.checkCancellation()
        let limit = AttachmentPolicy.maximumFileBytes
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? .max
        let type = UTType(filenameExtension: url.pathExtension)
        let originalMIME = type?.preferredMIMEType.map(AttachmentPolicy.normalizedMIME)
        let originalSupported = originalMIME.map(AttachmentPolicy.videoMIMETypes.contains) ?? false
        let originalFits = size <= limit && originalSupported
        func original() throws -> PendingMessageAttachment {
            try PendingMessageAttachment(id: UUID(), copying: url,
                name: fileName(name, type?.preferredFilenameExtension ?? "mov"), mime: originalMIME!)
        }
        // Copying and probing also happen off the main actor. Files are originals,
        // so only oversized Photos clips need an export. Clips that already fit
        // must not pay for a mandatory transcode before their upload can start.
        if originalFits { return try original() }
        if !optimizeForUpload { throw Failure.tooLong(name) }
        let asset = AVURLAsset(url: url)
        guard try await asset.load(.isExportable) else {
            if originalFits { return try original() }
            throw Failure.unreadable(name)
        }
        let duration = try await asset.load(.duration).seconds
        // Longer clips start at 720p instead of paying for a doomed 1080p export.
        let presets = duration > 120
            ? [AVAssetExportPreset1280x720, AVAssetExportPreset640x480]
            : [AVAssetExportPresetHEVC1920x1080, AVAssetExportPreset1280x720, AVAssetExportPreset640x480]
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
            session.metadata = (try? await asset.load(.metadata)) ?? []
            await withTaskCancellationHandler {
                await withCheckedContinuation { done in session.exportAsynchronously { done.resume() } }
            } onCancel: { session.cancelExport() }
            try Task.checkCancellation()
            guard session.status == .completed else { continue }
            let bytes = (try? out.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? .max
            guard bytes <= limit else { continue }
            if originalFits && bytes >= size { return try original() }
            return try PendingMessageAttachment(id: UUID(), copying: out, name: fileName(name, "mp4"), mime: "video/mp4")
        }
        if originalFits { return try original() }
        throw Failure.tooLong(name)
    }

    private static func fileName(_ name: String, _ ext: String) -> String {
        let stem = (name as NSString).deletingPathExtension
        return "\(stem.isEmpty ? "Video" : stem).\(ext)"
    }
}
