import Foundation
import CryptoKit

/// Where one account's cloud state lives on disk. Every account gets its
/// own folder named by `CloudAccountKey.namespace`, excluded from backup and
/// file-protected; nothing from one account is readable through another's
/// store, and logout erases the folder.
public struct CloudAccountStore: Sendable {
    public let account: CloudAccountKey
    public let folder: URL

    public init(root: URL, account: CloudAccountKey) {
        self.account = account
        folder = root.appendingPathComponent("cloud", isDirectory: true).appendingPathComponent(account.namespace, isDirectory: true)
    }

    var outboxFile: URL { folder.appendingPathComponent("outbox.json") }
    var discoveryFile: URL { folder.appendingPathComponent("discovery.json") }
    var windowsFile: URL { folder.appendingPathComponent("windows.json") }
    var roomsFolder: URL { folder.appendingPathComponent("rooms", isDirectory: true) }
    public var attachmentsFolder: URL { folder.appendingPathComponent("attachments", isDirectory: true) }

    func roomFile(workspaceId: String, roomId: String) -> URL {
        let scope = (try? JSONEncoder().encode([workspaceId, roomId])) ?? Data()
        let key = SHA256.hash(data: scope).map { String(format: "%02x", $0) }.joined()
        return roomsFolder.appendingPathComponent(key + ".json")
    }

    public func loadOutbox() throws -> CloudOutbox? {
        guard let outbox = try load(CloudOutbox.self, from: outboxFile) else { return nil }
        // A file can only ever belong to the account its folder is named for.
        guard outbox.account == account else { throw CloudStoreError.wrongAccount }
        return outbox
    }

    public func save(_ outbox: CloudOutbox) throws {
        precondition(outbox.account == account, "outbox saved under another account")
        try write(outbox.persisted, to: outboxFile)
    }

    public func loadRoom(workspaceId: String, roomId: String) throws -> CloudRoomState? {
        guard let room = try load(CloudRoomState.self, from: roomFile(workspaceId: workspaceId, roomId: roomId)) else { return nil }
        guard room.workspaceId == workspaceId, room.roomId == roomId else { throw CloudStoreError.wrongAccount }
        return room
    }

    /// Guest rooms stay in session memory: saving one removes any copy.
    public func save(_ room: CloudRoomState) throws {
        guard room.role != .guest else { return try removeRoom(workspaceId: room.workspaceId, roomId: room.roomId) }
        try write(room, to: roomFile(workspaceId: room.workspaceId, roomId: room.roomId))
    }

    public func removeRoom(workspaceId: String, roomId: String) throws {
        let file = roomFile(workspaceId: workspaceId, roomId: roomId)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }

    /// The last discovery, so rooms list offline. Guest workspaces are
    /// session-only and never written.
    public func loadDiscovery() throws -> CloudDiscovery? {
        try load(CloudDiscovery.self, from: discoveryFile)
    }

    public func save(_ discovery: CloudDiscovery) throws {
        var members = discovery
        members.workspaces.removeAll { $0.role == .guest }
        try write(members, to: discoveryFile)
    }

    /// Signed send windows by workspace, so a send can be frozen offline.
    /// Windows for another account's namespace are dropped on load.
    public func loadWindows() throws -> [String: CloudSendWindow] {
        guard let windows = try load([String: CloudSendWindow].self, from: windowsFile) else { return [:] }
        return windows.filter { account.owns($0.value.namespace) && $0.value.namespace.workspaceId == $0.key }
    }

    public func save(windows: [String: CloudSendWindow], guestWorkspaces: Set<String>) throws {
        try write(windows.filter { !guestWorkspaces.contains($0.key) }, to: windowsFile)
    }

    /// Revocation or account switch: drops cached room content, discovery,
    /// windows and attachment bytes. The outbox stays, quarantined in this
    /// folder, so the same account can reconcile its sends on return.
    public func wipeCache() throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: folder.path) else { return }
        for item in try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) where item.lastPathComponent != outboxFile.lastPathComponent {
            try fm.removeItem(at: item)
        }
        if try fm.contentsOfDirectory(atPath: folder.path).isEmpty { try fm.removeItem(at: folder) }
    }

    /// Wipes every other account's cache under `root`, keeping only their
    /// quarantined outboxes. Run when an account's store opens.
    public static func wipeOtherAccounts(root: URL, except account: CloudAccountKey) throws {
        let cloud = root.appendingPathComponent("cloud", isDirectory: true)
        guard FileManager.default.fileExists(atPath: cloud.path) else { return }
        for item in try FileManager.default.contentsOfDirectory(at: cloud, includingPropertiesForKeys: nil) where item.lastPathComponent != account.namespace {
            try CloudAccountStore(folder: item, account: account).wipeCache()
        }
    }

    private init(folder: URL, account: CloudAccountKey) {
        self.folder = folder; self.account = account
    }

    /// Explicit logout: erases every app-managed byte for this account.
    public func erase() throws {
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }

    private func load<T: Decodable>(_ type: T.Type, from file: URL) throws -> T? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        // Corruption surfaces as an error rather than an empty queue, so an
        // unresolved send is never silently forgotten.
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: file))
    }

    private func write<T: Encodable>(_ value: T, to file: URL) throws {
        try prepare(file.deletingLastPathComponent())
        let data = try JSONEncoder().encode(value)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
    }

    private func prepare(_ directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var accountFolder = folder
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try accountFolder.setResourceValues(values)
    }
}

public enum CloudStoreError: Error, Equatable {
    case wrongAccount
}
