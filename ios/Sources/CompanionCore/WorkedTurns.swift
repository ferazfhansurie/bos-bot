import Foundation

// The ChatGPT shape of a finished bot turn: everything the bot did before
// its answer (tool steps, the narration between them) folds behind one
// "Worked for 4m 12s" line, and the answer reads on its own below it.
//
// Pure, so the phone's fold is testable without a view and stays the same
// fold the desktop draws from the same messages.

/// A turn's work, folded. Never holds another `.worked` row.
public struct WorkedTurn: Hashable, Sendable {
    /// The folded rows, in transcript order: steps, runs of steps and the
    /// bot's interim lines.
    public let rows: [TranscriptRow]
    /// When the turn began: the person's message it answers, or its first
    /// folded row when the history starts mid-turn. Epoch milliseconds.
    public let startedAt: Double
    /// The answer this work led to. Its time ends the clock.
    public let answerId: String
    public let endedAt: Double

    public init(rows: [TranscriptRow], startedAt: Double, answerId: String, endedAt: Double) {
        self.rows = rows
        self.startedAt = startedAt
        self.answerId = answerId
        self.endedAt = endedAt
    }

    /// Keyed by the answer: a settled answer never changes, so the row keeps
    /// its identity (and the reader's scroll place) across refreshes.
    public var id: String { "worked.\(answerId)" }

    public var messages: [Message] {
        rows.flatMap { row -> [Message] in
            switch row {
            case let .message(message): [message]
            case let .activityRun(items): items
            case let .worked(turn): turn.messages
            }
        }
    }

    public var steps: [ToolStep] {
        messages.filter { $0.kind == .activity && $0.tool != nil }.map(toolStep(from:))
    }

    public var seconds: Int { max(0, Int(((endedAt - startedAt) / 1000).rounded())) }

    /// "Worked for 10m 56s", the header's words.
    public var title: String { workedTitle(seconds: seconds) }

    /// "Read files, ran commands, searched the web": the line under the
    /// header, said once per kind of thing in the order it first happened.
    public var summary: String { workedSummary(steps) }

    public var fileChanges: [FileChange] { changedFiles(in: messages) }
}

/// "Worked for 45s", "Worked for 10m 56s", "Worked for 1h 4m".
public func workedTitle(seconds: Int, running: Bool = false) -> String {
    let verb = running ? "Working for" : "Worked for"
    return "\(verb) \(workedDuration(seconds: seconds))"
}

public func workedDuration(seconds: Int) -> String {
    let s = max(0, seconds)
    if s < 60 { return "\(s)s" }
    if s < 3600 { return s % 60 == 0 ? "\(s / 60)m" : "\(s / 60)m \(s % 60)s" }
    let minutes = (s % 3600) / 60
    return minutes == 0 ? "\(s / 3600)h" : "\(s / 3600)h \(minutes)m"
}

public func workedSummary(_ steps: [ToolStep]) -> String {
    var phrases: [String] = []
    for step in steps {
        let phrase: String
        if !step.isTool {
            phrase = "messaged the team"
        } else {
            switch toolPresentation(for: step.name).verb {
            case "Read": phrase = "read files"
            case "Wrote": phrase = "created files"
            case "Edited": phrase = "edited files"
            case "Ran": phrase = "ran commands"
            case "Searched": phrase = "searched code"
            case "Searched the web", "Fetched": phrase = "searched the web"
            case "Ran agent": phrase = "ran agents"
            case "Planned": phrase = "made a plan"
            case "Ran skill": phrase = "used skills"
            default: phrase = "used tools"
            }
        }
        if !phrases.contains(phrase) { phrases.append(phrase) }
    }
    guard let first = phrases.first else { return "" }
    let shown = [first.prefix(1).uppercased() + first.dropFirst()] + phrases.dropFirst().prefix(3)
    return shown.joined(separator: ", ")
}

