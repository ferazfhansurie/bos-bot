// Call a bot from outside the app: the action button, the Shortcuts app,
// Siri and Spotlight. Every intent opens the app straight into a live voice
// call — the same call the phone button in a chat header starts.
//
// The intents run in the app's own process (`openAppWhenRun`), but iOS may
// perform one before SwiftUI has built the session on a cold launch, so a
// request waits in `CallIntentRouter` until the session attaches, and the
// session then waits for the paired computer before dialling.
import AppIntents
import Combine
import CompanionCore
import Foundation
import SwiftUI

@MainActor
final class CallIntentRouter {
    static let shared = CallIntentRouter()

    private weak var session: Session?
    private var pending: (botId: String?, name: String?)?
    private var pendingThread: (botId: String, threadId: String)?
    private var rosterWatch: AnyCancellable?

    func attach(_ session: Session) {
        self.session = session
        rosterWatch = session.stateChanges
            .map { [weak session] state in
                let here = session?.connection?.name
                return state.bots.filter { $0.hidden != true }.map {
                    BotDirectory.Entry(id: $0.id, name: $0.name, home: $0.remote?.homeName ?? here,
                                       color: $0.color, mascotBody: $0.mascotBody, mascotEyes: $0.mascotEyes)
                }
            }
            .removeDuplicates()
            .debounce(for: .seconds(1), scheduler: DispatchQueue.main)
            .sink { entries in
                guard !entries.isEmpty else { return }
                let rendered = BotDirectory.renderMissingFaces(entries)
                guard BotDirectory.save(entries) || rendered else { return }
                BosShortcuts.updateAppShortcutParameters()
            }
        if let pendingThread {
            self.pendingThread = nil
            Task { await session.openThreadLink(botId: pendingThread.botId, threadId: pendingThread.threadId) }
        }
        if let pending {
            self.pending = nil
            Task { await session.callFromShortcut(botId: pending.botId, name: pending.name) }
        }
    }

    func call(botId: String? = nil, name: String? = nil) {
        guard let session else {
            pending = (botId, name)
            return
        }
        Task { await session.callFromShortcut(botId: botId, name: name) }
    }

    /// `bosbot://call?bot=<name or id>` and `bosbot://thread?bot=…&thread=…`.
    /// Returns false for anything else (a pairing link).
    func open(_ url: URL) -> Bool {
        guard ["bosbot", "openmausbot"].contains(url.scheme?.lowercased() ?? "") else { return false }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (key: String) in items.first { $0.name == key }?.value }
        switch url.host?.lowercased() {
        case "call":
            guard let bot = value("bot"), !bot.isEmpty else { return true }
            call(botId: bot, name: bot)
            return true
        case "thread":
            guard let botId = value("bot"), let threadId = value("thread") else { return true }
            if let session {
                Task { await session.openThreadLink(botId: botId, threadId: threadId) }
            } else {
                pendingThread = (botId, threadId)
            }
            return true
        default:
            return false
        }
    }
}

/// The bots a Shortcut can call, as last seen by the app. The Shortcuts app
/// asks for these while the app may not be connected, so they are kept on
/// disk rather than read from the live session.
enum BotDirectory {
    struct Entry: Codable, Hashable {
        var id: String
        var name: String
        /// Which computer the bot lives on, so two bots with one name differ.
        var home: String? = nil
        var color: String? = nil
        var mascotBody: String? = nil
        var mascotEyes: String? = nil

        var entity: BotEntity { BotEntity(id: id, name: name, home: home, face: BotDirectory.face(for: self)) }
    }

    private static let key = "intents.botDirectory"

