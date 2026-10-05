import Foundation

/// Bot/legacy-room drafts share the atomic manifest and immutable payload
/// store used by shared rooms. The manifest text carries typed bot metadata.
public final class BotDraft {
    private struct Snapshot: Codable, Equatable {
        let text: String
        let fileIDs: [UUID]
        let replyID: String?
        let priority: String
    }
    private struct Metadata: Codable {
        var text: String
        var reply: Message?
        var imageIDs: Set<UUID>
        var previous: Snapshot?
        var sendID: String?
        var composerText: String?
    }
    public var text = ""
    public var files: [PendingMessageAttachment] = []
    public var reply: Message?
    public private(set) var error: String?
    private let disk: SharedDraftDisk
    private var previous: Snapshot?
    private var sendID: String?
    private var composerText: String?
    private var restorationFailed = false

    public init(directory: URL) {
        disk = SharedDraftDisk(directory: directory)
        do {
            if let (archive, files) = try disk.load() {
                let meta = try JSONDecoder().decode(Metadata.self, from: Data(archive.text.utf8))
                text = meta.text; reply = meta.reply; previous = meta.previous
                sendID = meta.sendID; composerText = meta.composerText
                self.files = files.map { .init(id: $0.id, data: $0.data, name: $0.name, mime: $0.mime, kind: meta.imageIDs.contains($0.id) ? .image : .file) }
                if sendID != nil { error = "An earlier send was interrupted. Review it and retry to confirm delivery." }
            }
        } catch {
            restorationFailed = true
            self.error = "Couldn’t restore this draft. Its saved files have been kept."
        }
    }
    public func checkpoint() throws {
        guard !restorationFailed else { throw CocoaError(.fileReadCorruptFile) }
        do {
            let meta = Metadata(text: text, reply: reply, imageIDs: Set(files.filter { $0.kind == .image }.map(\.id)), previous: previous, sendID: sendID, composerText: composerText)
            let encoded = String(decoding: try JSONEncoder().encode(meta), as: UTF8.self)
            try disk.save(.init(text: encoded, files: files.map { .init(id: $0.id, name: $0.name, mime: $0.mime) }, reply: nil, previous: nil, previousID: nil, uploads: [:]), files: files.map { .init(id: $0.id, name: $0.name, mime: $0.mime, data: $0.data) })
            error = nil
        } catch {
            self.error = "Couldn’t save this draft. Check storage before sending."
            throw error
        }
    }
    /// Must commit before invoking any network operation. No upload receipt
    /// cache is claimed: stable attachment UUIDs request server deduplication.
    public func prepareSend(text: String, priority: MessagePriority) throws -> String {
        let snapshot = Snapshot(text: text, fileIDs: files.map(\.id), replyID: reply?.id, priority: priority.rawValue)
        if previous != snapshot || composerText != self.text { sendID = UUID().uuidString }
        previous = snapshot; composerText = self.text
        try checkpoint()
        return sendID!
    }
    public func complete(sendID accepted: String) {
        guard sendID == accepted, let previous else { return }
        if text == composerText { text = "" }
        files.removeAll { previous.fileIDs.contains($0.id) }
        if reply?.id == previous.replyID { reply = nil }
        self.previous = nil; self.sendID = nil; composerText = nil
        do { try checkpoint() } catch { self.error = "Message sent, but local draft cleanup failed. Check storage before restarting." }
    }
}
