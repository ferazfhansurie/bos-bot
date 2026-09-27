import Foundation

struct SharedDraftArchive: Codable {
    struct File: Codable {
        let id: UUID
        let name: String
        let mime: String
    }
    let text: String
    let files: [File]
    let reply: SharedChatMessage?
    let previous: SharedSendDraft?
    let previousID: String?
    let uploads: [UUID: SharedAttachment]
}

/// Small atomic manifest plus immutable payload files. Typing never rewrites
/// large attachments, and a crash cannot publish a manifest before its files.
struct SharedDraftDisk {
    let directory: URL
    private var manifest: URL { directory.appendingPathComponent("draft.json") }
    func load() throws -> (SharedDraftArchive, [PendingSharedFile])? {
        guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
        let archive = try JSONDecoder().decode(SharedDraftArchive.self, from: Data(contentsOf: manifest))
        guard archive.files.count <= 4 else { throw CocoaError(.fileReadCorruptFile) }
        let files = try archive.files.map { file in
            let data = try Data(contentsOf: payload(file.id))
            guard !data.isEmpty, data.count <= 25 * 1024 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
            return PendingSharedFile(id: file.id, name: file.name, mime: file.mime, data: data)
        }
        return (archive, files)
    }
    func save(_ archive: SharedDraftArchive, files: [PendingSharedFile]) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for file in files where !manager.fileExists(atPath: payload(file.id).path) {
            try write(file.data, to: payload(file.id))
        }
        try write(JSONEncoder().encode(archive), to: manifest)
        // Delete only our obsolete UUID payloads after the new manifest commits.
        let retained = Set(files.map { $0.id.uuidString })
        for url in try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            if UUID(uuidString: url.lastPathComponent) != nil && !retained.contains(url.lastPathComponent) {
                try? manager.removeItem(at: url)
            }
        }
    }
    private func payload(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString) }
    private func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
