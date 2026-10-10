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
    /// The step in a layman's words — "Ran tests", "Edited retry.ts",
    /// "Checked the browser". The raw command stays in `input`/`summary`
    /// for the expanded row.
    public var phrase: String

    public var label: String {
        if !phrase.isEmpty { return phrase }
        return target.isEmpty ? verb : "\(verb) \(target)"
    }

    public init(
        id: String, name: String, verb: String, target: String, symbol: String,
        status: Status, isTool: Bool, summary: String? = nil, input: String? = nil,
        output: String? = nil, at: Double = 0, phrase: String = ""
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
        self.phrase = phrase
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
        at: message.at,
        phrase: plainStepLabel(name: name, summary: tool?.summary, input: tool?.input)
    )
}

/// The one line a folded run shows: "read 3 files", "ran a command",
/// "5 steps" when the run did several different things.
public func activitySummary(_ steps: [ToolStep]) -> String {
    guard let first = steps.first else { return "no activity" }
    if steps.count == 1 {
        guard first.isTool else { return first.name }
        return lowerFirst(first.label)
    }
    // A run of one plain phrase ("ran tests" three times) says so once.
    if Set(steps.map(\.label)).count == 1, first.isTool {
        return "\(lowerFirst(first.label)) ×\(steps.count)"
    }
    let verbs = Set(steps.map(\.verb))
    guard verbs.count == 1, first.isTool else { return "\(steps.count) steps" }
    let verb = first.verb.lowercased()
    guard let noun = toolPresentation(for: first.name).noun else { return "\(verb) ×\(steps.count)" }
    return "\(verb) \(steps.count) \(noun)s"
}

private func lowerFirst(_ text: String) -> String {
    guard let head = text.first else { return text }
    return head.lowercased() + text.dropFirst()
}

// MARK: - Plain words

/// A step as a person who has never opened a terminal would say it:
/// "Read retry.ts", "Edited ChatView.swift", "Ran tests", "Searched the
/// web", "Checked the browser". Same vocabulary as the desktop's live line
/// (src/lib/live-activity.ts) and the server's spoken narration
/// (server/tts/speech-text.ts `narrateTool`), in the past tense because a
/// row is something that happened. The raw command is never the label; it
/// is in the expanded row.
public func plainStepLabel(name rawName: String, summary: String?, input: String?) -> String {
    let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = name.lowercased()
    let file = fileName(summary: summary, input: input)

    if lower.hasPrefix("mcp__") {
        let parts = lower.components(separatedBy: "__")
        let server = parts.count > 1 ? parts[1] : ""
        let tool = parts.count > 2 ? parts[2...].joined(separator: "__") : ""
        if server == "computer" || server.contains("computer-use") || tool.hasPrefix("computer") { return "Used the computer" }
        if server.contains("browser") || tool.hasPrefix("agent_browser") || tool.hasPrefix("browser_") { return "Checked the browser" }
        if server == "agents" {
            if tool.contains("memory") { return "Updated its notes" }
            if tool.contains("coordinate") || tool.contains("delegate") || tool.contains("thread") || tool.contains("room") || tool.contains("bot") {
                return "Talked to the team"
            }
            if tool.contains("search") || tool.contains("session") { return "Checked its notes" }
            if tool.contains("routine") { return "Checked its routines" }
            if tool.contains("skill") { return "Updated a skill" }
            return "Sorted things out"
        }
        if server.contains("whatsapp") || tool.contains("whatsapp") { return "Read WhatsApp" }
        if server.contains("postgres") || server.contains("neon") || server.contains("sql") { return "Checked the database" }
        if server.contains("figma") { return "Worked in Figma" }
        if server.contains("gmail") || server.contains("mail") || tool.contains("gmail") { return "Checked email" }
        if server.contains("calendar") || tool.contains("calendar") { return "Checked the calendar" }
        if server.contains("slack") || tool.contains("slack") { return "Checked Slack" }
        if server.contains("github") || tool.contains("github") { return "Checked GitHub" }
        let label = server.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return label.isEmpty ? "Used a tool" : "Used \(label)"
    }

    switch lower {
    case "read", "view", "notebookread", "read_file":
        return file.map { "Read \($0)" } ?? "Read a file"
    case "write", "create", "write_file", "create_file":
        return file.map { "Wrote \($0)" } ?? "Wrote a file"
    case "edit", "multiedit", "notebookedit", "update", "str_replace", "apply_patch", "patch":
        return file.map { "Edited \($0)" } ?? "Edited a file"
    case "bash", "shell", "terminal", "run", "exec", "exec_command", "local_shell", "run_command", "execute":
        return commandPhrase(firstNonEmpty(input, summary) ?? "")
    case "bashoutput", "monitor", "write_stdin":
        return "Checked on a command"
    case "grep", "glob", "search", "codebase_search", "ls", "list_dir", "find":
        return "Searched files"
    case "toolsearch":
        return "Looked up its tools"
    case "websearch", "web_search", "web_search_call":
        return "Searched the web"
    case "webfetch", "fetch", "web_fetch", "browser_navigate":
        return webHost(summary: summary, input: input).map { "Read \($0)" } ?? "Read a web page"
    case "task", "agent", "dispatch_agent", "spawn_agent", "workflow":
        return "Got a helper on it"
    case "todowrite", "exitplanmode", "update_plan", "enterplanmode":
        return "Made a plan"
    case "skill":
        return "Followed a skill"
    case "askuserquestion":
        return "Asked you something"
    case "killshell", "killbash", "taskstop":
        return "Stopped a command"
    case "image_gen", "imagegen", "generate_image":
        return "Made an image"
    case "", "tool":
        return "Did a step"
    default:
        if lower.contains("computer") || lower.hasPrefix("screenshot") || lower == "click" || lower == "type_text" { return "Used the computer" }
        if lower.contains("browser") { return "Checked the browser" }
        if lower.contains("search") { return "Searched" }
        return "Used \(name)"
    }
}

