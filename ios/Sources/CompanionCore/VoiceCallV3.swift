// Voice calls v3: the pure half (plans/voice-v3/contract.md, shared/voice-call.ts).
//
// The wire types the phone sends the computer, the on-device job journal
// that keeps confirmed jobs until the computer says it has them, the noise
// gate in front of `send_task`, the desk that turns the model's tool calls
// into read-backs and journal writes, and the small policies (resume, memo,
// prewarm) the call engine follows. No sockets or audio here, so all of it
// is testable.
import Foundation

// MARK: - Wire types

public enum VoiceMic: String, Codable, Hashable, Sendable, CaseIterable {
    case phone, car
}

public struct VoiceRosterEntry: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct VoiceBrief: Codable, Hashable, Sendable {
    public var text: String
    public var builtAt: Double
    public init(text: String, builtAt: Double) { self.text = text; self.builtAt = builtAt }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        builtAt = try c.decodeIfPresent(Double.self, forKey: .builtAt) ?? 0
    }
}

public struct VoiceTranscriptLine: Codable, Hashable, Sendable {
    public enum Role: String, Codable, Hashable, Sendable { case user, bot }
    public var role: Role
    public var text: String
    /// ms since epoch
    public var at: Double?

    public init(role: Role, text: String, at: Double? = nil) {
        self.role = role
        self.text = text
        self.at = at
    }
}

public enum VoiceJobStatus: String, Codable, Hashable, Sendable {
    case said, confirmed, queued, sent, cancelled, failed

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = VoiceJobStatus(rawValue: raw) ?? .queued
    }
}

public struct VoiceJob: Codable, Hashable, Sendable {
    public var jobId: String
    public var text: String
    public var bot: String?
    public init(jobId: String, text: String, bot: String? = nil) {
        self.jobId = jobId
        self.text = text
        self.bot = bot
    }
}

public struct VoiceJobsRequest: Codable, Hashable, Sendable {
    public var callId: String
    public var botId: String
    public var jobs: [VoiceJob]
    public init(callId: String, botId: String, jobs: [VoiceJob]) {
        self.callId = callId
        self.botId = botId
        self.jobs = jobs
    }
}

public struct VoiceJobResult: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Hashable, Sendable {
        case sent, duplicate, failed
        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .failed
        }
    }

    public var jobId: String
    public var status: Status
    public var botId: String?
    public var botName: String?
    public var threadId: String?
    public var error: String?

    public init(jobId: String, status: Status, botId: String? = nil, botName: String? = nil, threadId: String? = nil, error: String? = nil) {
        self.jobId = jobId
        self.status = status
        self.botId = botId
        self.botName = botName
        self.threadId = threadId
        self.error = error
    }

    /// The computer has it: the journal may forget it.
    public var landed: Bool { status == .sent || status == .duplicate }
}

public struct VoiceJobsResponse: Codable, Hashable, Sendable {
    public var results: [VoiceJobResult]
    public init(results: [VoiceJobResult]) { self.results = results }
}

/// Counters for the computer's voice card. Encoded flat with `kind`.
public enum VoiceCallEvent: Codable, Hashable, Sendable {
    case start
    case firstAudio(ms: Int)
    case drop
    case resume(ms: Int)
    case unclear
    case memo
    case rating(good: Bool)

    private enum CodingKeys: String, CodingKey { case kind, ms, good }

