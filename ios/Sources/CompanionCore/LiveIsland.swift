// The 3.0 live island's pure half: which line it says, and which phase it
// is in. The view (App/LiveIslandBar.swift) only draws what this decides.
//
// A port of the desktop: `liveActivityLabel` (src/lib/live-activity.ts) and
// the island beats in src/components/ChatView.tsx — the composer folds into
// the island while a turn runs, opens on a tap, comes forward when the bot
// needs the person, and holds a short done beat when the turn ends.
import Foundation

/// The one quiet line shown while a bot works: "Thinking" before a tool
/// starts, then the current verb.
public enum LiveActivityLine {
    public static let thinking = "Thinking"
    public static let working = "Working"

    /// Matched against whole words of the tool's name, the way the desktop's
    /// `\b(?:…)\b` patterns do (an underscore is part of a word).
    static let fallbacks: [(words: Set<String>, label: String)] = [
        (["bash", "shell", "terminal", "exec", "command", "run_command"], "Running a command"),
        (["read", "read_file", "view", "open_file"], "Reading a file"),
        (["write", "write_file", "create_file"], "Writing a file"),
        (["edit", "apply_patch", "replace", "str_replace"], "Editing a file"),
        (["web_search", "search_web"], "Searching the web"),
        (["web_fetch", "fetch_url", "read_page"], "Reading a page"),
        (["grep", "glob", "find", "search"], "Searching"),
        (["screenshot", "screen_capture"], "Looking at the screen"),
        (["click", "type", "keypress", "press", "scroll", "computer"], "Using the computer"),
        (["open_url", "navigate"], "Opening a page"),
        (["list_bots", "list_agents"], "Checking who's around"),
        (["list_rooms"], "Checking the groups"),
        (["post_to_room"], "Posting in a group"),
        (["delegate_bot"], "Handing off a task"),
        (["ask_bot", "send_message"], "Asking a teammate"),
    ]

    /// The line for the newest message of the running turn. Anything but a
    /// tool still in flight reads as thinking; the server's own narration
    /// wins over the name-based fallback.
    public static func label(for message: Message?) -> String {
        guard let message, message.kind == .activity, let tool = message.tool,
              tool.ok == nil, message.comm == nil else { return thinking }
        if let spoken = tool.spoken, !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return sentenceCase(spoken)
        }
        let words = Set(words(in: toolName(tool.name)))
        for fallback in fallbacks where !fallback.words.isDisjoint(with: words) { return fallback.label }
        return working
    }

    /// `mcp__server__tool:arg` → `tool`.
    static func toolName(_ raw: String) -> String {
        var name = Substring(raw)
        if name.hasPrefix("mcp__") {
            let rest = name.dropFirst(5)
            if let range = rest.range(of: "__"), case let server = rest[..<range.lowerBound],
               !server.isEmpty, !server.contains("_") {
                name = rest[range.upperBound...]
            }
        }
        return String(name.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    }

    /// Runs of letters, digits and underscores, lowercased.
    static func words(in name: String) -> [String] {
        name.lowercased().split { !($0.isLetter || $0.isNumber || $0 == "_") }.map(String.init)
    }

    static func sentenceCase(_ value: String) -> String {
        var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = trimmed.last, last == "." || last.isWhitespace { trimmed.removeLast() }
        guard let first = trimmed.first else { return thinking }
        return first.uppercased() + trimmed.dropFirst()
    }
}

/// What the island says when the bot is waiting on the person: the pending
/// card's question, so the line alone tells you what you are being asked.
public enum LiveIslandAsk {
    /// The newest pending ask in the transcript, and the line for it.
    public static func pending(in messages: [Message]) -> (messageId: String, line: String)? {
        for message in messages.reversed() {
            if let card = message.card, card.isPending {
                let question = card.questions.first?.question.trimmed
                let line = [question, card.title.trimmed, card.subtitle.trimmed].compactMap { $0 }.first { !$0.isEmpty }
                return (message.id, line ?? "Waiting on you")
            }
            if let secret = message.secret, secret.isPending {
                let label = secret.label?.trimmed ?? ""
                return (message.id, label.isEmpty ? "A key is needed" : "Needs \(label)")
            }
        }
        return nil
    }
}

