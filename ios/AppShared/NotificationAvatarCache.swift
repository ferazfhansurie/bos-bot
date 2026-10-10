import Foundation
import CryptoKit
import CoreGraphics
import ImageIO

enum NotificationAvatarCache {
    private static let group = "group.com.aihlete.aios.shared"

    static func url(for senderID: String) -> URL? {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        let digest = SHA256.hash(data: Data(senderID.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent("notification-avatars", isDirectory: true)
            .appendingPathComponent("\(digest).png")
    }

    static func store(_ data: Data, for senderID: String) {
        guard let url = url(for: senderID) else { return }
        write(data, to: url)
    }

    /// ImageRenderer hands back a fully transparent picture when the app
    /// draws from the background (a stream update while the phone is locked),
    /// and that blank used to replace a good face: banners showed an empty
    /// circle (2026-10-11). A blank is never kept; the last good face stays.
    @discardableResult
    static func write(_ data: Data, to url: URL) -> Bool {
        guard hasInk(data) else { return false }
        if (try? Data(contentsOf: url)) == data { return true }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    /// Whether a PNG has any visible pixel, checked on a 16×16 thumbnail.
    static func hasInk(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
        let side = 16
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let drew = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8,
                                          bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        return drew && stride(from: 3, to: pixels.count, by: 4).contains { pixels[$0] > 8 }
    }
}

extension NotificationAvatarCache {
    /// The sender's face in one mood (`NotificationMood`), drawn by the app
    /// ahead of time for bots that wear their mascot. Nil when not drawn.
    static func moodURL(for senderID: String, mood: String) -> URL? {
        guard let base = url(for: senderID) else { return nil }
        let stem = base.deletingPathExtension().lastPathComponent
        return base.deletingLastPathComponent().appendingPathComponent("\(stem)-\(mood).png")
    }

    @discardableResult
    static func storeMood(_ data: Data, for senderID: String, mood: String) -> Bool {
        guard let url = moodURL(for: senderID, mood: mood) else { return false }
        return write(data, to: url)
    }

    /// The mood face when there is one, else the plain avatar.
    static func bestURL(for senderID: String, mood: String) -> URL? {
        if let mood = moodURL(for: senderID, mood: mood), FileManager.default.fileExists(atPath: mood.path) { return mood }
        return url(for: senderID)
    }

    /// The face as bytes for an `INImage(imageData:)`, never a file URL: the
    /// process that draws the banner can't read the app group, so a URL image
    /// left a blank circle with only the app badge showing (2026-10-11).
    static func faceData(for senderID: String, mood: String) -> Data? {
        for url in [moodURL(for: senderID, mood: mood), url(for: senderID)] {
            // a blank drawn before blanks were refused is skipped, not shown
            if let url, let data = try? Data(contentsOf: url), hasInk(data) { return data }
        }
        return nil
    }
}