/// Folds each settled bot turn the way ChatGPT does.
///
/// A turn is everything after a person's line up to the next one; in a room
/// each member's contiguous stretch is its own turn. The answer is the turn's
/// last bot text. Steps and interim lines before it fold behind one header,
/// placed where the first of them was. Cards (questions, approvals, secret
/// requests, screens) never fold: they want a decision. A turn that ran no
/// tools is left alone, so two lines a bot meant to send stay two lines.
///
/// `holdingLastTurn` leaves the final turn as it is while it is still
/// running; its live steps belong to the working row until it settles.
public func foldWorkedTurns(_ rows: [TranscriptRow], holdingLastTurn: Bool = false) -> [TranscriptRow] {
    var out: [TranscriptRow] = []
    var segment: [TranscriptRow] = []
    var turnStart: Double?

    func flush() {
        guard !segment.isEmpty else { return }
        var stretch: [TranscriptRow] = []
        var key: String?
        for row in segment {
            let rowKey = row.head.from?.botId ?? ""
            if let key, key != rowKey {
                out.append(contentsOf: foldStretch(stretch, startedAt: turnStart))
                stretch.removeAll()
            }
            key = rowKey
            stretch.append(row)
        }
        out.append(contentsOf: foldStretch(stretch, startedAt: turnStart))
        segment.removeAll()
    }

    for row in rows {
        if case let .message(message) = row, message.role == .user {
            flush()
            out.append(row)
            turnStart = message.at
            continue
        }
        segment.append(row)
    }
    if holdingLastTurn {
        out.append(contentsOf: segment)
    } else {
        flush()
    }
    return out
}

private func foldStretch(_ rows: [TranscriptRow], startedAt: Double?) -> [TranscriptRow] {
    guard let answerIndex = rows.lastIndex(where: isAnswer) else { return rows }
    let before = rows[..<answerIndex]
    let folded = before.filter(isFoldable)
    guard folded.contains(where: isWork) else { return rows }
    guard let firstFolded = before.firstIndex(where: isFoldable) else { return rows }
    let answer = rows[answerIndex].head
    let turn = WorkedTurn(
        rows: Array(folded),
        startedAt: min(startedAt ?? folded[folded.startIndex].at, folded[folded.startIndex].at),
        answerId: answer.id,
        endedAt: answer.at
    )
    var out = Array(rows[..<firstFolded])
    out.append(.worked(turn))
    out.append(contentsOf: rows[firstFolded..<answerIndex].filter { !isFoldable($0) })
    out.append(contentsOf: rows[answerIndex...])
    return out
}

private func isAnswer(_ row: TranscriptRow) -> Bool {
    guard case let .message(message) = row else { return false }
    return message.role == .bot && message.kind == .text
}

private func isWork(_ row: TranscriptRow) -> Bool {
    switch row {
    case .activityRun: true
    case let .message(message): message.kind == .activity
    case .worked: false
    }
}

private func isFoldable(_ row: TranscriptRow) -> Bool {
    switch row {
    case .activityRun: return true
    case let .message(message):
        // A restart-interrupted step carries a Resume button; keep it out.
        if message.tool?.recovery?.isOpen == true { return false }
        return message.role == .bot && (message.kind == .activity || message.kind == .text)
    case .worked: return false
    }
}

// MARK: - File changes

/// One file a turn changed, for the "Edited N files" card.
public struct FileChange: Hashable, Sendable, Identifiable {
    public let path: String
    /// Lines added and removed, when the step's input said; nil when it was
    /// cut short or never captured.
    public var added: Int?
    public var removed: Int?
    public var created: Bool

    public init(path: String, added: Int?, removed: Int?, created: Bool) {
        self.path = path
        self.added = added
        self.removed = removed
        self.created = created
    }

    public var id: String { path }
    public var name: String { (path as NSString).lastPathComponent }
    /// The folder, dimmed before the name. Empty for a bare name.
    public var directory: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir + "/"
    }
}