    public var kind: String {
        switch self {
        case .start: return "start"
        case .firstAudio: return "first_audio"
        case .drop: return "drop"
        case .resume: return "resume"
        case .unclear: return "unclear"
        case .memo: return "memo"
        case .rating: return "rating"
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        switch self {
        case let .firstAudio(ms), let .resume(ms): try c.encode(max(0, ms), forKey: .ms)
        case let .rating(good): try c.encode(good, forKey: .good)
        default: break
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "start": self = .start
        case "first_audio": self = .firstAudio(ms: try c.decode(Int.self, forKey: .ms))
        case "drop": self = .drop
        case "resume": self = .resume(ms: try c.decode(Int.self, forKey: .ms))
        case "unclear": self = .unclear
        case "memo": self = .memo
        case "rating": self = .rating(good: try c.decode(Bool.self, forKey: .good))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown event \(kind)")
        }
    }
}

public struct VoiceCallEventRequest: Codable, Hashable, Sendable {
    public var callId: String
    public var botId: String
    public var event: VoiceCallEvent
    public init(callId: String, botId: String, event: VoiceCallEvent) {
        self.callId = callId
        self.botId = botId
        self.event = event
    }
}

public struct VoiceToolRequest: Codable, Hashable, Sendable {
    public var callId: String
    public var botId: String
    public var name: String
    public var args: [String: JSONValue]
    public var jobIds: [String]?
    public init(callId: String, botId: String, name: String, args: [String: JSONValue], jobIds: [String]? = nil) {
        self.callId = callId
        self.botId = botId
        self.name = name
        self.args = args
        self.jobIds = jobIds
    }
}

public struct VoiceToolResponse: Codable, Hashable, Sendable {
    public var output: String
    public init(output: String) { self.output = output }
}

public struct VoiceCallMetrics: Codable, Hashable, Sendable {
    public var drops: Int
    public var resumes: Int
    public var firstAudioMs: Int?
    public var inputRoute: String?
    public var outputRoute: String?
    public var mic: VoiceMic?
    public init(drops: Int = 0, resumes: Int = 0, firstAudioMs: Int? = nil, inputRoute: String? = nil,
                outputRoute: String? = nil, mic: VoiceMic? = nil) {
        self.drops = drops
        self.resumes = resumes
        self.firstAudioMs = firstAudioMs
        self.inputRoute = inputRoute
        self.outputRoute = outputRoute
        self.mic = mic
    }
}

/// One job in the end report: the job, where it stands, and where it went.
public struct VoiceCallEndJob: Codable, Hashable, Sendable {
    public var jobId: String
    public var text: String
    public var bot: String?
    public var status: VoiceJobStatus
    public var threadId: String?
    public var botId: String?
    public init(jobId: String, text: String, bot: String? = nil, status: VoiceJobStatus, threadId: String? = nil, botId: String? = nil) {
        self.jobId = jobId
        self.text = text
        self.bot = bot
        self.status = status
        self.threadId = threadId
        self.botId = botId
    }
}

public struct VoiceCallEndRequest: Codable, Hashable, Sendable {
    public var callId: String
    public var botId: String
    public var seconds: Int
    /// ms since epoch
    public var startedAt: Double
    public var transcript: [VoiceTranscriptLine]
    public var jobs: [VoiceCallEndJob]
    public var metrics: VoiceCallMetrics
    public init(callId: String, botId: String, seconds: Int, startedAt: Double, transcript: [VoiceTranscriptLine],
                jobs: [VoiceCallEndJob], metrics: VoiceCallMetrics) {
        self.callId = callId
        self.botId = botId
        self.seconds = max(0, seconds)
        self.startedAt = startedAt
        self.transcript = transcript
        self.jobs = jobs
        self.metrics = metrics
    }
}

public struct VoiceCallEndResponse: Codable, Hashable, Sendable {
    public var threadId: String
    public var messageId: String
}

/// The "voice chat" card on a chat message. Decoding never fails the
/// message: anything malformed leaves an empty card that is not drawn.
public struct VoiceCallCard: Codable, Hashable, Sendable {
    public struct Job: Codable, Hashable, Sendable, Identifiable {
        public var jobId: String
        public var text: String
        public var botId: String?
        public var botName: String?
        public var threadId: String?
        public var status: VoiceJobStatus
        public var id: String { jobId }
        public init(jobId: String, text: String, botId: String? = nil, botName: String? = nil, threadId: String? = nil, status: VoiceJobStatus) {
            self.jobId = jobId
            self.text = text
            self.botId = botId
            self.botName = botName
            self.threadId = threadId
            self.status = status
        }
    }

    public enum Rating: String, Codable, Hashable, Sendable { case good, bad }

    public var callId: String
    public var botId: String
    public var startedAt: Double
    public var seconds: Int
    public var transcript: [VoiceTranscriptLine]
    public var jobs: [Job]
    public var summary: String?
    public var drops: Int
    public var resumes: Int
    public var rating: Rating?

