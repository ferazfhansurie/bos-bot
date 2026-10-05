import Foundation

/// A held send opened for editing. Only the typed words are editable: every
/// pasted block and attachment tag is kept byte for byte, in place, so an
/// edit can never drop, add or reorder what the message carries.
public struct QueuedSendDraft: Hashable, Sendable {
    enum Piece: Hashable, Sendable {
        /// A paste block or attachment tag line, never touched.
        case kept(String)
        /// Whitespace between kept pieces.
        case gap(String)
        /// Typed words, edited through `fields[index]`; the surrounding
        /// whitespace stays as it was.
        case field(index: Int, lead: String, trail: String)
    }

    public let original: QueuedSend
    /// The editable typed parts, in message order. Usually exactly one.
    public let fields: [String]
    let pieces: [Piece]
    /// A paste- or file-only send has no typed part; its one field is new
    /// and is written in front of the kept content.
    let leadingFieldIsNew: Bool
    let preview: QueuedSendPreview

    public init(_ send: QueuedSend) {
        original = send
        preview = QueuedSendPreview.parse(send.text)
        let text = send.text
        var pieces: [Piece] = []
        var fields: [String] = []
        var cursor = text.startIndex
        for range in Self.keptRanges(in: text) where range.lowerBound >= cursor {
            Self.appendTyped(text[cursor..<range.lowerBound], to: &pieces, fields: &fields)
            pieces.append(.kept(String(text[range])))
            cursor = range.upperBound
        }
        Self.appendTyped(text[cursor...], to: &pieces, fields: &fields)
        if fields.isEmpty {
            fields = [""]
            leadingFieldIsNew = true
        } else {
            leadingFieldIsNew = false
        }
        self.fields = fields
        self.pieces = pieces
    }

    public var attachments: [DisplayedMessageAttachment] { preview.attachments }
    public var pastes: [QueuedSendPreview.Paste] { preview.pastes }

    /// The full queued text with `edited` in place of the typed parts.
    public func text(with edited: [String]) -> String {
        precondition(edited.count == fields.count, "one edit per field")
        var out = ""
        if leadingFieldIsNew {
            let typed = edited[0].trimmingCharacters(in: .whitespacesAndNewlines)
            if !typed.isEmpty { out = typed + (original.text.isEmpty ? "" : "\n\n") }
        }
        for piece in pieces {
            switch piece {
            case let .kept(raw), let .gap(raw): out += raw
            case let .field(index, lead, trail):
                let typed = edited[index].trimmingCharacters(in: .whitespacesAndNewlines)
                out += typed.isEmpty ? (out.isEmpty ? "" : lead) : lead + typed + trail
            }
        }
        return out
    }

    public enum Problem: Equatable, Sendable {
        case unchanged
        case empty
        /// The edit would add, drop or reorder a paste or attachment, e.g. by
        /// typing a transport tag or opening a code fence around one.
        case changesAttachments

        public var message: String {
            switch self {
            case .unchanged: return "Nothing has changed yet."
            case .empty: return "A queued message can't be empty. Delete it instead."
            case .changesAttachments: return "Only the text can be edited. Files and pasted blocks stay as they are."
            }
        }
    }

    public func problem(with edited: [String]) -> Problem? {
        let next = text(with: edited)
        if next == original.text { return .unchanged }
        if next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
        let after = QueuedSendPreview.parse(next)
        if after.attachments != preview.attachments || after.pastes != preview.pastes { return .changesAttachments }
        return nil
    }

    // MARK: - Splitting

    private static func appendTyped(_ slice: Substring, to pieces: inout [Piece], fields: inout [String]) {
        guard !slice.isEmpty else { return }
        guard let first = slice.firstIndex(where: { !$0.isWhitespace }),
              let last = slice.lastIndex(where: { !$0.isWhitespace })
        else {
            pieces.append(.gap(String(slice)))
            return
        }
        let after = slice.index(after: last)
        pieces.append(.field(index: fields.count, lead: String(slice[..<first]), trail: String(slice[after...])))
        fields.append(String(slice[first..<after]))
    }

