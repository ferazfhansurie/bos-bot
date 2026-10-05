import Foundation

/// The job inbox: one row per readable bot/thread work plan, read from
/// GET /api/jobs (shared/job-inbox.ts). A read-only projection — opening it
/// never dispatches, resumes or mutates anything. Completion evidence is what
/// its owner reported, never an independent artifact verification, so every
/// result keeps the bot that reported it.
public struct JobInboxResponse: Decodable, Sendable, Equatable {
    public var items: [JobInboxItem]

    public init(items: [JobInboxItem]) { self.items = items }

    private enum CodingKeys: String, CodingKey { case items }

    /// One malformed plan must not blank the whole inbox: unreadable items
    /// are dropped and the rest still render.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        var list = try container.nestedUnkeyedContainer(forKey: .items)
        var items: [JobInboxItem] = []
        while !list.isAtEnd {
            if let item = try? list.decode(JobInboxItem.self) {
                items.append(item)
            } else {
                _ = try? list.decode(Discarded.self)
            }
        }
        self.items = items
    }

    private struct Discarded: Decodable {}
}

/// Job state as the server derives it from running, Stop and human-gate
/// facts. A state this build does not know yet is kept verbatim and shown
/// as waiting rather than guessed into something more urgent.
public enum JobState: Hashable, Sendable, Decodable {
    case ready, moving, needsYou, paused, blocked, waiting, completed
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "ready": self = .ready
        case "moving": self = .moving
        case "needs-you": self = .needsYou
        case "paused": self = .paused
        case "blocked": self = .blocked
        case "waiting": self = .waiting
        case "completed": self = .completed
        default: self = .unknown(rawValue)
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public var label: String {
        switch self {
        case .ready: return "Ready"
        case .moving: return "Moving"
        case .needsYou: return "Needs you"
        case .paused: return "Paused"
        case .blocked: return "Blocked"
        case .waiting, .unknown: return "Waiting"
        case .completed: return "Done"
        }
    }

    /// What the person should look at first: anything held for them, then
    /// blocked work, then work in motion; finished jobs sink to the bottom.
    public var rank: Int {
        switch self {
        case .needsYou: return 0
        case .blocked: return 1
        case .moving: return 2
        case .paused: return 3
        case .ready: return 4
        case .waiting, .unknown: return 5
        case .completed: return 6
        }
    }
}

public struct JobInboxStep: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var ownerBotId: String
    public var action: String
    /// ready | waiting | blocked | done; kept as text so a newer status
    /// still renders instead of failing the whole plan.
    public var status: String
    public var dependsOn: [String]
    public var reason: String?
    public var evidence: String?

    public init(id: String, ownerBotId: String, action: String, status: String, dependsOn: [String] = [], reason: String? = nil, evidence: String? = nil) {
        self.id = id; self.ownerBotId = ownerBotId; self.action = action
        self.status = status; self.dependsOn = dependsOn; self.reason = reason; self.evidence = evidence
    }

    private enum CodingKeys: String, CodingKey { case id, ownerBotId, action, status, dependsOn, reason, evidence }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ownerBotId = try c.decode(String.self, forKey: .ownerBotId)
        action = try c.decode(String.self, forKey: .action)
        status = try c.decode(String.self, forKey: .status)
        dependsOn = try c.decodeIfPresent([String].self, forKey: .dependsOn) ?? []
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        evidence = try c.decodeIfPresent(String.self, forKey: .evidence)
    }

    public var isDone: Bool { status == "done" }
}

/// Evidence a step's owner reported. `source` is always owner-reported on
/// the current contract; the app labels it that way rather than as proof.
public struct JobInboxResult: Decodable, Hashable, Sendable {
    public var stepId: String
    public var ownerBotId: String
    public var evidence: String
    public var source: String

    public init(stepId: String, ownerBotId: String, evidence: String, source: String = "owner-reported") {
        self.stepId = stepId; self.ownerBotId = ownerBotId; self.evidence = evidence; self.source = source
    }
}

public struct JobInboxItem: Decodable, Hashable, Sendable, Identifiable {
    public var botId: String
    public var threadId: String
    public var revision: Int
    public var outcome: String
    public var state: JobState
    public var reason: String?
    public var steps: [JobInboxStep]
    public var results: [JobInboxResult]

    public var id: String { "\(botId):\(threadId)" }

    public init(botId: String, threadId: String, revision: Int = 1, outcome: String, state: JobState, reason: String? = nil, steps: [JobInboxStep] = [], results: [JobInboxResult] = []) {
        self.botId = botId; self.threadId = threadId; self.revision = revision; self.outcome = outcome
        self.state = state; self.reason = reason; self.steps = steps; self.results = results
    }

    private enum CodingKeys: String, CodingKey { case botId, threadId, revision, outcome, state, reason, steps, results }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try c.decode(String.self, forKey: .botId)
        threadId = try c.decode(String.self, forKey: .threadId)
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        outcome = try c.decode(String.self, forKey: .outcome)
        state = try c.decode(JobState.self, forKey: .state)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        steps = Self.lossy(c, .steps)
        results = Self.lossy(c, .results)
    }

    private static func lossy<T: Decodable>(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [T] {
        guard var list = try? c.nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [T] = []
        while !list.isAtEnd {
            if let value = try? list.decode(T.self) { out.append(value) }
            else if (try? list.decode(Discarded.self)) == nil { break }
        }
        return out
    }

    private struct Discarded: Decodable {}

    /// Helper bots with a step in this job, in plan order, excluding the
    /// lead that owns the thread.
    public var helperBotIds: [String] {
        var seen: Set<String> = [botId]
        return steps.map(\.ownerBotId).filter { seen.insert($0).inserted }
    }

    /// The next piece of work: the first unfinished step that can run, then
    /// the first unfinished step at all. Nil once every step is done.
    public var nextStep: JobInboxStep? {
        steps.first { $0.status == "ready" } ?? steps.first { !$0.isDone }
    }

    public var doneCount: Int { steps.filter(\.isDone).count }
}

/// Needs-you first, finished last; the server's order breaks ties.
public func orderedJobs(_ items: [JobInboxItem]) -> [JobInboxItem] {
    items.enumerated()
        .sorted { lhs, rhs in
            let left = lhs.element.state.rank, right = rhs.element.state.rank
            return left == right ? lhs.offset < rhs.offset : left < right
        }
        .map(\.element)
}

/// Where a job row leads: always an existing conversation, never a new one.
public enum JobDestination: Equatable, Sendable {
    /// A direct bot thread, projected locally with no server call.
    case bot(Bot)
    /// A room thread. `selected` is false when the room currently shows a
    /// different thread and the existing room task switch must run first.
    case room(Room, selected: Bool)
}

extension CompanionState {
    /// The existing conversation a job lives in, or nil when this phone's
    /// roster cannot see it yet — a missing destination leaves navigation
    /// untouched rather than inventing a thread.
    public func destination(for job: JobInboxItem) -> JobDestination? {
        if let bot = bot(forThread: job.threadId) { return .bot(bot) }
        if let room = rooms.first(where: { $0.threadId == job.threadId }) {
            return .room(room, selected: true)
        }
        if let room = rooms.first(where: { $0.tasks?.contains(where: { $0.threadId == job.threadId }) == true }) {
            return .room(room, selected: false)
        }
        return nil
    }

    /// A bot's display name for an owner id, falling back to the id so an
    /// owner this phone cannot resolve is still attributed, not hidden.
    public func ownerName(_ botId: String) -> String {
        bot(botId)?.name ?? botId
    }
}