    public var isDrawable: Bool { !callId.isEmpty }

    public init(callId: String, botId: String, startedAt: Double = 0, seconds: Int = 0, transcript: [VoiceTranscriptLine] = [],
                jobs: [Job] = [], summary: String? = nil, drops: Int = 0, resumes: Int = 0, rating: Rating? = nil) {
        self.callId = callId
        self.botId = botId
        self.startedAt = startedAt
        self.seconds = seconds
        self.transcript = transcript
        self.jobs = jobs
        self.summary = summary
        self.drops = drops
        self.resumes = resumes
        self.rating = rating
    }

    public init(from decoder: any Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(callId: "", botId: "")
            return
        }
        self.init(
            callId: (try? c.decodeIfPresent(String.self, forKey: .callId)) ?? "",
            botId: (try? c.decodeIfPresent(String.self, forKey: .botId)) ?? "",
            startedAt: (try? c.decodeIfPresent(Double.self, forKey: .startedAt)) ?? 0,
            seconds: (try? c.decodeIfPresent(Double.self, forKey: .seconds)).flatMap { $0.map { Int($0) } } ?? 0,
            transcript: (try? c.decodeIfPresent([VoiceTranscriptLine].self, forKey: .transcript)) ?? [],
            jobs: (try? c.decodeIfPresent([Job].self, forKey: .jobs)) ?? [],
            summary: (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? nil,
            drops: (try? c.decodeIfPresent(Int.self, forKey: .drops)) ?? 0,
            resumes: (try? c.decodeIfPresent(Int.self, forKey: .resumes)) ?? 0,
            rating: (try? c.decodeIfPresent(Rating.self, forKey: .rating)) ?? nil
        )
    }
}

// MARK: - Durable file

/// A Codable value in one file, written atomically (write to a temp file,
/// then rename), so an app kill mid-write leaves the old copy or the new one.
public struct DurableFile<Value: Codable>: Sendable {
    public let url: URL

    public init(url: URL) { self.url = url }

    /// `Application Support/BosBot/<name>`.
    public static func applicationSupport(_ name: String) -> DurableFile {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return DurableFile(url: base.appendingPathComponent("BosBot", isDirectory: true).appendingPathComponent(name))
    }

    public func load() -> Value? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    public func save(_ value: Value) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(value)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: [.atomic])
        #endif
    }
}

/// A list of items keyed by id, persisted on every change. Used for the
/// call-end outbox and the memo queue.
public final class DurableOutbox<Item: Codable & Identifiable & Sendable>: @unchecked Sendable where Item.ID == String {
    private let file: DurableFile<[Item]>
    private let lock = NSLock()
    private var items: [Item]

    public init(file: DurableFile<[Item]>) {
        self.file = file
        items = file.load() ?? []
    }

    public var all: [Item] { lock.withLock { items } }

    /// Insert or replace by id; persisted before it returns.
    public func put(_ item: Item) throws {
        try lock.withLock {
            var next = items
            if let index = next.firstIndex(where: { $0.id == item.id }) { next[index] = item } else { next.append(item) }
            try file.save(next)
            items = next
        }
    }

    public func remove(_ id: String) {
        lock.withLock {
            let next = items.filter { $0.id != id }
            guard next.count != items.count else { return }
            items = next
            try? file.save(next)
        }
    }
}

// MARK: - Job journal

/// Confirmed jobs, on disk until the computer answers `sent` or `duplicate`
/// for them. Anything uncertain (no answer, an error, `failed`) keeps the
/// entry; resending is safe because the computer is idempotent on jobId.
public final class VoiceJobJournal: @unchecked Sendable {
    public struct Entry: Codable, Hashable, Sendable {
        public var callId: String
        public var botId: String
        public var job: VoiceJob
        /// ms since epoch
        public var savedAt: Double
        /// The call this job came from has hung up; a flush that lands it then
        /// tells the person with a notification.
        public var callEnded: Bool
        public init(callId: String, botId: String, job: VoiceJob, savedAt: Double, callEnded: Bool = false) {
            self.callId = callId
            self.botId = botId
            self.job = job
            self.savedAt = savedAt
            self.callEnded = callEnded
        }
    }

