// The Live Activity's contract — compiled into both the app and the widget
// extension, so the two agree on what a bot's island says.
//
// One activity per bot that is doing something: needs you, or working.
// Quiet bots have no activity, the same rule as the Updates pill.
import ActivityKit
import AppIntents
import Foundation
import CompanionCore

struct BotActivityAttributes: ActivityAttributes {
    public typealias ContentState = BotActivityContent

    var botId: String
    /// Retained to decode existing activities. Routing uses ContentState.
    var threadId: String
    var name: String
    /// A MausPalette colour name or "#RRGGBB".
    var color: String
    /// Optional so activities created by older app builds still decode.
    var mascotBody: String?
    /// Optional for the same reason; nil is the glyph face.
    var mascotEyes: String? = nil
}

/// Answer from the island or the lock screen. A `LiveActivityIntent` runs in
/// the app's own process, so the app wires `handler` at launch and the
/// widget copy of this type never performs anything itself.
struct AnswerApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Answer"
    static var isDiscoverable = false

    @Parameter(title: "Thread") var threadId: String
    @Parameter(title: "Request") var requestId: String
    @Parameter(title: "Choice") var choice: String
    @Parameter(title: "Permission") var isPermission: Bool

    init() {}
    init(threadId: String, requestId: String, choice: String, isPermission: Bool) {
        self.threadId = threadId
        self.requestId = requestId
        self.choice = choice
        self.isPermission = isPermission
    }

    /// Set by the app at launch. Nil in the widget extension.
    nonisolated(unsafe) static var handler: ((_ threadId: String, _ requestId: String, _ choice: String, _ isPermission: Bool) async -> Void)?

    func perform() async throws -> some IntentResult {
        await Self.handler?(threadId, requestId, choice, isPermission)
        return .result()
    }
}

/// Stop the bot's turn from the expanded island or the lock screen. Runs in
/// the app's process like `AnswerApprovalIntent`.
struct StopBotIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop"
    static var isDiscoverable = false

    @Parameter(title: "Bot") var botId: String
    @Parameter(title: "Thread") var threadId: String

    init() {}
    init(botId: String, threadId: String) {
        self.botId = botId
        self.threadId = threadId
    }

    /// Set by the app at launch. Nil in the widget extension.
    nonisolated(unsafe) static var handler: ((_ botId: String, _ threadId: String) async -> Void)?

    func perform() async throws -> some IntentResult {
        await Self.handler?(botId, threadId)
        return .result()
    }
}

/// Where tapping a bot's activity lands: that exact thread.
enum BotActivityLink {
    static func thread(botId: String, threadId: String?) -> URL? {
        var parts = URLComponents()
        parts.scheme = "bosbot"
        parts.host = "thread"
        parts.queryItems = [URLQueryItem(name: "bot", value: botId), URLQueryItem(name: "thread", value: threadId ?? "")]
        return threadId?.isEmpty == false ? parts.url : nil
    }

    static func call(_ bot: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "bosbot"
        parts.host = "call"
        parts.queryItems = [URLQueryItem(name: "bot", value: bot)]
        return parts.url
    }

    /// "Call me" on a done card: a call that opens with the result.
    static func callBack(botId: String, threadId: String?, result: String) -> URL? {
        guard let threadId, !threadId.isEmpty else { return call(botId) }
        var parts = URLComponents()
        parts.scheme = "bosbot"
        parts.host = "call"
        parts.queryItems = [URLQueryItem(name: "bot", value: botId), URLQueryItem(name: "thread", value: threadId),
                            URLQueryItem(name: "result", value: String(result.prefix(160)))]
        return parts.url
    }
}

/// "Peek" on a working card: the card shows the plan and the last few steps
/// for a moment, without opening the app. Runs in the app's process.
struct PeekBotIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Peek"
    static var isDiscoverable = false

    @Parameter(title: "Bot") var botId: String

    init() {}
    init(botId: String) { self.botId = botId }

    /// Set by the app at launch. Nil in the widget extension.
    nonisolated(unsafe) static var handler: ((_ botId: String) async -> Void)?

    func perform() async throws -> some IntentResult {
        await Self.handler?(botId)
        return .result()
    }
}

/// The Control Center / lock screen control's action. It only opens the app
/// on a call link, so it works from whichever process iOS performs it in.
@available(iOS 18.0, *)
struct OpenBotCallIntent: AppIntent {
    static var title: LocalizedStringResource = "Call a bot"
    static var isDiscoverable = false

    @Parameter(title: "Bot") var bot: String

    init() {}
    init(bot: String) { self.bot = bot }

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(BotActivityLink.call(bot) ?? URL(string: "bosbot://call")!))
    }
}
