import Foundation
import Combine

public struct PendingSharedFile: Identifiable, Sendable {
    public let id: UUID
    public let name: String
    public let mime: String
    public let data: Data
    public init(id: UUID = UUID(), name: String, mime: String, data: Data) {
        self.id = id; self.name = name; self.mime = mime; self.data = data
    }
}

/// Owned by the conversation, not a screen. A send can finish while another
/// chat is open; subscribers see the same files, receipt and recovery state.
@MainActor public final class SharedDeliveryDraft: ObservableObject {
    @Published public var text: String { didSet { saveText?(text); checkpoint() } }
    @Published public var files: [PendingSharedFile] = [] { didSet { checkpoint() } }
    @Published public var reply: SharedChatMessage? { didSet { checkpoint() } }
    @Published public private(set) var sending = false
    @Published public private(set) var sent = false
    @Published public private(set) var error: String?
    private var previous: SharedSendDraft?
    private var previousID: String?
    private var uploads: [UUID: SharedAttachment] = [:]
    private let disk: SharedDraftDisk?
    private var batchingPersistence = false
    private var restorationFailed = false
    private var storageError: String?
    private let saveText: ((String) -> Void)?

    public init(text: String = "", directory: URL? = nil, saveText: ((String) -> Void)? = nil) {
        self.text = text; self.saveText = saveText
        disk = directory.map { SharedDraftDisk(directory: $0) }
        do {
            if let (archive, files) = try disk?.load() {
                self.text = archive.text; self.files = files; reply = archive.reply
                previous = archive.previous; previousID = archive.previousID; uploads = archive.uploads
                if previousID != nil { error = "An earlier send was interrupted. Review it and retry to confirm delivery." }
            }
        } catch {
            restorationFailed = true
            storageError = "Couldn’t restore this draft. Its saved files have been kept."
            self.error = storageError
        }
    }
    private func save() throws {
        guard !restorationFailed else { throw CocoaError(.fileReadCorruptFile) }
        try disk?.save(SharedDraftArchive(text: text, files: files.map { .init(id: $0.id, name: $0.name, mime: $0.mime) },
            reply: reply, previous: previous, previousID: previousID, uploads: uploads), files: files)
    }
    private func checkpoint() {
        guard !batchingPersistence else { return }
        do { try save(); storageError = nil }
        catch { storageError = restorationFailed ? "Couldn’t restore this draft. Its saved files have been kept." : "Couldn’t save this draft on your phone. Free some storage before sending."; self.error = storageError }
    }
    public func edited() {
        // The composer also observes the programmatic clear after acceptance.
        if !sending && !(sent && text.isEmpty && files.isEmpty) { sent = false; error = storageError }
    }
    public func removeFile(_ id: UUID) { files.removeAll { $0.id == id }; edited() }
    public func send(upload: (PendingSharedFile) async throws -> SharedAttachment,
                     deliver: (SharedSendDraft, String, [SharedAttachment]) async throws -> Void) async -> Bool {
        let capturedFiles = files
        let snapshot = SharedSendDraft(text: text.trimmingCharacters(in: .whitespacesAndNewlines), fileIDs: capturedFiles.map(\.id), replyTo: reply?.id)
        guard !sending, !snapshot.text.isEmpty || !capturedFiles.isEmpty else { return false }
        let sendID = snapshot.sendID(retrying: previous, previousID: previousID)
        previous = snapshot; previousID = sendID
        sending = true; sent = false; error = nil
        defer { sending = false }
        do {
            try save() // Persist retry identity before any network side effect.
            var refs: [SharedAttachment] = []
            for file in capturedFiles {
                if let receipt = uploads[file.id] { refs.append(receipt); continue }
                let receipt = try await upload(file)
                uploads[file.id] = receipt
                try save()
                refs.append(receipt)
            }
            try await deliver(snapshot, sendID, refs)
            batchingPersistence = true
            if text.trimmingCharacters(in: .whitespacesAndNewlines) == snapshot.text { text = "" }
            files.removeAll { snapshot.fileIDs.contains($0.id) }
            uploads = uploads.filter { !snapshot.fileIDs.contains($0.key) }
            if reply?.id == snapshot.replyTo { reply = nil }
            previous = nil; previousID = nil; sent = true
            batchingPersistence = false
            // Keep the old receipt on disk if cleanup fails: a restored retry
            // can confirm the accepted send without executing it twice.
            do { try save() } catch { self.error = "Message sent, but local draft cleanup failed. Check storage before restarting." }
            return true
        } catch {
            self.error = "Couldn’t confirm this send. Your message and files are kept. " + error.localizedDescription
            return false
        }
    }
}
