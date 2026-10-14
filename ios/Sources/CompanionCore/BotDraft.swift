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
        var pendingFileIDs: [UUID]?
        var pendingReply: Message?
        var handedOff: Bool?
    }
    public var text = ""
    public var files: [PendingMessageAttachment] = []
    public var reply: Message?
    public private(set) var error: String?
    private let disk: SharedDraftDisk
    private var previous: Snapshot?
    private var sendID: String?
    private var composerText: String?
    private var pendingFiles: [PendingMessageAttachment] = []
    private var pendingReply: Message?
    private var handedOff = false
    private var restorationFailed = false

    public init(directory: URL) {
        disk = SharedDraftDisk(directory: directory)
        do {
            if let (archive, files) = try disk.loadBot() {
                let meta = try JSONDecoder().decode(Metadata.self, from: Data(archive.text.utf8))
                text = meta.text; reply = meta.reply; previous = meta.previous
                sendID = meta.sendID; composerText = meta.composerText
                let pendingIDs = Set(meta.pendingFileIDs ?? [])
                pendingFiles = files.filter { pendingIDs.contains($0.id) }
                self.files = files.filter { !pendingIDs.contains($0.id) }
                pendingReply = meta.pendingReply; handedOff = meta.handedOff == true
                if sendID != nil {
                    // Recovery keeps the earlier payload visible alongside a
                    // newer unsent draft; neither is silently discarded.
                    if handedOff {
                        text = [composerText ?? previous?.text ?? "", text].filter { !$0.isEmpty }.joined(separator: "\n\n")
                        self.files = pendingFiles + self.files
                        reply = reply ?? pendingReply
                        handedOff = false
                    }
                    error = "An earlier send was interrupted. Review it and retry to confirm delivery."
                }
            }
        } catch {
            restorationFailed = true
            self.error = "Couldn’t restore this draft. Its saved files have been kept."
        }
    }
    public func checkpoint() throws {
        guard !restorationFailed else { throw CocoaError(.fileReadCorruptFile) }
        do {
            let retained = files + pendingFiles.filter { pending in !files.contains(where: { $0.id == pending.id }) }
            let meta = Metadata(text: text, reply: reply, imageIDs: Set(retained.filter { $0.kind == .image }.map(\.id)), previous: previous, sendID: sendID, composerText: composerText, pendingFileIDs: handedOff ? pendingFiles.map(\.id) : [], pendingReply: pendingReply, handedOff: handedOff)
            let encoded = String(decoding: try JSONEncoder().encode(meta), as: UTF8.self)
            try disk.saveBot(.init(text: encoded, files: retained.map { .init(id: $0.id, name: $0.name, mime: $0.mime, fileBacked: $0.fileURL != nil) }, reply: nil, previous: nil, previousID: nil, uploads: [:]), files: retained)
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
        // Scheduling preference can change after a lost response (the bot
        // became idle or the composer reset). It is not a new message.
        // Keep the saved priority field for archive compatibility, but match
        // retry identity only on content and the visible composer text.
        if sendID == nil || previous?.text != snapshot.text
            || previous?.fileIDs != snapshot.fileIDs || previous?.replyID != snapshot.replyID
            || composerText != self.text {
            sendID = UUID().uuidString
        }
        previous = snapshot; composerText = self.text
        pendingFiles = files; pendingReply = reply; handedOff = false
        try checkpoint()
        return sendID!
    }
    /// The pending bubble now owns this payload. New typing can be saved
    /// without deleting files that the upload or its retry still needs.
    public func handoff(sendID: String) throws {
        guard self.sendID == sendID else { return }
        text = ""; files = []; reply = nil; handedOff = true
        try checkpoint()
    }
    /// Restore a failed send only when the person has not started a new draft.
    @discardableResult public func restoreFailedSend(sendID: String) -> Bool {
        guard self.sendID == sendID, text.isEmpty, files.isEmpty, reply == nil else { return false }
        text = composerText ?? previous?.text ?? ""; files = pendingFiles; reply = pendingReply; handedOff = false
        try? checkpoint()
        return true
    }
    public func complete(sendID accepted: String) {
        guard sendID == accepted, let previous else { return }
        if !handedOff {
            if text == composerText { text = "" }
            files.removeAll { previous.fileIDs.contains($0.id) }
            if reply?.id == previous.replyID { reply = nil }
        }
        pendingFiles = []; pendingReply = nil; handedOff = false
        self.previous = nil; self.sendID = nil; composerText = nil
        do { try checkpoint() } catch { self.error = "Message sent, but local draft cleanup failed. Check storage before restarting." }
    }
}
