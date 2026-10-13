import Foundation

struct SharedDraftArchive: Codable {
    struct File: Codable {
        let id: UUID
        let name: String
        let mime: String
        var fileBacked: Bool? = nil
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
    func loadBot() throws -> (SharedDraftArchive, [PendingMessageAttachment])? {
        guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
        let archive = try JSONDecoder().decode(SharedDraftArchive.self, from: Data(contentsOf: manifest))
        guard archive.files.count <= AttachmentPolicy.maximumItems else { throw CocoaError(.fileReadCorruptFile) }
        var total = 0
        var bufferedTotal = 0
        // Check every file before loading any image/document bytes.
        for file in archive.files {
            let size = try payload(file.id).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= AttachmentPolicy.maximumFileBytes,
                  size <= AttachmentPolicy.maximumTotalBytes - total else { throw CocoaError(.fileReadCorruptFile) }
            total += size
            if file.fileBacked != true {
                let limit = AttachmentPolicy.kind(forMIME: file.mime) == .image ? AttachmentPolicy.maximumImageBytes : AttachmentPolicy.maximumBufferedFileBytes
                guard size <= limit, size <= AttachmentPolicy.maximumInMemoryBytes - bufferedTotal else { throw CocoaError(.fileReadCorruptFile) }
                bufferedTotal += size
            }
        }
        let files = try archive.files.map { file in
            if file.fileBacked == true {
                // Keep an owned snapshot alive even if a later checkpoint
                // removes this payload while the captured send is retrying.
                return try PendingMessageAttachment(id: file.id, copying: payload(file.id), name: file.name, mime: file.mime)
            }
            return PendingMessageAttachment(id: file.id, data: try Data(contentsOf: payload(file.id)), name: file.name, mime: file.mime,
                                            kind: AttachmentPolicy.kind(forMIME: file.mime) ?? .file)
        }
        try AttachmentPolicy.validate(files)
        return (archive, files)
    }
    func saveBot(_ archive: SharedDraftArchive, files: [PendingMessageAttachment]) throws {
        try AttachmentPolicy.validate(files)
        guard files.allSatisfy({ $0.bytes > 0 }) else { throw CocoaError(.fileReadCorruptFile) }
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for file in files where !manager.fileExists(atPath: payload(file.id).path) {
            if let source = file.fileURL {
                let staging = directory.appendingPathComponent("partial-\(UUID().uuidString)")
                defer { try? manager.removeItem(at: staging) }
                let count = try copyAttachmentFile(source, to: staging, limit: AttachmentPolicy.maximumFileBytes)
                guard count == file.bytes else { throw CocoaError(.fileReadCorruptFile) }
                try manager.moveItem(at: staging, to: payload(file.id))
            } else { try write(file.data, to: payload(file.id)) }
        }
        try write(JSONEncoder().encode(archive), to: manifest)
        let retained = Set(files.map { $0.id.uuidString })
        for url in try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            if UUID(uuidString: url.lastPathComponent) != nil && !retained.contains(url.lastPathComponent) {
                try? manager.removeItem(at: url)
            }
        }
    }
    func load() throws -> (SharedDraftArchive, [PendingSharedFile])? {
        guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
        let archive = try JSONDecoder().decode(SharedDraftArchive.self, from: Data(contentsOf: manifest))
        guard archive.files.count <= AttachmentPolicy.maximumItems else { throw CocoaError(.fileReadCorruptFile) }
        var total = 0
        for file in archive.files {
            let size = try payload(file.id).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= AttachmentPolicy.maximumBufferedFileBytes,
                  size <= SharedDeliveryDraft.maximumTotalBytes - total else { throw CocoaError(.fileReadCorruptFile) }
            total += size
        }
        let files = try archive.files.map { file in
            let data = try Data(contentsOf: payload(file.id))
            guard !data.isEmpty, data.count <= AttachmentPolicy.maximumBufferedFileBytes else { throw CocoaError(.fileReadCorruptFile) }
            return PendingSharedFile(id: file.id, name: file.name, mime: file.mime, data: data)
        }
        return (archive, files)
    }
    func save(_ archive: SharedDraftArchive, files: [PendingSharedFile]) throws {
        guard files.count <= AttachmentPolicy.maximumItems,
              files.allSatisfy({ !$0.data.isEmpty && $0.data.count <= AttachmentPolicy.maximumBufferedFileBytes }),
              files.reduce(0, { $0 + $1.data.count }) <= SharedDeliveryDraft.maximumTotalBytes else { throw CocoaError(.fileWriteOutOfSpace) }
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
