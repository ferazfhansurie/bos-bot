import Foundation
import CryptoKit

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
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
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

    static func storeMood(_ data: Data, for senderID: String, mood: String) {
        guard let url = moodURL(for: senderID, mood: mood) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    /// The mood face when there is one, else the plain avatar.
    static func bestURL(for senderID: String, mood: String) -> URL? {
        if let mood = moodURL(for: senderID, mood: mood), FileManager.default.fileExists(atPath: mood.path) { return mood }
        return url(for: senderID)
    }
}
