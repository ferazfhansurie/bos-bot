import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import CompanionCore

@main struct MediaPreparationChecks {
    static func fixture(width: Int, height: Int, alpha: Bool = false, type: UTType = .jpeg, frames: Int = 1) -> Data {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i] = UInt8(truncatingIfNeeded: i * 17 + i / 512)
            pixels[i + 1] = UInt8(truncatingIfNeeded: i * 31 + i / 1024)
            pixels[i + 2] = UInt8(truncatingIfNeeded: i * 53 + i / 2048)
            pixels[i + 3] = alpha ? 128 : 255
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: alpha ? CGImageAlphaInfo.last.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, frames, nil)!
        for _ in 0..<frames {
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 1,
                kCGImagePropertyOrientation: 6,
                kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFDateTime: "2026:10:14 12:00:00"]] as CFDictionary)
        }
        precondition(CGImageDestinationFinalize(destination))
        return data as Data
    }

    static func main() async throws {
        let large = fixture(width: 4000, height: 2400)
        let result = try await PhotoAttachment.make(from: large, name: "Photo 1")
        let source = CGImageSourceCreateWithData(result.data as CFData, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary
        let width = props[kCGImagePropertyPixelWidth] as! Int
        let height = props[kCGImagePropertyPixelHeight] as! Int
        precondition(width == 1536 && height == 2560, "orientation and useful resolution")
        precondition(result.bytes < large.count && result.mime == "image/jpeg" && result.name == "Photo 1.jpg")
        let tiff = props[kCGImagePropertyTIFFDictionary] as! NSDictionary
        precondition(tiff[kCGImagePropertyTIFFDateTime] as? String == "2026:10:14 12:00:00")
        let small = fixture(width: 120, height: 80)
        let smallResult = try await PhotoAttachment.make(from: small, name: "Photo")
        precondition(smallResult.data == small)
        let transparent = fixture(width: 120, height: 80, alpha: true, type: .png)
        let transparentResult = try await PhotoAttachment.make(from: transparent, name: "Photo")
        precondition(transparentResult.data == transparent)
        let animated = fixture(width: 120, height: 80, type: .gif, frames: 2)
        let animatedResult = try await PhotoAttachment.make(from: animated, name: "Photo")
        precondition(animatedResult.data == animated)
        do {
            _ = try await PhotoAttachment.make(from: Data("not an image".utf8), name: "Photo")
            fatalError("invalid image accepted")
        } catch PhotoAttachment.Failure.unsupported { }
        let movie = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { try? FileManager.default.removeItem(at: movie) }
        let original = Data(repeating: 17, count: 13 * 1024 * 1024)
        try original.write(to: movie)
        let file = try await VideoAttachment.make(from: movie, name: "Original.mp4", optimizeForUpload: false)
        precondition(file.bytes == original.count && file.fileURL != movie)
        let copied = try Data(contentsOf: file.fileURL!)
        precondition(copied == original)
        print("media checks passed: oriented jpeg \(large.count) -> \(result.bytes) bytes; small/alpha/animation exact; invalid rejected; Files video exact")
    }
}