    public struct FlushOutcome: Equatable, Sendable {
        /// Every result the computer gave, landed or not.
        public var results: [VoiceJobResult]
        /// Jobs landed whose call had already ended.
        public var landedAfterCallEnd: Int
        /// Entries still waiting.
        public var remaining: Int
        public var landed: Int { results.filter(\.landed).count }
        public init(results: [VoiceJobResult] = [], landedAfterCallEnd: Int = 0, remaining: Int = 0) {
            self.results = results
            self.landedAfterCallEnd = landedAfterCallEnd
            self.remaining = remaining
        }
    }

    public typealias Sender = @Sendable (VoiceJobsRequest) async throws -> VoiceJobsResponse

    private let file: DurableFile<[Entry]>
    private let lock = NSLock()
    private var entries: [Entry]
    private var flushing = false
    private var flushAgain = false

    public init(file: DurableFile<[Entry]>) {
        self.file = file
        entries = file.load() ?? []
    }

    public static let shared = VoiceJobJournal(file: .applicationSupport("voice-job-journal.json"))

    public var all: [Entry] { lock.withLock { entries } }
    public var isEmpty: Bool { lock.withLock { entries.isEmpty } }

    public func contains(jobId: String) -> Bool { lock.withLock { entries.contains { $0.job.jobId == jobId } } }

    /// Persist a confirmed job. Returns only once it is on disk; throws if
    /// the write failed (and then nothing changed).
    public func append(_ entry: Entry) throws {
        try lock.withLock {
            guard !entries.contains(where: { $0.job.jobId == entry.job.jobId }) else { return }
            let next = entries + [entry]
            try file.save(next)
            entries = next
        }
    }

    public func markCallEnded(_ callId: String) {
        lock.withLock {
            guard entries.contains(where: { $0.callId == callId && !$0.callEnded }) else { return }
            entries = entries.map { entry in
                var entry = entry
                if entry.callId == callId { entry.callEnded = true }
                return entry
            }
            try? file.save(entries)
        }
    }

    /// Send everything waiting, one request per call. Only `sent` and
    /// `duplicate` answers remove an entry. A flush already running picks up
    /// this request when it finishes, so two never overlap.
    @discardableResult
    public func flush(send: Sender) async -> FlushOutcome {
        let start: Bool = lock.withLock {
            if flushing { flushAgain = true; return false }
            flushing = true
            return true
        }
        guard start else { return FlushOutcome(remaining: all.count) }
        var outcome = FlushOutcome()
        while true {
            let pass = await flushOnce(send: send)
            outcome.results += pass.results
            outcome.landedAfterCallEnd += pass.landedAfterCallEnd
            let again: Bool = lock.withLock {
                if flushAgain { flushAgain = false; return true }
                flushing = false
                return false
            }
            if !again { break }
        }
        outcome.remaining = all.count
        return outcome
    }

    private func flushOnce(send: Sender) async -> FlushOutcome {
        let snapshot = all
        var groups: [(key: String, callId: String, botId: String, entries: [Entry])] = []
        for entry in snapshot {
            let key = entry.callId + "\u{0}" + entry.botId
            if let index = groups.firstIndex(where: { $0.key == key }) { groups[index].entries.append(entry) }
            else { groups.append((key, entry.callId, entry.botId, [entry])) }
        }
        var outcome = FlushOutcome()
        for group in groups {
            let request = VoiceJobsRequest(callId: group.callId, botId: group.botId, jobs: group.entries.map(\.job))
            guard let response = try? await send(request) else { continue }
            let mine = Set(group.entries.map(\.job.jobId))
            let results = response.results.filter { mine.contains($0.jobId) }
            outcome.results += results
            let landed = Set(results.filter(\.landed).map(\.jobId))
            guard !landed.isEmpty else { continue }
            lock.withLock {
                outcome.landedAfterCallEnd += entries.filter { landed.contains($0.job.jobId) && $0.callEnded }.count
                entries.removeAll { landed.contains($0.job.jobId) }
                try? file.save(entries)
            }
        }
        return outcome
    }
}

// MARK: - Noise gate

