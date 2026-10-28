// Voice calls and the work they hand off: the pure half.
//
// What a call posts into the thread (the caller's own words, not the
// model's retelling), which bot lines it reads back (settled ones only), and
// the two pushes that reach a phone about calls: "<bot> is done" for work
// asked for on a call, and a bot ringing its owner. The app target owns the
// socket, the notifications and the screens.
import Foundation

// MARK: - What lands in the thread

/// The thread text for one `send_task`: the caller's own words since the
/// previous one, verbatim, first person. The model's `request` rides along
/// as `origin.job` and only becomes the text when nothing was transcribed.
public struct VoiceCallAsk: Equatable, Sendable {
    public var text: String
    public var job: String

    public static let repeatWindowSeconds: Double = 30

    public init(text: String, job: String) {
        self.text = text
        self.job = job
    }

    /// `spoken` is the caller's transcribed lines not yet sent, oldest first.
    public static func make(spoken: [String], request: String) -> VoiceCallAsk {
        let words = spoken
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let job = request.trimmingCharacters(in: .whitespacesAndNewlines)
        return VoiceCallAsk(text: words.isEmpty ? job : words, job: job)
    }

    /// Same text twice inside 30 s on one call is one ask, not two.
    public func repeats(_ previous: (text: String, at: Date)?, now: Date) -> Bool {
        guard let previous, now.timeIntervalSince(previous.at) < Self.repeatWindowSeconds else { return false }
        return Self.normalized(previous.text) == Self.normalized(text)
    }

    static func normalized(_ text: String) -> String {
        text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

// MARK: - What the call reads back

extension RealtimeVoice {
    /// The bot lines a call may speak: new text since the first send, and
    /// only settled text. While the bot is busy that means the turn's last
    /// line (`turnTerminal`); once it is idle, whatever it wrote. Activity
    /// and tool lines never qualify. Mirrors desktop `landedReplies`.
    public static func landedReplies(_ messages: [Message], since: Double, busy: Bool,
                                     delivered: Set<String>) -> [Message] {
        messages.filter { message in
            message.role == .bot && message.kind == .text && message.at >= since
                && !delivered.contains(message.id)
                && !(message.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && (message.turnTerminal == true || !busy)
        }
    }

    /// How a call opens when it is returning to finished work.
    public static func callBackOpener(botName: String, result: String) -> String {
        let result = String(result.trimmingCharacters(in: .whitespacesAndNewlines).prefix(asyncUpdateLimit))
        return "You are calling back about work they asked you for on an earlier call, and it is done. "
            + "Open by telling them the outcome in one or two plain spoken sentences, then ask if they want more. "
            + "Do not introduce yourself. What you finished: \(result.isEmpty ? "the job they asked for" : result)"
    }

    /// How a call opens when the bot rang back because work given on an
    /// earlier call settled: the result first, then an offer of details.
    public static func jobDoneOpener(result: String) -> String {
        let result = String(result.trimmingCharacters(in: .whitespacesAndNewlines).prefix(asyncUpdateLimit))
        return "You rang them back because work they gave you on an earlier call has settled, and they just picked up. "
            + "Open with the result in one or two plain spoken sentences, then ask \"want the details?\". "
            + "If it stopped, say so plainly and why. Do not introduce yourself. "
            + "The result: \(result.isEmpty ? "the work they asked for is done" : result)"
    }

    /// What a live call is told when a voice job settles mid-call.
    public static func settledUpdate(botName: String, result: String) -> String {
        let result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        return "Work they gave you on a call just came back from \(botName): \(result.isEmpty ? "it's done." : result) "
            + "Tell them the result in a sentence when there's a natural pause, then ask if they want the details."
    }

    /// The opener for a picked-up ring: a call-back leads with its result.
    public static func opener(for ring: VoiceRing) -> String {
        ring.purpose == VoiceRing.jobDone ? jobDoneOpener(result: ring.reason) : ringOpener(reason: ring.reason)
    }

    /// How a call opens when the caller picked up a bot's ring.
    public static func ringOpener(reason: String) -> String {
        let reason = String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(asyncUpdateLimit))
        return "You rang them and they just picked up. Open by saying why you called in one or two plain spoken sentences. "
            + "Do not introduce yourself. Why you called: \(reason.isEmpty ? "you need them for a moment" : reason)"
    }
}

// MARK: - Rings and pushes

/// A bot ringing its owner: the `voice_ring` stream frame and push data.
public struct VoiceRing: Codable, Hashable, Identifiable, Sendable {
    public var ringId: String
    public var botId: String
    public var threadId: String?
    public var reason: String
    /// The computer rang a phone that had the app on screen in-app only, with
    /// no VoIP push: ring here now instead of waiting for CallKit.
    public var inApp: Bool
    /// Why the computer rang: `job_done` is a call-back with a voice job's
    /// result. Older computers send none.
    public var purpose: String?

    public static let jobDone = "job_done"
    public var id: String { ringId }

    public init(ringId: String, botId: String, threadId: String?, reason: String, inApp: Bool = false, purpose: String? = nil) {
        self.ringId = ringId
        self.botId = botId
        self.threadId = threadId
        self.reason = reason
        self.inApp = inApp
        self.purpose = purpose
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ringId = try c.decode(String.self, forKey: .ringId)
        botId = try c.decode(String.self, forKey: .botId)
        threadId = try c.decodeIfPresent(String.self, forKey: .threadId).flatMap { $0.isEmpty ? nil : $0 }
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
        inApp = try c.decodeIfPresent(Bool.self, forKey: .inApp) ?? false
        purpose = try c.decodeIfPresent(String.self, forKey: .purpose).flatMap { $0.isEmpty ? nil : $0 }
        guard !ringId.isEmpty, !botId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .ringId, in: c, debugDescription: "empty ring")
        }
    }
}

/// The typed data a push carries for the voice features.
public enum VoicePush: Equatable, Sendable {
    case workDone(botId: String, threadId: String, callId: String?, messageId: String?)
    case ring(VoiceRing)

    public static let workDoneCategory = "VOICE_WORK_DONE"
    public static let ringCategory = "VOICE_RING"
    public static let callBackAction = "VOICE_CALL_BACK"
    public static let acceptAction = "VOICE_ACCEPT"
    public static let declineAction = "VOICE_DECLINE"

    /// Push userInfo (or a local notification's) flattened to strings.
    /// Done pushes from the stream say `kind`; APNs ones also say `type`.
    public init?(payload: [String: String]) {
        let type = payload["type"] ?? payload["kind"]
        switch type {
        case "voice_work_done":
            guard let botId = payload["botId"], !botId.isEmpty,
                  let threadId = payload["threadId"], !threadId.isEmpty else { return nil }
            self = .workDone(botId: botId, threadId: threadId,
                             callId: payload["callId"].flatMap { $0.isEmpty ? nil : $0 },
                             messageId: payload["messageId"].flatMap { $0.isEmpty ? nil : $0 })
        case "voice_ring":
            guard let ringId = payload["ringId"], !ringId.isEmpty,
                  let botId = payload["botId"], !botId.isEmpty else { return nil }
            self = .ring(VoiceRing(ringId: ringId, botId: botId,
                                   threadId: payload["threadId"].flatMap { $0.isEmpty ? nil : $0 },
                                   reason: payload["reason"] ?? "",
                                   purpose: payload["purpose"].flatMap { $0.isEmpty ? nil : $0 }))
        default:
            return nil
        }
    }

    public var category: String {
        switch self {
        case .workDone: return Self.workDoneCategory
        case .ring: return Self.ringCategory
        }
    }
}
