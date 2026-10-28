import Foundation

// The live card's step line in plain words, from the tool the bot is running
// and its arguments: "reading retry.ts", "running tests", "searching the
// web". Lowercase, at most ~32 characters, never a path or a command line.
// The Mac says the same words in server/live-step.ts when it drives the
// island over push; keep the two vocabularies together.

public struct LiveStep: Equatable, Sendable {
    public var line: String
    public var symbol: String
    public var stepIndex: Int?
    public var stepCount: Int?
    public var planStep: String?

    public init(line: String, symbol: String, stepIndex: Int? = nil, stepCount: Int? = nil, planStep: String? = nil) {
        self.line = line
        self.symbol = symbol
        self.stepIndex = stepIndex
        self.stepCount = stepCount
        self.planStep = planStep
    }
}

private let liveLimit = 32

private func cap(_ text: String, _ limit: Int = liveLimit) -> String {
    text.count > limit ? String(text.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…" : text
}

private func fields(_ input: String?) -> [String: Any]? {
    guard let input, input.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("{"),
          let data = input.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

private func string(_ value: Any?) -> String? {
    guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
    return text
}

private func liveFileName(_ fields: [String: Any]?) -> String? {
    guard let raw = string(fields?["file_path"]) ?? string(fields?["path"]) ?? string(fields?["notebook_path"]) ?? string(fields?["filename"]),
          let base = raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init),
          base.count <= 24, base.range(of: #"^[\w.@+-]+$"#, options: .regularExpression) != nil else { return nil }
    return base
}

private func liveHost(_ fields: [String: Any]?) -> String? {
    guard let raw = string(fields?["url"]), let host = URL(string: raw)?.host, !host.isEmpty else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}

private let liveCommands: [(pattern: String, line: String, symbol: String, weight: Int)] = [
    (#"^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest)\b|^(?:npx\s+)?(?:vitest|jest|pytest|mocha)\b|^(?:swift|cargo|go)\s+test\b|^xcodebuild\b.*\btest\b"#, "running tests", "checkmark.seal", 9),
    (#"^git\s+(?:commit|push)\b"#, "saving the work", "arrow.triangle.branch", 8),
    (#"^(?:xcodebuild|swift\s+build|cargo\s+build|go\s+build|make\b|tsc\b)|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bbuild\.sh\b|\bios\.sh\b"#, "building the app", "hammer", 8),
    (#"^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|^(?:pip3?|brew)\s+install\b"#, "installing packages", "shippingbox", 7),
    (#"^(?:xcrun\s+devicectl|devicectl)\b"#, "installing on the phone", "iphone", 7),
    (#"^(?:ssh|scp|rsync)\b"#, "working on the server", "server.rack", 6),
    (#"^(?:sudo\s+)?systemctl\b|^launchctl\b|^pm2\b"#, "restarting a service", "arrow.clockwise", 6),
    (#"^(?:curl|wget|http)\b"#, "checking a website", "globe", 5),
    (#"^(?:psql|sqlite3|mysql)\b"#, "checking the database", "cylinder", 5),
    (#"^(?:python3?|node|tsx|deno|bun|ruby)\b"#, "running a script", "terminal", 4),
    (#"^git\b"#, "checking the code history", "arrow.triangle.branch", 3),
    (#"^(?:rg|grep|ag|find|fd)\b"#, "searching files", "magnifyingglass", 3),
    (#"^(?:cat|head|tail|sed|less|wc|jq)\b"#, "reading files", "doc.text", 2),
    (#"^(?:ls|tree|pwd)\b"#, "looking through files", "folder", 1),
]

private func matches(_ text: String, _ pattern: String) -> Bool {
    text.range(of: pattern, options: .regularExpression) != nil
}

/// A shell line as the thing it is for; the most telling part of a chain wins.
public func liveCommandStep(_ command: String) -> LiveStep {
    var best = (line: "running a command", symbol: "terminal", weight: 0)
    let parts = command.replacingOccurrences(of: "&&", with: ";").replacingOccurrences(of: "||", with: ";")
        .split(whereSeparator: { $0 == ";" || $0 == "|" })
    for raw in parts {
        var segment = raw.trimmingCharacters(in: .whitespaces)
        segment = segment.replacingOccurrences(of: #"^(?:\w+=\S*\s+)+"#, with: "", options: .regularExpression)
        segment = segment.replacingOccurrences(of: #"^(?:sudo|time|env|nohup|exec)\s+"#, with: "", options: .regularExpression)
        if segment.isEmpty || matches(segment, #"^(?:cd|export|source|\.|set|echo|true|false)\b"#) { continue }
        for command in liveCommands where command.weight > best.weight && matches(segment, command.pattern) {
            best = (command.line, command.symbol, command.weight)
        }
    }
    return LiveStep(line: best.line, symbol: best.symbol)
}

/// One tool call as a live step line.
public func liveToolStep(name rawName: String, summary: String?, input: String?) -> LiveStep {
    let lower = rawName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let args = fields(input)
    let file = liveFileName(args)
    func step(_ line: String, _ symbol: String) -> LiveStep { LiveStep(line: cap(line), symbol: symbol) }
    if lower.hasPrefix("mcp__") {
        let parts = lower.components(separatedBy: "__")
        let server = parts.count > 1 ? parts[1] : ""
        let tool = parts.count > 2 ? parts[2...].joined(separator: "__") : ""
        let both = server + tool
        if server == "computer" || server.contains("computer-use") || tool.hasPrefix("computer") { return step("using the computer", "desktopcomputer") }
        if server.contains("browser") || tool.hasPrefix("agent_browser") || tool.hasPrefix("browser_") {
            return step(liveHost(args).map { "on \($0)" } ?? "using the browser", "safari")
        }
        if server == "agents" {
            if tool.contains("memory") { return step("updating its notes", "brain") }
            if matches(tool, "coordinate|delegate|thread|room|bot") { return step("talking to the team", "person.2") }
            if matches(tool, "search|session") { return step("checking its notes", "brain") }
            if tool.contains("routine") { return step("checking its routines", "clock") }
            if tool.contains("skill") { return step("updating a skill", "book") }
            return step("sorting things out", "gearshape")
        }
        if both.contains("whatsapp") { return step("on whatsapp", "message") }
        if matches(server, "postgres|neon|sql") { return step("checking the database", "cylinder") }
        if matches(both, "gmail|mail") { return step("checking email", "envelope") }
        if both.contains("calendar") { return step("checking the calendar", "calendar") }
        if both.contains("slack") { return step("checking slack", "number") }
        if both.contains("github") { return step("checking github", "arrow.triangle.branch") }
        if server.contains("figma") { return step("working in figma", "paintbrush") }
        if matches(server, "pipeboard|meta|ads") { return step("checking the ads", "megaphone") }
        let label = server.replacingOccurrences(of: #"[_-]+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return step(label.isEmpty ? "using a tool" : "using \(label)", "gearshape")
    }
    switch lower {
    case "read", "view", "notebookread", "read_file":
        return step(file.map { "reading \($0)" } ?? "reading a file", "doc.text")
    case "write", "create", "write_file", "create_file":
        return step(file.map { "writing \($0)" } ?? "writing a file", "square.and.pencil")
    case "edit", "multiedit", "notebookedit", "str_replace", "apply_patch", "patch":
        return step(file.map { "editing \($0)" } ?? "editing a file", "pencil")
    case "bash", "shell", "terminal", "run", "exec", "exec_command", "local_shell", "run_command", "execute":
        return liveCommandStep(string(args?["command"]) ?? summary ?? "")
    case "bashoutput", "monitor", "write_stdin":
        return step("checking on a command", "terminal")
    case "grep", "glob", "search", "codebase_search", "ls", "list_dir", "find":
        return step("searching files", "magnifyingglass")
    case "toolsearch":
        return step("looking up its tools", "wrench.and.screwdriver")
    case "websearch", "web_search", "web_search_call":
        return step("searching the web", "globe")
    case "webfetch", "fetch", "web_fetch":
        return step(liveHost(args).map { "reading \($0)" } ?? "reading a web page", "globe")
    case "task", "agent", "dispatch_agent", "spawn_agent", "workflow":
        return step("got a helper on it", "person.2")
    case "todowrite", "update_plan", "exitplanmode", "enterplanmode":
        return step("making a plan", "list.bullet")
    case "skill":
        return step("following a skill", "book")
    case "askuserquestion":
        return step("asking you something", "questionmark.bubble")
    case "image_gen", "imagegen", "generate_image":
        return step("making an image", "photo")
    default:
        if matches(lower, "computer|screenshot|^click$|^type_text$") { return step("using the computer", "desktopcomputer") }
        if lower.contains("browser") { return step("using the browser", "safari") }
        if lower.contains("search") { return step("searching", "magnifyingglass") }
        return step("working on it", "gearshape")
    }
}

/// The plan's state from the newest TodoWrite (claude) or update_plan
/// (codex) among `messages`.
public func livePlanProgress(_ messages: [Message]) -> (index: Int, count: Int, step: String?)? {
    guard let plan = messages.last(where: { $0.kind == .activity && ["todowrite", "update_plan"].contains($0.tool?.name.lowercased() ?? "") }),
          let args = fields(plan.tool?.input),
          let items = (args["todos"] as? [[String: Any]]) ?? (args["plan"] as? [[String: Any]]),
          items.count >= 2 else { return nil }
    let steps = Array(items.prefix(40))
    func status(_ item: [String: Any]) -> String { (item["status"] as? String ?? "").lowercased() }
    guard let at = steps.firstIndex(where: { status($0) == "in_progress" }) ?? steps.firstIndex(where: { status($0) != "completed" }) else {
        return (steps.count, steps.count, nil)
    }
    let text = string(steps[at]["activeForm"]) ?? string(steps[at]["content"]) ?? string(steps[at]["step"])
    let clean = text.map { raw in
        raw.split(separator: " ").map { word in
            word.contains("/") || word.contains("\\") ? (word.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "") : String(word)
        }.joined(separator: " ").replacingOccurrences(of: "`", with: "").lowercased()
    }
    return (at + 1, steps.count, clean.map { cap($0, 40) })
}

/// What a working bot is doing now, from this job's messages: the newest
/// real tool step plus the plan. nil before any tool ran, so the caller
/// keeps the last real step instead of a bare "thinking".
public func liveStep(_ messages: [Message], since: Date? = nil) -> LiveStep? {
    let floor = (since?.timeIntervalSince1970 ?? 0) * 1000 - 1000
    let job = messages.filter { $0.at >= floor }
    let plan = livePlanProgress(job)
    guard let last = job.last(where: { $0.kind == .activity && $0.tool?.itemId != nil && !($0.tool?.name ?? "").isEmpty }),
          let tool = last.tool else {
        return plan.map { LiveStep(line: "working on it", symbol: "gearshape", stepIndex: $0.index, stepCount: $0.count, planStep: $0.step) }
    }
    var step = liveToolStep(name: tool.name, summary: tool.summary, input: tool.input)
    step.stepIndex = plan?.index
    step.stepCount = plan?.count
    step.planStep = plan?.step
    return step
}

/// The start of a job's message as a five-word title, when the thread has
/// no short name of its own: preambles dropped, the first sentence.
public func liveJobTitle(threadTitle: String?, message: String?) -> String? {
    if let title = threadTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty, title != "Untitled thread",
       !title.hasSuffix("…"), title.count <= liveLimit, title.split(separator: " ").count <= 6 {
        return title.lowercased()
    }
    guard var body = message?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty else { return nil }
    while let range = body.range(of: #"^\[[^\]\n]{0,400}\]\s*"#, options: .regularExpression) { body.removeSubrange(range) }
    if let range = body.range(of: #"^sent from a live voice call:[^.\n]*(?:\.[^.\n]*)?\.\s*"#, options: [.regularExpression, .caseInsensitive]) {
        body.removeSubrange(range)
    }
    let line = body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first(where: { !$0.isEmpty }) ?? ""
    let sentence = line.range(of: #"[.?!]\s"#, options: .regularExpression).map { String(line[..<$0.lowerBound]) } ?? line
    let words = sentence.replacingOccurrences(of: #"[`*_#>]+"#, with: "", options: .regularExpression)
        .split(separator: " ").map(String.init)
        .filter { !$0.hasPrefix("http") && !$0.contains("/") }
    guard !words.isEmpty else { return nil }
    var title = words.prefix(5).joined(separator: " ").replacingOccurrences(of: #"[,:;.!?]+$"#, with: "", options: .regularExpression)
    if title.count > liveLimit { title = String(title.prefix(liveLimit - 1)).trimmingCharacters(in: .whitespaces) + "…" }
    else if words.count > 5 { title += "…" }
    return title.lowercased()
}