/// In front of `send_task`: a request with fewer than three real words, or a
/// caller whose last line was empty or mostly noise and filler, gets "say
/// that again?" instead of a job.
public enum VoiceNoiseGate {
    public static let minimumWords = 3
    public static let fillers: Set<String> = [
        "uh", "uhh", "uhm", "um", "umm", "erm", "er", "ah", "ahh", "eh", "hmm", "hm", "mm", "mmm", "mhm", "huh", "oh",
        "ooh", "aa", "ehh", "lah", "leh", "lor", "ah-ha", "uh-huh", "hmmm",
    ]

    /// Words in `text` that are not bracketed tags (`[noise]`), not filler
    /// and carry at least one letter or digit.
    public static func realWords(_ text: String) -> [String] {
        tokens(text).filter { !isNoise($0) }
    }

    static func tokens(_ text: String) -> [String] {
        // Keep a bracketed tag as one token even when it holds spaces.
        var spaced = ""
        var depth = 0
        for character in text {
            if character == "[" || character == "(" || character == "<" { depth += 1 }
            if character == "]" || character == ")" || character == ">" { depth = max(0, depth - 1) }
            spaced.append(depth > 0 && character.isWhitespace ? "_" : character)
        }
        return spaced.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    static func isNoise(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .punctuationCharacters.subtracting(CharacterSet(charactersIn: "[]()<>")))
        if trimmed.hasPrefix("[") || trimmed.hasPrefix("(") || trimmed.hasPrefix("<") { return true }
        let word = trimmed.lowercased().trimmingCharacters(in: .punctuationCharacters)
        if word.isEmpty || !word.contains(where: { $0.isLetter || $0.isNumber }) { return true }
        return fillers.contains(word)
    }

    /// True when the last caller line is empty or at least half noise/filler.
    public static func isMostlyNoise(_ transcript: String?) -> Bool {
        let all = tokens(transcript ?? "")
        guard !all.isEmpty else { return true }
        let noise = all.filter(isNoise).count
        return noise * 2 >= all.count
    }

    public static func isUnclear(request: String, lastTranscript: String?) -> Bool {
        realWords(request).count < minimumWords || isMostlyNoise(lastTranscript)
    }
}

// MARK: - Transcript log

/// The call's transcript for the end report: one line per realtime item,
/// replaced as the transcriber revises it, kept in first-heard order.
public struct VoiceTranscriptLog: Sendable {
    private var order: [String] = []
    private var lines: [String: VoiceTranscriptLine] = [:]

    public init() {}

    public mutating func upsert(itemId: String, role: VoiceTranscriptLine.Role, text: String, at: Double) {
        let key = role.rawValue + ":" + itemId
        if var line = lines[key] {
            line.text = text
            lines[key] = line
        } else {
            order.append(key)
            lines[key] = VoiceTranscriptLine(role: role, text: text, at: at)
        }
    }

    public mutating func append(itemId: String, role: VoiceTranscriptLine.Role, fragment: String, at: Double) {
        let key = role.rawValue + ":" + itemId
        upsert(itemId: itemId, role: role, text: (lines[key]?.text ?? "") + fragment, at: at)
    }

    /// Lines with text, trimmed.
    public var transcript: [VoiceTranscriptLine] {
        order.compactMap { key in
            guard var line = lines[key] else { return nil }
            line.text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return line.text.isEmpty ? nil : line
        }
    }

    /// The caller's most recent line, for the noise gate. A newest line that
    /// is still being transcribed and has no text yet defers to the one before.
    public var lastCallerText: String? {
        let callers = order.filter { $0.hasPrefix("user:") }.compactMap { lines[$0]?.text }
        guard let last = callers.last else { return nil }
        if last.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, callers.count > 1 { return callers[callers.count - 2] }
        return last
    }
}

// MARK: - Desk

/// The client-owned tools of a v3 call: `send_task` (noise gate, then a
/// pending job read back to the caller) and `confirm_job` (journal first,
/// then "saved."). Keeps the call's jobs for the end report.
public final class VoiceCallDesk: @unchecked Sendable {
    public struct Reply: Equatable, Sendable {
        public var output: JSONValue
        public var event: VoiceCallEvent?
        /// A job landed in the journal: flush now.
        public var flush: Bool
        public init(output: JSONValue, event: VoiceCallEvent? = nil, flush: Bool = false) {
            self.output = output
            self.event = event
            self.flush = flush
        }
    }

