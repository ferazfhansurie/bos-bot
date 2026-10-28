import Foundation

/// Mutable Live Activity state shared by the app and widget. An activity is
/// per bot, but its current request may belong to any of that bot's threads.
public struct BotActivityContent: Codable, Hashable, Sendable {
    public var face: String
    public var kind: String
    public var headline: String
    public var line: String
    /// Optional to decode activities created before thread-aware routing.
    /// Never fall back to the activity's immutable, original thread.
    public var threadId: String?
    public var requestId: String?
    public var options: [String]
    public var isPermission: Bool
    public var since: Date
    /// The thread the bot is on, so the lock screen says what it is about.
    /// Optional, like every field added after the first release, so an
    /// activity started by an older build still decodes.
    public var threadTitle: String? = nil
    /// SF Symbol for the current step ("terminal", "doc.text", …).
    public var symbol: String? = nil
    /// Other threads of the same bot doing something right now.
    public var otherThreads: Int? = nil
    /// When the turn finished; the done state shows a fixed duration.
    public var endedAt: Date? = nil
    /// Every bot at once when more than one is busy: "3 working · 1 needs
    /// you". The car view's one-glance line; nil with a single bot.
    public var summary: String? = nil
    /// A live voice call with this bot: what the call is doing right now
    /// ("listening", "sending to bos", …). See `LiveCallPhase`.
    public var call: String? = nil
    /// When the call started, so the car view's clock is the call's.
    public var callSince: Date? = nil
    /// When the whole job began. `since` carries the same time from newer
    /// Macs; older ones reset `since` on every state change, so the clock
    /// reads this first. See `clockStart`.
    public var jobSince: Date? = nil
    /// When the step line last changed, for the step's own sweep.
    public var stepSince: Date? = nil
    /// The plan's step in progress (1-based) and its size: "step 3 of 5".
    public var stepIndex: Int? = nil
    public var stepCount: Int? = nil
    /// The plan step in progress, as the bot wrote it.
    public var planStep: String? = nil
    /// The done card's one-line result.
    public var result: String? = nil
    /// The job's last few step lines, newest last, shown while peeking.
    public var recent: [String]? = nil
    /// "Peek" was tapped: the card shows the plan and `recent` until then.
    public var peekUntil: Date? = nil

    public init(
        face: String,
        kind: String,
        headline: String,
        line: String,
        threadId: String,
        card: OptionCard?,
        since: Date,
        threadTitle: String? = nil,
        symbol: String? = nil,
        otherThreads: Int? = nil
    ) {
        self.face = face
        self.kind = kind
        self.headline = headline
        self.line = line
        self.threadId = threadId
        self.requestId = card?.isPending == true ? card?.requestId : nil
        // Compact surfaces cannot show the reviewed SKILL.md. Keep the
        // alert, but require opening chat before answering a skill request.
        self.options = card?.isPending == true && card?.skillRequest == nil ? (card?.options ?? []) : []
        self.isPermission = card?.isPermission ?? false
        self.since = since
        self.threadTitle = threadTitle
        self.symbol = symbol
        self.otherThreads = otherThreads
    }

    /// One clock for the whole job, not the current state.
    public var clockStart: Date { jobSince ?? since }

    /// "step 3 of 5", when the bot is working from a plan.
    public var plan: (index: Int, count: Int)? {
        guard let stepCount, stepCount >= 2, let stepIndex, stepIndex >= 1 else { return nil }
        return (min(stepIndex, stepCount), stepCount)
    }

    public var planLabel: String? { plan.map { "step \($0.index) of \($0.count)" } }

    /// Showing the peek view right now.
    public func isPeeking(at now: Date = Date()) -> Bool {
        isWorking && (peekUntil.map { $0 > now } ?? false)
    }

    /// The one choice a lock-screen "Approve" can send by itself: an ask
    /// that is a plain yes/no, where the yes is unambiguous. Anything else
    /// (several choices, "always allow", a question) opens the approval.
    public var inlineApproval: String? {
        guard approvalThreadId != nil else { return nil }
        let yes = options.filter { Self.affirmative.contains($0.lowercased().trimmingCharacters(in: .whitespaces)) }
        guard yes.count == 1, options.count <= 2 else { return nil }
        return yes.first
    }

    private static let affirmative: Set<String> = ["allow", "allow once", "approve", "yes", "ok", "continue", "go ahead"]

    public var isWorking: Bool { kind == "working" }
    public var needsYou: Bool { kind == "needsYou" }
    /// The turn settled: shown briefly with the reply's first line, then ended.
    public var isDone: Bool { kind == "done" }

    /// The widget and intent handler use the same exact request target.
    /// Legacy content can remain visible, but cannot offer approval buttons.
    public var approvalThreadId: String? {
        guard kind == "needsYou", let threadId, !threadId.isEmpty,
              let requestId, !requestId.isEmpty, !options.isEmpty else { return nil }
        return threadId
    }

    /// The card's buttons for its state. Working: peek and open. Needs you:
    /// approve (inline when safe, else it opens the approval) and reply.
    /// Done: call me. Stop lives only in the expanded island.
    public func buttons(expanded: Bool) -> [LiveCardButton] {
        switch kind {
        case "needsYou":
            return [inlineApproval.map { .approve($0) } ?? .openApproval, .reply]
        case "done":
            return [.callMe]
        case "working":
            return expanded ? [.peek, .open, .stop] : [.peek, .open]
        default:
            return [.open]
        }
    }

    /// A rendered button can outlive the ask it displayed. Refuse stale or
    /// legacy intent payloads rather than approving another thread's request.
    public func canAnswer(threadId: String, requestId: String, choice: String, isPermission: Bool) -> Bool {
        approvalThreadId == threadId && self.requestId == requestId
            && options.contains(choice) && self.isPermission == isPermission
    }
}

/// One button on the live card. See `BotActivityContent.buttons(expanded:)`.
public enum LiveCardButton: Hashable, Sendable {
    case peek, open, stop, reply, callMe, openApproval
    /// Sends this choice through the existing answer path (and its checks).
    case approve(String)
}
