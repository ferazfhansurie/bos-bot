// The last roster, on disk, per paired computer — so a cold launch opens on
// the person's conversations instead of an empty list while the stream
// dials. What is kept, and what is scrubbed, is `CachedRoster`'s business.
//
// Caches rather than Application Support: the system may purge it, which
// costs one empty launch, and it is never backed up — transcripts stay on
// this phone. Protection matches the device token's keychain class, so the
// file opens exactly when a restore could use it. Reads are synchronous
// because launch wants the roster before the first frame; writes and
// removals share one serial queue, so forgetting a computer cannot be
// overtaken by a save that was already in flight.
import CompanionCore
import CryptoKit
import Foundation
import OSLog

private let log = Logger(subsystem: "com.openmausbot.companion", category: "roster-cache")

enum RosterCache {
    private static let queue = DispatchQueue(label: "com.openmausbot.companion.roster-cache", qos: .utility)

    static func load(for connectionID: String) -> CachedRoster? {
        guard let url = fileURL(for: connectionID),
              let data = try? Data(contentsOf: url),
              let roster = try? JSONDecoder().decode(CachedRoster.self, from: data),
              !roster.isEmpty
        else { return nil }
        return roster
    }

    static func save(_ roster: CachedRoster, for connectionID: String) {
        guard !roster.isEmpty, let url = fileURL(for: connectionID) else { return }
        queue.async {
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try JSONEncoder().encode(roster).write(
                    to: url,
                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
                )
            } catch {
                log.error("roster cache write failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    static func remove(for connectionID: String) {
        guard let url = fileURL(for: connectionID) else { return }
        queue.async { try? FileManager.default.removeItem(at: url) }
    }

    /// Connection ids are opaque; hashing keeps them out of path syntax.
    private static func fileURL(for connectionID: String) -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        let name = SHA256.hash(data: Data(connectionID.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return caches
            .appendingPathComponent("roster", isDirectory: true)
            .appendingPathComponent("\(name).json")
    }
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data