/// A shell command as the thing it was for: "Ran tests", "Checked git",
/// "Listed files". Looks past `cd …`, `export …` and `VAR=…` set-up, and
/// when one line does several things says the one that matters most —
/// `git add -A && git commit` is "Saved a commit", `cd x && pnpm test` is
/// "Ran tests". Anything it does not recognise is "Ran a command".
public func commandPhrase(_ command: String) -> String {
    var best: (weight: Int, phrase: String) = (0, "Ran a command")
    for segment in commandSegments(command) {
        guard let candidate = segmentPhrase(segment), candidate.weight > best.weight else { continue }
        best = candidate
    }
    return best.phrase
}

/// `a && b; c | d` → [[a…], [b…], [c…], [d…]], each with leading env
/// assignments and wrappers (sudo, time, env, nohup) dropped.
private func commandSegments(_ command: String) -> [[String]] {
    var segments: [[String]] = []
    var current = ""
    var quote: Character?
    let chars = Array(command)
    var i = 0
    func flush() {
        let words = current.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        if !words.isEmpty { segments.append(words) }
        current = ""
    }
    while i < chars.count {
        let c = chars[i]
        if let q = quote {
            if c == q { quote = nil }
            current.append(c)
        } else if c == "'" || c == "\"" {
            quote = c
            current.append(c)
        } else if c == ";" || c == "\n" || c == "|" || c == "(" || c == ")" {
            flush()
        } else if c == "&" {
            flush()
        } else {
            current.append(c)
        }
        i += 1
    }
    flush()
    return segments.map { words in
        var words = words
        while let first = words.first {
            let bare = first.lowercased()
            if first.contains("="), !first.hasPrefix("-"), !first.hasPrefix("=") { words.removeFirst(); continue }
            if ["sudo", "time", "env", "nohup", "command", "exec", "caffeinate", "xargs"].contains(bare) { words.removeFirst(); continue }
            if bare == "timeout" { words.removeFirst(); if let n = words.first, Double(n.trimmingCharacters(in: .letters)) != nil { words.removeFirst() }; continue }
            break
        }
        return words
    }
}

