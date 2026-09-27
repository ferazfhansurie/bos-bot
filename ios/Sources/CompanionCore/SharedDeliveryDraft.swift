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
    @Published public var text: String { didSet { saveText?(text) } }
    @Published public var files: [PendingSharedFile] = []
    @Published public var reply: SharedChatMessage?
    @Published public private(set) var sending = false
    @Published public private(set) var sent = false
    @Published public private(set) var error: String?
    private var previous: SharedSendDraft?
    private var previousID: String?
    private var uploads: [UUID: SharedAttachment] = [:]
    private let saveText: ((String) -> Void)?

    public init(text: String = "", saveText: ((String) -> Void)? = nil) { self.text = text; self.saveText = saveText }
    public func edited() {
        // The composer also observes the programmatic clear after acceptance.
        if !sending && !(sent && text.isEmpty && files.isEmpty) { sent = false; error = nil }
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
            var refs: [SharedAttachment] = []
            for file in capturedFiles {
                if let receipt = uploads[file.id] { refs.append(receipt); continue }
                let receipt = try await upload(file)
                uploads[file.id] = receipt
                refs.append(receipt)
            }
            try await deliver(snapshot, sendID, refs)
            if text.trimmingCharacters(in: .whitespacesAndNewlines) == snapshot.text { text = "" }
            files.removeAll { snapshot.fileIDs.contains($0.id) }
            uploads = uploads.filter { !snapshot.fileIDs.contains($0.key) }
            if reply?.id == snapshot.replyTo { reply = nil }
            previous = nil; previousID = nil; sent = true
            return true
        } catch {
            self.error = "Couldn’t confirm this send. Your message and files are kept. " + error.localizedDescription
            return false
        }
    }
}
