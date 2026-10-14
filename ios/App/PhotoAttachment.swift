import CompanionCore
import ImageIO
import UniformTypeIdentifiers

/// Photos are chat media. Documents imported from Files retain their original bytes.
enum PhotoAttachment {
    enum Failure: LocalizedError {
        case unsupported
        var errorDescription: String? { "That photo couldn't be prepared." }
    }

    /// ImageIO decodes only the useful thumbnail, never a full-resolution UIImage
    /// on the main actor. Animated and transparent supported images stay intact.
    static func make(from raw: Data, name: String) async throws -> PendingMessageAttachment {
        let worker = Task.detached(priority: .userInitiated) {
            try prepare(raw, name: name)
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: { worker.cancel() }
    }

    private static func prepare(_ raw: Data, name: String) throws -> PendingMessageAttachment {
        try Task.checkCancellation()
        guard let source = CGImageSourceCreateWithData(raw as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let typeIdentifier = CGImageSourceGetType(source),
              let type = UTType(typeIdentifier as String) else { throw Failure.unsupported }
        let mime = type.preferredMIMEType.map(AttachmentPolicy.normalizedMIME)
        let supported = mime.map(AttachmentPolicy.imageMIMETypes.contains) ?? false
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let width = properties[kCGImagePropertyPixelWidth] as? Int ?? 0
        let height = properties[kCGImagePropertyPixelHeight] as? Int ?? 0
        let animated = CGImageSourceGetCount(source) > 1
        let alpha = properties[kCGImagePropertyHasAlpha] as? Bool ?? false
        let maxDimension = 2560
        if supported && (animated || alpha || (max(width, height) <= maxDimension && raw.count <= 2 * 1024 * 1024)) {
            return attachment(raw, name: name, ext: type.preferredFilenameExtension ?? "jpg", mime: mime!)
        }
        // Do not flatten an unsupported animated image into its first frame.
        guard !animated else { throw Failure.unsupported }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Failure.unsupported
        }
        try Task.checkCancellation()
        let output = NSMutableData()
        let outputType = alpha ? UTType.png : UTType.jpeg
        guard let destination = CGImageDestinationCreateWithData(output, outputType.identifier as CFString, 1, nil) else {
            throw Failure.unsupported
        }
        // Thumbnail transform has baked in orientation; retain useful camera/date
        // metadata while updating the pixel dimensions and orientation tags.
        var metadata = properties
        metadata[kCGImagePropertyOrientation] = 1
        metadata[kCGImagePropertyPixelWidth] = thumbnail.width
        metadata[kCGImagePropertyPixelHeight] = thumbnail.height
        if var exif = metadata[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            exif[kCGImagePropertyExifPixelXDimension] = thumbnail.width
            exif[kCGImagePropertyExifPixelYDimension] = thumbnail.height
            metadata[kCGImagePropertyExifDictionary] = exif
        }
        if var tiff = metadata[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            tiff[kCGImagePropertyTIFFOrientation] = 1
            metadata[kCGImagePropertyTIFFDictionary] = tiff
        }
        metadata[kCGImageDestinationLossyCompressionQuality] = 0.85
        CGImageDestinationAddImage(destination, thumbnail, metadata as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Failure.unsupported }
        try Task.checkCancellation()
        let data = output as Data
        // Recompression must earn its cost; preserve the original if smaller.
        if supported && data.count >= raw.count {
            return attachment(raw, name: name, ext: type.preferredFilenameExtension ?? "jpg", mime: mime!)
        }
        return attachment(data, name: name, ext: alpha ? "png" : "jpg", mime: alpha ? "image/png" : "image/jpeg")
    }

    private static func attachment(_ data: Data, name: String, ext: String, mime: String) -> PendingMessageAttachment {
        let stem = (name as NSString).deletingPathExtension
        return PendingMessageAttachment(id: UUID(), data: data,
            name: "\(stem.isEmpty ? "Photo" : stem).\(ext)", mime: mime, kind: .image)
    }
}
