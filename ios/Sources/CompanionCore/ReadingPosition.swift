import Foundation
import CryptoKit

/// A device-local observation, never the server's global unread boundary.
public struct ReadingPosition: Codable, Equatable, Sendable {
    public var anchorID: String?
    public var newestObservedID: String?
    public var anchorSequence: Int?
    public init(anchorID: String?, newestObservedID: String?, anchorSequence: Int? = nil) {
        self.anchorID = anchorID; self.newestObservedID = newestObservedID; self.anchorSequence = anchorSequence
    }
    public func retainedAnchor(in ids: [String]) -> String? {
        anchorID.flatMap { ids.contains($0) ? $0 : nil }
    }
    public func firstNewMessage(in ids: [String], unread: Bool) -> String? {
        guard unread, let newestObservedID, let index = ids.firstIndex(of: newestObservedID), index + 1 < ids.count else { return nil }
        return ids[index + 1]
    }
}

public struct ReadingPositionStore {
    private let file: URL
    public init(root: URL, connectionID: String, accountIdentity: String, conversationID: String, threadID: String) {
        // Length-preserving encoding prevents namespace collisions. Neither
        // the raw account identity nor bearer appears in the saved artifact.
        let scope = try! JSONEncoder().encode([connectionID, accountIdentity, conversationID, threadID])
        let key = SHA256.hash(data: scope).map { String(format: "%02x", $0) }.joined()
        file = root.appendingPathComponent(key + ".json")
    }
    public func load() throws -> ReadingPosition? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try JSONDecoder().decode(ReadingPosition.self, from: Data(contentsOf: file))
    }
    public func save(_ position: ReadingPosition) throws {
        // Preserve corruption for recovery, rather than treating it as empty.
        _ = try load()
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(position)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