private func segmentPhrase(_ words: [String]) -> (weight: Int, phrase: String)? {
    guard let head = words.first else { return nil }
    let program = (head.split(separator: "/").last.map(String.init) ?? head)
        .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        .lowercased()
    let args = words.dropFirst().map { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) }
    let joined = args.joined(separator: " ")
    let sub = args.first(where: { !$0.hasPrefix("-") }) ?? ""

    func has(_ any: String...) -> Bool { any.contains { joined.contains($0) } }
    let isTest = has("test", "vitest", "jest", "pytest", "spec")

    switch program {
    case "cd", "pushd", "popd", "export", "set", "unset", "source", ".", "true", ":", "local", "shopt", "trap", "wait", "then", "fi", "do", "done", "else", "if", "for", "while":
        return nil
    case "echo", "printf", "date", "clear", "pwd", "whoami", "hostname", "uname":
        return (0, "Ran a command")
    case "sleep":
        return (1, "Waited a moment")
    case "git":
        switch sub {
        case "commit": return (7, "Saved a commit")
        case "push": return (7, "Pushed the code")
        case "pull", "fetch": return (6, "Pulled the latest code")
        case "merge", "rebase", "cherry-pick": return (6, "Merged code")
        case "clone": return (6, "Downloaded a repo")
        case "worktree", "checkout", "switch", "branch": return (4, "Switched branches")
        case "add", "rm", "mv", "restore", "reset", "stash", "tag": return (4, "Tidied up git")
        default: return (3, "Checked git")
        }
    case "gh":
        return (4, sub == "pr" ? "Checked the pull request" : "Checked GitHub")
    case "vitest", "jest", "pytest", "mocha", "playwright", "rspec":
        return (9, "Ran tests")
    case "xcodebuild":
        if has(" test", "test-without-building") || args.first == "test" || args.contains("test") { return (9, "Ran tests") }
        return (8, "Built the app")
    case "swift", "go", "cargo", "dotnet", "mvn", "gradle", "./gradlew", "gradlew":
        if isTest { return (9, "Ran tests") }
        if has("build", "assemble", "compile") { return (8, "Built the app") }
        return (4, "Ran a program")
    case "pnpm", "npm", "yarn", "bun", "npx", "bunx":
        if isTest { return (9, "Ran tests") }
        if sub == "install" || sub == "i" || sub == "add" || sub == "ci" { return (6, "Installed packages") }
        if has("build", "electron-builder", "vite build", "tsc") { return (8, "Built the app") }
        if has("lint", "typecheck", "tsc", "eslint", "prettier") { return (5, "Checked the code") }
        if has("dev", "start", "preview", "serve") { return (5, "Started the app") }
        return (4, "Ran a script")
    case "tsc", "eslint", "prettier", "swiftlint", "swiftformat", "ruff", "mypy", "shellcheck":
        return (5, "Checked the code")
    case "make", "cmake", "xcodegen", "electron-builder", "vite", "webpack", "esbuild", "codesign", "xcrun":
        if program == "xcrun", args.contains("devicectl") {
            if args.contains("install") { return (9, "Installed it on the phone") }
            if args.contains("launch") || args.contains("process") { return (6, "Opened the app on the phone") }
            return (5, "Checked the phone")
        }
        if program == "xcrun", has("simctl") { return (5, "Used the simulator") }
        if program == "codesign" { return (5, "Signed the app") }
        return (8, "Built the app")
    case "brew", "pip", "pip3", "pipx", "gem", "apt", "apt-get", "uv":
        if sub == "install" || sub == "add" || sub == "sync" || sub == "upgrade" { return (6, "Installed packages") }
        if program == "uv", sub == "run" { return (4, "Ran a script") }
        return (3, "Checked installed tools")
    case "python", "python3", "node", "ruby", "perl", "deno", "tsx", "ts-node", "osascript", "bash", "sh", "zsh", "swiftc":
        if isTest { return (9, "Ran tests") }
        return (4, "Ran a script")
    case "ls", "tree", "find", "du", "df", "stat", "file", "fd", "realpath", "basename", "dirname", "mdfind":
        return (2, "Looked through files")
    case "cat", "head", "tail", "less", "more", "wc", "bat", "jq", "plutil", "diff", "cmp", "strings", "xxd", "nl", "column", "sort", "uniq", "cut", "awk", "tr":
        return (3, "Read a file")
    case "sed":
        return args.contains("-i") || args.contains(where: { $0.hasPrefix("-i") }) ? (4, "Edited a file") : (3, "Read a file")
    case "grep", "rg", "ag", "ack", "egrep", "fgrep":
        return (3, "Searched files")
    case "curl", "wget", "http", "https":
        return (4, "Checked a website")
    case "ssh", "scp", "rsync", "sftp", "mosh", "tailscale":
        return (5, "Worked on another machine")
    case "sqlite3", "psql", "mysql", "redis-cli", "mongosh":
        return (5, "Checked the database")
    case "mkdir", "touch", "cp", "mv", "ln", "chmod", "chown", "tar", "zip", "unzip", "ditto", "install":
        return (2, "Moved files around")
    case "rm", "rmdir", "trash":
        return (2, "Cleaned up files")
    case "ps", "pgrep", "lsof", "top", "htop", "pm2", "launchctl", "systemctl", "service", "docker", "kubectl", "netstat", "uptime", "vm_stat", "pmset":
        if program == "launchctl" || program == "systemctl" || program == "service" || program == "pm2" || program == "docker" {
            if args.contains("restart") || args.contains("kickstart") || args.contains("start") || args.contains("load") || args.contains("bootstrap") || args.contains("up") {
                return (5, "Restarted a service")
            }
            if args.contains("stop") || args.contains("unload") || args.contains("bootout") || args.contains("down") { return (5, "Stopped a service") }
        }
        return (3, "Checked what's running")
    case "kill", "pkill", "killall":
        return (4, "Stopped a process")
    case "open":
        return (3, "Opened something")
    case "say", "afplay", "ffmpeg", "sips", "magick", "convert":
        return (4, "Worked on media")
    case "defaults", "security", "networksetup", "scutil", "ifconfig", "ping", "dig", "nslookup", "nc", "traceroute":
        return (3, "Checked the system")
    case "vercel", "wrangler", "fly", "flyctl", "netlify", "heroku", "firebase":
        return (7, "Deployed")
    case "claude", "codex":
        return (5, "Asked another AI")
    default:
        if program.hasSuffix(".py") || program.hasSuffix(".sh") || program.hasSuffix(".js") || program.hasSuffix(".mjs") || program.hasSuffix(".ts") || head.contains("/") || head.hasPrefix("$") || head.hasPrefix("~") {
            if program.contains("restart-guard") { return (5, "Checked it was safe to restart") }
            if program.contains("install") { return (6, "Ran an install") }
            if program.contains("promote") || program.contains("deploy") || program.contains("release") { return (7, "Shipped a release") }
            return isTest ? (9, "Ran tests") : (4, "Ran a script")
        }
        return nil
    }
}