/// A send while the bot works folds into the running turn (steer is the
/// default); the island says "got it" for a moment when one lands. Matches
/// the desktop's src/lib/steer-ack.ts.
public enum LiveIslandSteer {
    /// One thread's newest steer, so a thread switch never reads as a new one.
    public struct Mark: Equatable, Sendable {
        public var thread: String
        public var id: String?
        public init(thread: String, id: String?) { self.thread = thread; self.id = id }
    }

    /// How long the island holds "got it".
    public static let holdSeconds: Double = 1.6

    /// The newest user message, when it is words the running turn took in.
    /// An earlier user message ends the search: anything older was answered.
    public static func lastSteeredId(in messages: [Message]) -> String? {
        for message in messages.reversed() where message.role == .user {
            return message.steered == true ? message.id : nil
        }
        return nil
    }

    /// Every steered id one thread has shown, so an id that drops out and
    /// comes back (a queued send sits after it for a moment, then moves to
    /// the queue) is never taken for a new one.
    public struct Seen: Equatable, Sendable {
        public var thread: String?
        public var ids: Set<String> = []
        public init() {}

        /// Records this mark and says whether it is a steer that landed
        /// while you watched: same thread, island working, an id this
        /// thread never showed. A new thread starts over without one.
        public mutating func note(_ mark: Mark, working: Bool) -> Bool {
            guard thread == mark.thread else {
                thread = mark.thread
                ids = mark.id.map { [$0] } ?? []
                return false
            }
            guard let id = mark.id else { return false }
            return ids.insert(id).inserted && working
        }
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The island's beats for one open thread.
///
/// Off unless 3.0 is on and the chat is a bot. While the turn runs it is
/// working (or needs-you, which the caller reads off the transcript); when
/// the turn ends in the same thread it holds a short done beat, then goes.
/// Switching threads resets everything without a done beat: the turn did
/// not end, you just left it.
public struct LiveIslandState: Equatable, Sendable {
    public enum Phase: String, Equatable, Sendable {
        case off, working, needsYou, done
    }

    /// How long the done face holds before the island goes: the desktop
    /// thread worker's 1600ms celebration (ThreadWorker.doneSeconds).
    public static let doneBeat: Double = ThreadWorker.doneSeconds

    public private(set) var threadId: String?
    public private(set) var busy = false
    /// The person tapped the island to type: the composer unfolds until the
    /// turn ends or the thread changes.
    public private(set) var open = false
    public private(set) var done = false
    /// Bumped by each done beat, so a late settle from an earlier beat
    /// cannot cut a newer one short.
    public private(set) var beat = 0

    public init() {}

    /// The open thread changed (or the island first appeared).
    public mutating func show(thread: String, busy: Bool) {
        guard thread != threadId else { busyChanged(busy); return }
        threadId = thread
        self.busy = busy
        open = false
        done = false
    }

    /// The thread's turn started or ended. Returns true when a done beat
    /// began; the caller settles it after `doneBeat` with the current `beat`.
    @discardableResult
    public mutating func busyChanged(_ nowBusy: Bool) -> Bool {
        defer { busy = nowBusy }
        if nowBusy {
            done = false
            return false
        }
        open = false
        guard busy else { return false }
        done = true
        beat += 1
        return true
    }

    /// Tapping the island opens the composer.
    public mutating func openComposer() {
        guard busy else { return }
        open = true
    }

    /// The done beat is over.
    public mutating func settle(beat: Int) {
        guard beat == self.beat else { return }
        done = false
    }

    public func phase(enabled: Bool, needsYou: Bool) -> Phase {
        guard enabled else { return .off }
        if busy { return needsYou ? .needsYou : .working }
        return done ? .done : .off
    }

    /// The composer folds into the island only while the bot just works:
    /// never when it needs you, never once you opened it or are typing.
    public func composerFolded(enabled: Bool, needsYou: Bool, focused: Bool) -> Bool {
        phase(enabled: enabled, needsYou: needsYou) == .working && !open && !focused
    }
}