    /// Exactly what `QueuedSendPreview.parse` treats as a paste or an
    /// attachment, so the editor and the queue line never disagree: pastes
    /// first on the whole text, then tag lines on what remains.
    static func keptRanges(in text: String) -> [Range<String.Index>] {
        var kept: [Range<String.Index>] = []
        // (offset in remainder, offset in text, utf8 length) per kept chunk.
        var chunks: [(Int, Int, Int)] = []
        var remainder = ""
        var cursor = text.startIndex
        let utf8 = text.utf8
        func offset(_ index: String.Index) -> Int { utf8.distance(from: utf8.startIndex, to: index) }
        func chunk(_ range: Range<String.Index>) {
            guard !range.isEmpty else { return }
            chunks.append((remainder.utf8.count, offset(range.lowerBound), offset(range.upperBound) - offset(range.lowerBound)))
            remainder += text[range]
        }
        let matches = QueuedSendPreview.pasteBlock.matches(in: text, range: NSRange(text.startIndex..<text.endIndex, in: text))
        for match in matches {
            guard let whole = Range(match.range, in: text) else { continue }
            chunk(cursor..<whole.lowerBound)
            var block = whole
            if text[block].hasPrefix("\n") { block = text.index(after: block.lowerBound)..<block.upperBound }
            kept.append(block)
            cursor = whole.upperBound
        }
        chunk(cursor..<text.endIndex)

        let rest = remainder.utf8
        for line in AttachedMessageContent.scan(remainder).tagLines {
            let start = rest.distance(from: rest.startIndex, to: line.lowerBound)
            let end = rest.distance(from: rest.startIndex, to: line.upperBound)
            // A tag line stitched together across a removed paste does not
            // exist in the original text; it stays typed.
            guard let owner = chunks.first(where: { start >= $0.0 && end <= $0.0 + $0.2 }) else { continue }
            let lower = utf8.index(utf8.startIndex, offsetBy: owner.1 + start - owner.0)
            let upper = utf8.index(utf8.startIndex, offsetBy: owner.1 + end - owner.0)
            kept.append(lower..<upper)
        }
        return kept.sorted { $0.lowerBound < $1.lowerBound }
    }
}

/// Why an edit did not land. Every case leaves the queued message exactly as
/// the computer holds it, and none of them ever sends anything new.
public enum QueuedSendEditError: Error, Equatable, Sendable {
    /// The entry drained into the conversation or was deleted first.
    case gone
    /// The entry changed since the editor opened it, or the computer reports
    /// it no longer waiting (it answers 409 for both).
    case changed
    /// The computer has no edit route yet.
    case unsupported
    case unauthorized
    case refused(String)
    case failed(String)

    public var message: String {
        switch self {
        case .gone:
            return "This message already left the queue, so the edit wasn't applied. Nothing new was sent; your edit is still here."
        case .changed:
            return "This queued message changed or already left the queue. Nothing was replaced or sent; your edit is still here."
        case .unsupported:
            return "This computer is too old to edit queued messages. Update BOS on it."
        case .unauthorized:
            return "This phone is not paired with that computer."
        case let .refused(message), let .failed(message):
            return message
        }
    }

    /// Edits are safe to try again only when the queue may still hold them.
    public var isRetryable: Bool {
        switch self {
        case .failed: return true
        default: return false
        }
    }

    /// The harness's own answer for an entry that is not in its queue.
    static let goneMessage = "no such queued message"

    public static func from(_ error: Error) -> QueuedSendEditError {
        if let error = error as? QueuedSendEditError { return error }
        guard let error = error as? APIError else { return .failed(error.localizedDescription) }
        switch error {
        case let .status(code, message):
            switch code {
            case 401: return .unauthorized
            // A computer without the route answers 404 too; only the
            // harness's own wording means the entry itself is gone.
            case 404 where message?.localizedCaseInsensitiveContains(goneMessage) == true: return .gone
            case 404, 405, 501: return .unsupported
            case 409, 412: return .changed
            case 400, 403, 413, 422: return .refused(error.localizedDescription)
            default: return .failed(error.localizedDescription)
            }
        case .transport, .badURL:
            return .failed(error.localizedDescription)
        }
    }

    /// A lost response can make a landed edit look like a conflict on retry.
    /// When the queue already holds exactly the intended text, it landed.
    public static func landed(_ intended: String, live: QueuedSend?) -> Bool {
        live?.text == intended
    }
}

extension CompanionState {
    /// Puts an edit the computer accepted into the row it came from, in
    /// place: same queueId, same position. A row that already drained stays
    /// drained.
    @discardableResult
    public mutating func applyQueuedEdit(_ updated: QueuedSend, threadId: String) -> Bool {
        guard !drainedQueueIds.contains(updated.queueId),
              var waiting = pendingQueued[threadId],
              let index = waiting.firstIndex(where: { $0.queueId == updated.queueId })
        else { return false }
        waiting[index].text = updated.text
        if let reason = updated.reason { waiting[index].reason = reason }
        pendingQueued[threadId] = waiting
        return true
    }
}
