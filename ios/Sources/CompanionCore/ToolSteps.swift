// A bot's tool calls as steps a person can read.
//
// The harness sends one `activity` message per tool call: a raw name
// ("Bash", "mcp__composio__COMPOSIO_SEARCH_TOOLS"), an optional one-line
// summary, the input it was called with, and — once the call lands — its
// result. Drawn literally that is a wall of vendor nouns, which is why the
// phone stopped drawing them at all. This turns each one into the same
// shape the AIOS app used: a verb, the thing it acted on, a glyph and a
// status — "Read retry.ts", "Ran a command" — and folds a run of them into
// one line ("read 3 files") that opens back into the detail.
//
// Pure: no SwiftUI here, so the mapping is the part that is tested.
import Foundation

public struct ToolStep: Identifiable, Hashable, Sendable {
    public enum Status: String, Sendable {
        /// Started and not yet landed — the harness patches `ok` in later.
        case running
        case ok
        case failed
    }

    public var id: String
    /// The chip text as the harness sent it, kept for the detail sheet.
    public var name: String
    public var verb: String
    public var target: String
    /// SF Symbol.
    public var symbol: String
    public var status: Status
    /// False for the harness's own receipts — "Messaged @Helper", "Opened
    /// thread …" — which are already sentences and must not be re-worded
    /// into a verb and an object.
    public var isTool: Bool
    public var summary: String?
    public var input: String?
    public var output: String?
    public var at: Double

    public var label: String { target.isEmpty ? verb : "\(verb) \(target)" }

    public init(
        id: String, name: String, verb: String, target: String, symbol: String,
        status: Status, isTool: Bool, summary: String? = nil, input: String? = nil,
        output: String? = nil, at: Double = 0
    ) {
        self.id = id
        self.name = name
        self.verb = verb
        self.target = target
        self.symbol = symbol
        self.status = status
        self.isTool = isTool
        self.summary = summary
        self.input = input
        self.output = output
        self.at = at
    }
}

/// Verb, glyph and the noun a count reads with ("read 3 *files*").
public struct ToolPresentation: Hashable, Sendable {
    public var verb: String
    public var symbol: String
    /// Singular; nil when a count of this verb reads better without a noun.
    public var noun: String?

    public init(verb: String, symbol: String, noun: String? = nil) {
        self.verb = verb
        self.symbol = symbol
        self.noun = noun
    }
}

/// What a tool name means, in the reader's words.
public func toolPresentation(for rawName: String) -> ToolPresentation {
    let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = name.lowercased()

    // An MCP tool is `mcp__<server>__<tool>`; the server is the useful half.
    if lower.hasPrefix("mcp__") {
        let parts = name.split(separator: "_").filter { !$0.isEmpty }
        let server = parts.count > 1 ? String(parts[1]) : "tool"
        return ToolPresentation(verb: "Called \(server)", symbol: "puzzlepiece.extension", noun: "call")
    }

    switch lower {
    case "read", "view", "notebookread": return ToolPresentation(verb: "Read", symbol: "doc.text", noun: "file")
    case "write", "create": return ToolPresentation(verb: "Wrote", symbol: "square.and.pencil", noun: "file")
    case "edit", "multiedit", "notebookedit", "update", "str_replace": return ToolPresentation(verb: "Edited", symbol: "pencil", noun: "file")
    case "bash", "shell", "terminal", "run", "exec", "bashoutput": return ToolPresentation(verb: "Ran", symbol: "terminal", noun: "command")
    case "grep", "glob", "search", "codebase_search": return ToolPresentation(verb: "Searched", symbol: "magnifyingglass", noun: "search")
    case "websearch": return ToolPresentation(verb: "Searched the web", symbol: "globe", noun: "search")
    case "webfetch", "fetch", "browser_navigate": return ToolPresentation(verb: "Fetched", symbol: "globe", noun: "page")
    case "task", "agent", "dispatch_agent": return ToolPresentation(verb: "Ran agent", symbol: "sparkles", noun: "agent")
    case "todowrite", "exitplanmode": return ToolPresentation(verb: "Planned", symbol: "list.bullet", noun: "plan")
    case "skill": return ToolPresentation(verb: "Ran skill", symbol: "gearshape", noun: "skill")
    case "killshell", "killbash": return ToolPresentation(verb: "Stopped a shell", symbol: "stop.circle", noun: "shell")
    default:
        return ToolPresentation(verb: name.isEmpty ? "Tool" : name, symbol: "wrench.and.screwdriver", noun: nil)
    }
}