/// The file a read/write/edit touched, by its last path component.
private func fileName(summary: String?, input: String?) -> String? {
    if let line = firstLine(summary), !line.contains(" ") || line.hasPrefix("/") || line.hasPrefix("~") {
        let path = line.split(separator: " ").first.map(String.init) ?? line
        if let last = path.split(separator: "/").last, !last.isEmpty, path.contains("/") || path.contains(".") {
            return String(last)
        }
    }
    // A JSON input names it as file_path / path / notebook_path.
    if let input, let data = input.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        for key in ["file_path", "path", "notebook_path", "filename", "file"] {
            if let path = object[key] as? String, let last = path.split(separator: "/").last, !last.isEmpty {
                return String(last)
            }
        }
    }
    return nil
}

private func webHost(summary: String?, input: String?) -> String? {
    for text in [summary, input] {
        guard let text, let range = text.range(of: #"https?://[^\s"']+"#, options: .regularExpression),
              let host = URL(string: String(text[range]))?.host else { continue }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
    return nil
}

private func firstNonEmpty(_ values: String?...) -> String? {
    for value in values {
        if let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return commandText(value) }
    }
    return nil
}

/// A Bash input arrives as `{"command": "…", "description": "…"}`; the
/// command is the part to read.
private func commandText(_ value: String) -> String {
    if let data = value.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let command = (object["command"] as? String) ?? (object["cmd"] as? String) ?? ((object["command"] as? [String])?.joined(separator: " ")) {
        return command
    }
    return value
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
