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