/// Files the turn's edit and write steps touched, merged per path in the
/// order first touched. Failed steps changed nothing and are skipped.
public func changedFiles(in messages: [Message]) -> [FileChange] {
    var order: [String] = []
    var byPath: [String: FileChange] = [:]
    for message in messages where message.kind == .activity {
        guard let tool = message.tool, tool.ok != false else { continue }
        let verb = toolPresentation(for: tool.name).verb
        let lower = tool.name.lowercased()
        guard verb == "Edited" || verb == "Wrote" || lower == "apply_patch" || lower == "filechange" else { continue }
        for change in changes(of: tool, created: verb == "Wrote") {
            if var existing = byPath[change.path] {
                existing.added = sum(existing.added, change.added)
                existing.removed = sum(existing.removed, change.removed)
                byPath[change.path] = existing
            } else {
                order.append(change.path)
                byPath[change.path] = change
            }
        }
    }
    return order.compactMap { byPath[$0] }
}

private func sum(_ a: Int?, _ b: Int?) -> Int? {
    guard let a, let b else { return a ?? b }
    return a + b
}

private func lineCount(_ text: String?) -> Int? {
    guard let text else { return nil }
    if text.isEmpty { return 0 }
    return text.split(separator: "\n", omittingEmptySubsequences: false).count
}

private func changes(of tool: ToolActivity, created: Bool) -> [FileChange] {
    let json = tool.input.flatMap { $0.data(using: .utf8) }
        .flatMap { try? JSONSerialization.jsonObject(with: $0) }
    if let object = json as? [String: Any] {
        let path = (object["file_path"] ?? object["path"] ?? object["notebook_path"]) as? String
        if let path {
            if let content = object["content"] as? String {
                return [FileChange(path: path, added: lineCount(content), removed: 0, created: true)]
            }
            if let edits = object["edits"] as? [[String: Any]] {
                let added = edits.compactMap { lineCount($0["new_string"] as? String) }.reduce(0, +)
                let removed = edits.compactMap { lineCount($0["old_string"] as? String) }.reduce(0, +)
                return [FileChange(path: path, added: added, removed: removed, created: false)]
            }
            return [FileChange(
                path: path,
                added: lineCount(object["new_string"] as? String),
                removed: lineCount(object["old_string"] as? String),
                created: created
            )]
        }
    }
    // Codex `fileChange`: a list of { path, kind, diff }.
    if let list = json as? [[String: Any]] {
        return list.compactMap { item in
            guard let path = item["path"] as? String else { return nil }
            let diff = item["diff"] as? String ?? item["unified_diff"] as? String
            let counts = diff.map(diffCounts)
            let kind = (item["kind"] as? [String: Any])?["type"] as? String ?? item["kind"] as? String
            return FileChange(path: path, added: counts?.added, removed: counts?.removed, created: kind == "add")
        }
    }
    // Cut short or not JSON: the step's own one-liner is the path.
    if let summary = tool.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
       !summary.isEmpty, !summary.contains(" ") {
        return [FileChange(path: summary, added: nil, removed: nil, created: created)]
    }
    if let input = tool.input, let path = quotedField("file_path", in: input) {
        return [FileChange(path: path, added: nil, removed: nil, created: created)]
    }
    return []
}

private func diffCounts(_ diff: String) -> (added: Int, removed: Int) {
    var added = 0, removed = 0
    for line in diff.split(separator: "\n") {
        if line.hasPrefix("+++") || line.hasPrefix("---") { continue }
        if line.hasPrefix("+") { added += 1 } else if line.hasPrefix("-") { removed += 1 }
    }
    return (added, removed)
}

private func quotedField(_ name: String, in text: String) -> String? {
    guard let range = text.range(of: "\"\(name)\"") else { return nil }
    let rest = text[range.upperBound...].drop { $0 == " " || $0 == ":" }
    guard rest.first == "\"" else { return nil }
    let value = rest.dropFirst().prefix { $0 != "\"" }
    return value.isEmpty ? nil : String(value)
}