    static func load() -> [Entry] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return entries
    }

    /// True when the list changed.
    @discardableResult
    static func save(_ entries: [Entry]) -> Bool {
        guard entries != load(), let data = try? JSONEncoder().encode(entries) else { return false }
        UserDefaults.standard.set(data, forKey: key)
        return true
    }

    /// The mascot as a PNG on disk, keyed by its look: the Shortcuts picker
    /// asks while the app has no live session, so the face is drawn ahead of
    /// time whenever the roster changes.
    static func faceURL(for entry: Entry) -> URL? {
        guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let look = [entry.id, entry.color ?? "", entry.mascotBody ?? "", entry.mascotEyes ?? ""].joined(separator: "|")
        let key = look.unicodeScalars.reduce(UInt64(14_695_981_039_346_656_037)) { ($0 ^ UInt64($1.value)) &* 1_099_511_628_211 }
        return root.appendingPathComponent("intent-faces", isDirectory: true).appendingPathComponent("\(String(key, radix: 16)).png")
    }

    static func face(for entry: Entry) -> Data? {
        faceURL(for: entry).flatMap { try? Data(contentsOf: $0) }
    }

    /// True when at least one face was drawn.
    @MainActor
    static func renderMissingFaces(_ entries: [Entry]) -> Bool {
        var drew = false
        for entry in entries {
            guard let url = faceURL(for: entry), !FileManager.default.fileExists(atPath: url.path) else { continue }
            let renderer = ImageRenderer(content: MausAvatar(color: entry.color ?? "green", size: 120, bodyId: entry.mascotBody,
                                                             eyeStyle: MascotEyeStyle(stored: entry.mascotEyes), animated: false)
                .frame(width: 120, height: 120))
            renderer.scale = 2
            guard let png = renderer.uiImage?.pngData() else { continue }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if (try? png.write(to: url, options: .atomic)) != nil { drew = true }
        }
        return drew
    }
}

struct BotEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Bot"
    static var defaultQuery = BotEntityQuery()

    var id: String
    var name: String
    var home: String? = nil
    var face: Data? = nil

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(name)",
            subtitle: home.map { "\($0)" },
            image: face.map { .init(data: $0) } ?? .init(systemName: "person.wave.2.fill")
        )
    }
}

struct BotEntityQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [BotEntity] {
        let all = BotDirectory.load()
        return identifiers.compactMap { id in all.first { $0.id == id }?.entity }
    }

    func entities(matching string: String) async throws -> [BotEntity] {
        let needle = string.lowercased()
        return BotDirectory.load()
            .filter { $0.name.lowercased().contains(needle) || ($0.home?.lowercased().contains(needle) ?? false) }
            .map(\.entity)
    }

    func suggestedEntities() async throws -> [BotEntity] {
        BotDirectory.load().map(\.entity)
    }
}

struct CallBosIntent: AppIntent {
    static var title: LocalizedStringResource = "Call bos"
    static var description = IntentDescription("Start a live voice call with bos.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        CallIntentRouter.shared.call(name: "bos")
        return .result()
    }
}

struct CallOracleIntent: AppIntent {
    static var title: LocalizedStringResource = "Call oracle"
    static var description = IntentDescription("Start a live voice call with oracle.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        CallIntentRouter.shared.call(name: "oracle")
        return .result()
    }
}

struct CallBotIntent: AppIntent {
    static var title: LocalizedStringResource = "Call a bot"
    static var description = IntentDescription("Start a live voice call with one of your bots.")
    static var openAppWhenRun = true

    @Parameter(title: "Bot") var bot: BotEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Call \(\.$bot)")
    }

    init() {}
    init(bot: BotEntity) { self.bot = bot }

    @MainActor
    func perform() async throws -> some IntentResult {
        CallIntentRouter.shared.call(botId: bot.id, name: bot.name)
        return .result()
    }
}

/// Zero setup: these appear in the Shortcuts app, Spotlight, Siri and
/// Settings › Action Button › Shortcut as soon as the app is installed.
struct BosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CallBosIntent(),
            phrases: [
                "Call bos with \(.applicationName)",
                "Call bos on \(.applicationName)",
                "\(.applicationName) call bos",
            ],
            shortTitle: "Call bos",
            systemImageName: "phone.fill"
        )
        AppShortcut(
            intent: CallOracleIntent(),
            phrases: [
                "Call oracle with \(.applicationName)",
                "Call oracle on \(.applicationName)",
                "\(.applicationName) call oracle",
            ],
            shortTitle: "Call oracle",
            systemImageName: "phone.fill"
        )
        AppShortcut(
            intent: CallBotIntent(),
            phrases: [
                "Call \(\.$bot) with \(.applicationName)",
                "Call a bot with \(.applicationName)",
            ],
            shortTitle: "Call a bot",
            systemImageName: "phone.badge.waveform.fill"
        )
    }

    static var shortcutTileColor: ShortcutTileColor = .navy
}