    public static let unclear: JSONValue = ["status": "unclear", "say": "say that again?"]
    public static let saved: JSONValue = ["status": "saved", "say": "saved."]
    public static let cancelled: JSONValue = ["status": "cancelled"]
    public static let toolFallback = "couldn't reach the computer. want me to make it a job?"

    public let callId: String
    public let botId: String
    public let botName: String
    private let journal: VoiceJobJournal
    private let maxRequestChars: Int
    private let makeId: @Sendable () -> String
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var pending: [String: VoiceJob] = [:]
    private var pendingOrder: [String] = []
    private var records: [VoiceCallEndJob] = []

    public init(callId: String, botId: String, botName: String, journal: VoiceJobJournal, maxRequestChars: Int = 2000,
                makeId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
                now: @escaping @Sendable () -> Date = Date.init) {
        self.callId = callId
        self.botId = botId
        self.botName = botName
        self.journal = journal
        self.maxRequestChars = maxRequestChars
        self.makeId = makeId
        self.now = now
    }

    /// Every job said on this call and where it stands.
    public var jobs: [VoiceCallEndJob] { lock.withLock { records } }

    /// jobIds this call has confirmed, for `check_jobs`.
    public var confirmedJobIds: [String] {
        lock.withLock { records.filter { $0.status != .said && $0.status != .cancelled }.map(\.jobId) }
    }