/// The part of a tool's summary worth putting beside its verb.
///
/// A path becomes its last component — the whole path is in the sheet, and
/// a row that wraps twice stops being a row. A command keeps its first
/// line, because the command IS the target.
public func toolTarget(summary: String?, input: String?) -> String {
    let raw = firstLine(summary) ?? firstLine(input) ?? ""
    guard !raw.isEmpty else { return "" }
    // Looks like a path and nothing else: show the file.
    if !raw.contains(" "), raw.contains("/"), let last = raw.split(separator: "/").last, !last.isEmpty {
        return String(last)
    }
    return raw.count > 48 ? String(raw.prefix(47)) + "…" : raw
}

private func firstLine(_ text: String?) -> String? {
    guard let text else { return nil }
    let line = text.split(separator: "\n").first.map(String.init)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return line.isEmpty ? nil : line
}

/// One activity message as a step.
public func toolStep(from message: Message) -> ToolStep {
    let tool = message.tool
    let name = tool?.name ?? "tool"
    let status: ToolStep.Status = tool?.ok == nil ? .running : (tool?.ok == true ? .ok : .failed)
    // The harness's own receipts arrive as whole phrases with no provider
    // item behind them. Those are already the sentence to show.
    let isTool = tool?.itemId != nil
    if !isTool {
        return ToolStep(
            id: message.id, name: name, verb: name, target: "", symbol: "bell.badge",
            status: status, isTool: false, summary: tool?.summary, input: tool?.input,
            output: tool?.output, at: message.at
        )
    }
    let presentation = toolPresentation(for: name)
    return ToolStep(
        id: message.id,
        name: name,
        verb: presentation.verb,
        target: toolTarget(summary: tool?.summary, input: tool?.input),
        symbol: presentation.symbol,
        status: status,
        isTool: true,
        summary: tool?.summary,
        input: tool?.input,
        output: tool?.output,
        at: message.at
    )
}

/// The one line a folded run shows: "read 3 files", "ran a command",
/// "5 steps" when the run did several different things.
public func activitySummary(_ steps: [ToolStep]) -> String {
    guard let first = steps.first else { return "no activity" }
    if steps.count == 1 {
        guard first.isTool else { return first.name }
        let verb = first.verb.lowercased()
        if !first.target.isEmpty { return "\(verb) \(first.target)" }
        if let noun = toolPresentation(for: first.name).noun { return "\(verb) a \(noun)" }
        return verb
    }
    let verbs = Set(steps.map(\.verb))
    guard verbs.count == 1, first.isTool else { return "\(steps.count) steps" }
    let verb = first.verb.lowercased()
    guard let noun = toolPresentation(for: first.name).noun else { return "\(verb) ×\(steps.count)" }
    return "\(verb) \(steps.count) \(noun)s"
}

/// A run reads as its worst outcome: one failure is the thing to see, and a
/// run with anything still going is still going.
public func activityStatus(_ steps: [ToolStep]) -> ToolStep.Status {
    if steps.contains(where: { $0.status == .failed }) { return .failed }
    if steps.contains(where: { $0.status == .running }) { return .running }
    return .ok
}

/// "12s", "1m 04s", "2h 05m" — a working turn's elapsed time, never a bare
/// count of seconds past a minute or of minutes past an hour.
public func elapsedLabel(_ seconds: Int) -> String {
    let seconds = max(0, seconds)
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3_600 { return "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s" }
    return "\(seconds / 3_600)h \(String(format: "%02d", seconds % 3_600 / 60))m"
}

/// What a bot is doing right now, in the present tense a lock screen reads
/// at a glance: "running a command", "reading files". Never a vendor noun.
public struct ToolProgress: Hashable, Sendable {
    public var phrase: String
    public var symbol: String
}