    public func sendTask(arguments: String, lastTranscript: String?) -> Reply {
        let parsed = JSONValue.parse(arguments)
        switch RealtimeVoice.sendTaskRequest(arguments: arguments, maxChars: maxRequestChars) {
        case let .failure(rejection):
            if rejection == .empty { return Reply(output: Self.unclear, event: .unclear) }
            return Reply(output: ["error": .string(rejection.message)])
        case let .success(request):
            guard !VoiceNoiseGate.isUnclear(request: request, lastTranscript: lastTranscript) else {
                return Reply(output: Self.unclear, event: .unclear)
            }
            let bot = parsed?["bot"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            let routed = (bot?.isEmpty ?? true) ? nil : bot
            let job = VoiceJob(jobId: makeId(), text: request, bot: routed)
            lock.withLock {
                pending[job.jobId] = job
                pendingOrder.append(job.jobId)
                records.append(VoiceCallEndJob(jobId: job.jobId, text: job.text, bot: routed, status: .said))
            }
            let readback = Self.readback(parsed?["readback"]?.stringValue, bot: routed ?? botName, request: request)
            return Reply(output: ["status": "read_back", "job_id": .string(job.jobId), "say": .string(readback + ". go?")])
        }
    }

    static func readback(_ given: String?, bot: String, request: String) -> String {
        var text = (given ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { text = "\(bot): \(request)" }
        while let last = text.last, ".?!,;: ".contains(last) { text.removeLast() }
        return text
    }

    public func confirmJob(arguments: String) -> Reply {
        let parsed = JSONValue.parse(arguments)
        // Only an explicit go saves. A missing or garbled decision is not a
        // yes: the model has to ask again.
        let decision = (parsed?["decision"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard decision == "go" || decision == "cancel" || decision == "no" else {
            return Reply(output: ["status": "error", "error": "decision must be \"go\" or \"cancel\".", "say": "go or cancel?"])
        }
        let given = parsed?["job_id"]?.stringValue ?? ""
        let job: VoiceJob? = lock.withLock {
            if let job = pending[given] { return job }
            // A lone pending job is the one being confirmed even if the
            // model mangled the id.
            return pendingOrder.count == 1 ? pending[pendingOrder[0]] : nil
        }
        guard let job else {
            if journal.contains(jobId: given) { return Reply(output: Self.saved) }
            return Reply(output: ["status": "unknown_job", "say": "which job was that? say it again."])
        }
        if decision == "cancel" || decision == "no" {
            take(job.jobId, status: .cancelled)
            return Reply(output: Self.cancelled)
        }
        do {
            try journal.append(VoiceJobJournal.Entry(callId: callId, botId: botId, job: job,
                                                     savedAt: now().timeIntervalSince1970 * 1000))
        } catch {
            return Reply(output: ["status": "error", "say": "couldn't save that one. say it again?"])
        }
        take(job.jobId, status: .queued)
        return Reply(output: Self.saved, flush: true)
    }

    private func take(_ jobId: String, status: VoiceJobStatus) {
        lock.withLock {
            pending[jobId] = nil
            pendingOrder.removeAll { $0 == jobId }
            if let index = records.firstIndex(where: { $0.jobId == jobId }) { records[index].status = status }
        }
    }

    /// Fold a flush's answers into this call's records.
    public func apply(_ results: [VoiceJobResult]) {
        lock.withLock {
            for result in results {
                guard let index = records.firstIndex(where: { $0.jobId == result.jobId }) else { continue }
                if result.landed {
                    records[index].status = .sent
                    records[index].threadId = result.threadId ?? records[index].threadId
                    records[index].botId = result.botId ?? records[index].botId
                } else {
                    records[index].status = .failed
                }
            }
        }
    }

    /// Server tool arguments as an object.
    public static func toolArgs(_ arguments: String) -> [String: JSONValue] {
        if case let .object(object)? = JSONValue.parse(arguments) { return object }
        return [:]
    }
}

// MARK: - Policies

public enum VoiceResumePolicy {
    public static let maxAttempts = 5
    public static let window: TimeInterval = 20
    public static let spareMaxAge: TimeInterval = 240
    public static let instructions = "the line dropped and is back. say \"back.\" then in under ten words what the caller was saying."

    /// May attempt number `attempt` (1-based) start, `elapsed` seconds after the drop?
    public static func mayTry(attempt: Int, elapsed: TimeInterval) -> Bool {
        attempt <= maxAttempts && elapsed < window
    }

    /// Delay before attempt `attempt` (1-based): the first at once, then short steps.
    public static func delay(attempt: Int) -> TimeInterval {
        attempt <= 1 ? 0 : min(4, 0.5 * Double(attempt - 1))
    }
}

/// A pre-minted call start kept for a reconnect or a dial.
public struct VoiceMintedStart: Sendable {
    public var start: VoiceCallStart
    public var mintedAt: Date
    public init(start: VoiceCallStart, mintedAt: Date) {
        self.start = start
        self.mintedAt = mintedAt
    }

    /// Fresh: minted under `maxAge` ago and its secret not about to expire.
    public func isFresh(now: Date, maxAge: TimeInterval = VoiceResumePolicy.spareMaxAge) -> Bool {
        let age = now.timeIntervalSince(mintedAt)
        guard age >= 0, age < maxAge else { return false }
        let expires = start.credential.expiresAt
        return expires <= 0 || expires > now.timeIntervalSince1970 + 10
    }
}

/// Prewarmed starts per bot: at most 240 s old, used once.
public final class VoicePrewarmCache: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: (minted: VoiceMintedStart, language: String?, callId: String)] = [:]

    public init() {}
    public static let shared = VoicePrewarmCache()

    public func store(botId: String, language: String?, callId: String, start: VoiceCallStart, at: Date) {
        lock.withLock { entries[botId] = (VoiceMintedStart(start: start, mintedAt: at), language, callId) }
    }

    /// The fresh prewarmed start for this bot and language, removed from the cache.
    public func take(botId: String, language: String?, now: Date) -> (start: VoiceCallStart, callId: String)? {
        lock.withLock {
            guard let entry = entries.removeValue(forKey: botId), entry.language == language,
                  entry.minted.isFresh(now: now) else { return nil }
            return (entry.minted.start, entry.callId)
        }
    }

    public func hasFresh(botId: String, now: Date) -> Bool {
        lock.withLock { entries[botId]?.minted.isFresh(now: now) ?? false }
    }
}

public enum VoiceMemoPolicy {
    /// Record a memo instead of failing: the network is the problem, not the
    /// computer's answer. 401/403/404/409 (unpaired, refused, gone, no key)
    /// and bad addresses never record.
    public static func shouldRecordMemo(for error: any Error) -> Bool {
        if error is CancellationError { return false }
        if let api = error as? APIError {
            switch api {
            case .transport: return true
            case .badURL: return false
            case let .status(code, _): return code == 408 || code == 429 || (500...599).contains(code)
            }
        }
        if error is RealtimeVoice.URLError { return false }
        if let url = error as? URLError {
            return url.code != .cancelled && url.code != .badURL && url.code != .unsupportedURL
        }
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain || ns.domain == NSPOSIXErrorDomain
    }

    public static let messageText = "voice memo from a call that couldn't connect. list each job in it, one per line, and ask me to confirm each one here before starting any."
}

/// A voice memo waiting to go to the bot that was called.
public struct VoiceMemoItem: Codable, Hashable, Identifiable, Sendable {
    /// Uppercase UUID: doubles as the upload id and the send id seed.
    public var id: String
    public var callId: String
    public var botId: String
    public var threadId: String?
    public var fileName: String
    /// ms since epoch
    public var recordedAt: Double
    /// Set once the upload landed, so a retry does not upload twice.
    public var uploadedPath: String?

    public init(id: String, callId: String, botId: String, threadId: String?, fileName: String, recordedAt: Double, uploadedPath: String? = nil) {
        self.id = id
        self.callId = callId
        self.botId = botId
        self.threadId = threadId
        self.fileName = fileName
        self.recordedAt = recordedAt
        self.uploadedPath = uploadedPath
    }

    public var sendId: String { "voice-memo-" + id.lowercased() }
}

extension VoiceCallEndRequest: Identifiable {
    public var id: String { callId }
}

/// POST /api/voice/call/summary: the screen a call ends on.
public struct VoiceCallSummaryRequest: Codable, Hashable, Sendable {
    public var callId: String
    public var botId: String
    public var seconds: Int

    public init(callId: String, botId: String, seconds: Int) {
        self.callId = callId
        self.botId = botId
        self.seconds = seconds
    }
}

/// What a call cost, what's left to spend, and where its jobs are now.
public struct VoiceCallSummary: Codable, Hashable, Sendable {
    public struct Job: Codable, Hashable, Sendable, Identifiable {
        public enum State: String, Codable, Sendable {
            case working
            case needsYou = "needs_you"
            case done
        }
        public var jobId: String
        public var text: String
        /// nil from a computer older than this field
        public var botId: String?
        public var botName: String
        public var threadId: String
        public var state: State
        /// the newest bot line, plain text
        public var last: String?
        public var id: String { jobId }

        public init(jobId: String, text: String, botId: String? = nil, botName: String, threadId: String, state: State, last: String? = nil) {
            self.jobId = jobId
            self.text = text
            self.botId = botId
            self.botName = botName
            self.threadId = threadId
            self.state = state
            self.last = last
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            jobId = try c.decode(String.self, forKey: .jobId)
            text = try c.decode(String.self, forKey: .text)
            botId = try c.decodeIfPresent(String.self, forKey: .botId)
            botName = try c.decodeIfPresent(String.self, forKey: .botName) ?? ""
            threadId = try c.decode(String.self, forKey: .threadId)
            // a state this build doesn't know reads as done
            state = (try? c.decode(State.self, forKey: .state)) ?? .done
            last = try c.decodeIfPresent(String.self, forKey: .last)
        }
    }

    public struct Month: Codable, Hashable, Sendable {
        public var calls: Int
        public var seconds: Double
        public var rm: Double
    }

    /// xAI prepaid credits, US cents.
    public struct Credits: Codable, Hashable, Sendable {
        public var remainingCents: Double
        public var usedCents: Double
        public var purchasedCents: Double
        public var fetchedAt: Double?
    }

    /// this call's rough cost, rm
    public var rm: Double
    public var rmPerMinute: Double
    public var month: Month
    /// nil without a management key on the computer, or when xAI's billing
    /// could not be read
    public var credits: Credits?
    public var creditsConfigured: Bool
    public var jobs: [Job]

    public var anyWorking: Bool { jobs.contains { $0.state == .working } }

    public static func rm(_ value: Double) -> String { String(format: "RM %.2f", value) }
    public static func usd(cents: Double) -> String { String(format: "$%.2f", cents / 100) }
}