public func toolProgress(for rawName: String) -> ToolProgress {
    let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = name.lowercased()

    if lower.hasPrefix("mcp__") {
        let parts = lower.components(separatedBy: "__")
        let server = parts.count > 1 ? parts[1] : ""
        let tool = parts.count > 2 ? parts[2...].joined(separator: "__") : ""
        if server == "computer" || server.contains("computer-use") || tool.hasPrefix("computer") {
            return ToolProgress(phrase: "on the computer", symbol: "macbook")
        }
        if server.contains("browser") || tool.hasPrefix("agent_browser") || tool.hasPrefix("browser_") {
            return ToolProgress(phrase: "browsing the web", symbol: "safari")
        }
        if server == "agents" {
            if tool.contains("memory") { return ToolProgress(phrase: "updating its memory", symbol: "brain") }
            if tool.contains("coordinate") || tool.contains("delegate") || tool.contains("thread") || tool.contains("room") {
                return ToolProgress(phrase: "working with the team", symbol: "person.2")
            }
            if tool.contains("search") || tool.contains("session") { return ToolProgress(phrase: "checking its notes", symbol: "text.magnifyingglass") }
            return ToolProgress(phrase: "organising things", symbol: "square.stack.3d.up")
        }
        if server.contains("whatsapp") || tool.contains("whatsapp") { return ToolProgress(phrase: "reading whatsapp", symbol: "message") }
        if server.contains("postgres") || server.contains("neon") || server.contains("sql") {
            return ToolProgress(phrase: "querying the database", symbol: "cylinder.split.1x2")
        }
        if server.contains("figma") { return ToolProgress(phrase: "in figma", symbol: "paintpalette") }
        if server.contains("gmail") || server.contains("mail") { return ToolProgress(phrase: "checking email", symbol: "envelope") }
        if server.contains("calendar") { return ToolProgress(phrase: "checking the calendar", symbol: "calendar") }
        let label = server.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return ToolProgress(phrase: label.isEmpty ? "using a tool" : "using \(label)", symbol: "puzzlepiece.extension")
    }

    switch lower {
    case "read", "view", "notebookread", "read_file", "cat":
        return ToolProgress(phrase: "reading files", symbol: "doc.text")
    case "write", "create", "write_file":
        return ToolProgress(phrase: "writing code", symbol: "square.and.pencil")
    case "edit", "multiedit", "notebookedit", "update", "str_replace", "apply_patch", "patch":
        return ToolProgress(phrase: "editing code", symbol: "pencil")
    case "bash", "shell", "terminal", "run", "exec", "exec_command", "local_shell", "bashoutput", "write_stdin", "monitor":
        return ToolProgress(phrase: "running a command", symbol: "terminal")
    case "grep", "glob", "search", "codebase_search", "ls", "list_dir", "find", "toolsearch":
        return ToolProgress(phrase: "searching files", symbol: "magnifyingglass")
    case "websearch", "web_search", "web_search_call":
        return ToolProgress(phrase: "searching the web", symbol: "globe")
    case "webfetch", "fetch", "browser_navigate":
        return ToolProgress(phrase: "reading a web page", symbol: "globe")
    case "task", "agent", "dispatch_agent", "spawn_agent", "workflow":
        return ToolProgress(phrase: "running helpers", symbol: "sparkles")
    case "todowrite", "exitplanmode", "update_plan", "enterplanmode":
        return ToolProgress(phrase: "planning", symbol: "list.bullet")
    case "skill":
        return ToolProgress(phrase: "following a skill", symbol: "gearshape")
    case "askuserquestion":
        return ToolProgress(phrase: "waiting for you", symbol: "hand.raised")
    case "killshell", "killbash", "taskstop":
        return ToolProgress(phrase: "stopping a command", symbol: "stop.circle")
    case "image_gen", "imagegen", "generate_image":
        return ToolProgress(phrase: "making an image", symbol: "photo")
    case "", "tool":
        return ToolProgress(phrase: "working", symbol: "circle.dotted")
    default:
        if lower.contains("computer") || lower.hasPrefix("screenshot") || lower == "click" || lower == "type_text" {
            return ToolProgress(phrase: "on the computer", symbol: "macbook")
        }
        if lower.contains("browser") { return ToolProgress(phrase: "browsing the web", symbol: "safari") }
        if lower.contains("search") { return ToolProgress(phrase: "searching", symbol: "magnifyingglass") }
        return ToolProgress(phrase: "working", symbol: "circle.dotted")
    }
}

/// The first readable line of a reply, for the "done" lock screen: markdown
/// markers stripped, bounded so it never wraps more than twice.
public func replyFirstLine(_ text: String?, limit: Int = 120) -> String {
    guard let text else { return "" }
    for raw in text.split(separator: "\n") {
        var line = raw.trimmingCharacters(in: .whitespaces)
        while let first = line.first, "#>-*`".contains(first) { line.removeFirst() }
        line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { continue }
        return line.count > limit ? String(line.prefix(limit - 1)) + "…" : line
    }
    return ""
}
