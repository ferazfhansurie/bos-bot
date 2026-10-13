// Keeping the Dynamic Island in step with the bots.
//
// One Live Activity per bot that is doing something — needs you, or working
// — started, updated and ended from the same `updates` the pill reads. Per
// bot, not per thread and not one summary: each bot keeps its own face,
// colour, tap target and answer buttons, and iOS already stacks several
// activities in the island. A bot busy in more than one thread shows its
// most urgent one and a "+1 thread" count.
//
// When a bot's turn settles, its activity turns into a short "done" card
// with the reply's first line, lingers, then ends. The stream is
// foreground-only, so once the app is closed the Mac takes over with
// ActivityKit pushes (server/live-activity-driver.ts): every activity here is
// requested with a push token, the push-to-start token lets the Mac start
// one on a locked phone, and `LiveActivityTokens` keeps the Mac's copy of
// both current. An activity left over from a previous run is ended on the
// next launch if the bot has moved on.
import ActivityKit
import Combine
import Foundation
import SwiftUI
import UserNotifications
import WidgetKit
import CompanionCore

@MainActor
final class LiveActivityCoordinator {
    private var cancellable: AnyCancellable?
    private var lastSent: [String: BotActivityAttributes.ContentState] = [:]
    /// When each bot's current kind began, so an update does not reset the clock.
    private var since: [String: (kind: String, at: Date)] = [:]
    /// Bots showing their done card, and the task that will end it.
    private var finishing: [String: Task<Void, Never>] = [:]
    /// The done line each finished bot shows on the widgets, and when.
    private var finished: [String: (line: String, threadId: String?, title: String?, at: Date)] = [:]
    /// Each bot's look the notification mood faces were last drawn for.
    private var moodFacesDrawn: [String: String] = UserDefaults.standard.dictionary(forKey: "glance.moodFaces") as? [String: String] ?? [:]
    private var lastWidgetReload = Date.distantPast
    private var pendingWidgetReload: Task<Void, Never>?
    private var glanceSince: [String: (thread: String, kind: String, at: Date)] = [:]

    /// How long the done card stays in the island before it ends, and how
    /// long the ended card then stays on the lock screen.
    private static let doneInIsland: Duration = .seconds(8)
    private static let doneOnLockScreen: TimeInterval = 2 * 60
    /// The celebrate face's beat at the start of the done card.
    private static let celebrateInIsland: Duration = .milliseconds(2600)

    func attach(to session: Session) {
        // Answer and stop from the island: the intents run in this process.
        AnswerApprovalIntent.handler = { [weak self, weak session] threadId, requestId, choice, isPermission in
            await self?.answer(session: session, threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }
        StopBotIntent.handler = { [weak session] botId, threadId in
            await session?.interrupt(botId: botId, threadId: threadId)
        }
        #if DEBUG
        if let demo = UserDefaults.standard.string(forKey: "demoActivity") {
            Task { await Self.demo(demo) }
            Self.demoGlances(demo)
            return
        }
        #endif
        cancellable = session.stateChanges
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] state in self?.sync(state) }
    }

    private func answer(session: Session?, threadId: String, requestId: String, choice: String, isPermission: Bool) async {
        guard Activity<BotActivityAttributes>.activities.contains(where: {
            $0.content.state.canAnswer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }) else {
            session?.actionError = "This request has changed. Open the chat to review it."
            return
        }
        await session?.answer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
    }

    private static var live: [Activity<BotActivityAttributes>] {
        Activity<BotActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }

    private func sync(_ state: CompanionState) {
        publishGlances(state)
        drawMoodFaces(state.bots)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // updates arrive most urgent first: a bot's first one is its headline
        var byBot: [String: (bot: Bot, update: ChatUpdate, count: Int)] = [:]
        var order: [String] = []
        for update in state.updates where update.kind != .toReview {
            guard case let .bot(bot) = update.chat else { continue }
            if let existing = byBot[bot.id] {
                byBot[bot.id] = (existing.bot, existing.update, existing.count + 1)
            } else {
                byBot[bot.id] = (bot, update, 1)
                order.append(bot.id)
            }
        }

        for botId in order {
            guard let (bot, update, count) = byBot[botId] else { continue }
            finishing.removeValue(forKey: botId)?.cancel()
            let needsYou = update.kind == .needsYou
            let kind = needsYou ? "needsYou" : "working"
            if since[bot.id]?.kind != kind { since[bot.id] = (kind, Date()) }
            let step = Self.step(for: update, state: state)
            let face = needsYou ? MausState.listening
                : Self.face(forStep: step.symbol, runtime: MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last))
            let content = BotActivityAttributes.ContentState(
                face: face.rawValue,
                kind: kind,
                headline: needsYou ? "\(bot.name) needs you" : "\(bot.name) is working",
                line: step.line,
                threadId: update.chat.threadId,
                card: update.card,
                since: since[bot.id]?.at ?? Date(),
                threadTitle: Self.title(update.chat),
                symbol: step.symbol,
                otherThreads: count > 1 ? count - 1 : nil
            )
            if lastSent[bot.id] == content { continue }
            defer { lastSent[bot.id] = content }

            // A bot stopping for you is worth an alert: the island pops open
            // on its own and the lock screen lights up. Working is not.
            let alert: AlertConfiguration? = needsYou
                ? AlertConfiguration(
                    title: LocalizedStringResource(stringLiteral: content.headline),
                    body: LocalizedStringResource(stringLiteral: content.line),
                    sound: .default
                )
                : nil
            if let activity = Self.live.first(where: { $0.attributes.botId == bot.id && $0.attributes.mascotBody == bot.mascotBody
                && $0.attributes.color == bot.color && $0.attributes.mascotEyes == bot.mascotEyes && $0.attributes.name == bot.name }) {
                let newAsk = needsYou && (
                    lastSent[bot.id]?.needsYou != true
                        || lastSent[bot.id]?.threadId != content.threadId || lastSent[bot.id]?.requestId != content.requestId
                )
                Task { await activity.update(.init(state: content, staleDate: nil), alertConfiguration: newAsk ? alert : nil) }
            } else {
                for old in Activity<BotActivityAttributes>.activities where old.attributes.botId == bot.id {
                    Task { await old.end(nil, dismissalPolicy: .immediate) }
                }
                let attributes = BotActivityAttributes(botId: bot.id, threadId: bot.threadId, name: bot.name, color: bot.color, mascotBody: bot.mascotBody, mascotEyes: bot.mascotEyes)
                let started = try? Activity.request(attributes: attributes, content: .init(state: content, staleDate: nil), pushType: .token)
                // a fresh activity cannot alert on request; one immediate alerting update does it
                if let alert, let started {
                    Task { await started.update(.init(state: content, staleDate: nil), alertConfiguration: alert) }
                }
            }
        }

        // bots that went quiet: a finished turn gets its done card, anything
        // else (a cleared state, a reconnect, an old run's leftover) just ends
        let wanted = Set(order)
        for activity in Self.live where !wanted.contains(activity.attributes.botId) {
            let botId = activity.attributes.botId
            guard finishing[botId] == nil else { continue }
            let previous = lastSent.removeValue(forKey: botId)
            since.removeValue(forKey: botId)
            guard let previous, let done = Self.doneContent(after: previous, name: activity.attributes.name, state: state) else {
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
                continue
            }
            finished[botId] = (done.line, done.threadId, done.threadTitle, Date())
            finishing[botId] = Task { [weak self] in
                // celebrate in the island first, then settle into a happy face
                await activity.update(.init(state: done, staleDate: Date().addingTimeInterval(10 * 60)))
                try? await Task.sleep(for: Self.celebrateInIsland)
                guard !Task.isCancelled else { return }
                var settled = done
                settled.face = MausState.happy.rawValue
                await activity.update(.init(state: settled, staleDate: Date().addingTimeInterval(10 * 60)))
                try? await Task.sleep(for: Self.doneInIsland - Self.celebrateInIsland)
                guard !Task.isCancelled else { return }
                await activity.end(.init(state: settled, staleDate: nil),
                                   dismissalPolicy: .after(Date().addingTimeInterval(Self.doneOnLockScreen)))
                self?.finishing.removeValue(forKey: botId)
            }
        }
    }

    /// The done card: only when the thread really ended on a reply from the
    /// bot during this activity, never a guess from a state that emptied.
    private static func doneContent(after previous: BotActivityContent, name: String, state: CompanionState) -> BotActivityContent? {
        guard let threadId = previous.threadId, !threadId.isEmpty,
              let last = state.visibleTranscript(forThread: threadId).last(where: { $0.kind != .digest }),
              last.role == .bot, last.kind == .text,
              last.at / 1000 >= previous.since.timeIntervalSince1970 - 1
        else { return nil }
        let line = replyFirstLine(last.text)
        var done = previous
        done.kind = "done"
        done.face = MausState.celebrate.rawValue
        done.headline = "\(name) is done"
        done.line = line.isEmpty ? "finished" : line
        done.symbol = "checkmark"
        done.requestId = nil
        done.options = []
        done.otherThreads = nil
        done.endedAt = Date()
        return done
    }

    /// The face for what the bot is doing: thinking while it reads and
    /// reasons, searching while it looks things up, working while it runs
    /// and edits. A step too vague to say falls back to the runtime's face.
    private static func face(forStep symbol: String, runtime: MausState) -> MausState {
        switch symbol {
        case "ellipsis", "tray.full", "list.bullet": return .thinking
        case "magnifyingglass", "text.magnifyingglass", "globe", "safari", "doc.text", "envelope", "calendar", "message":
            return .searching
        case "bell", "circle.dotted", "puzzlepiece.extension":
            return runtime.showsActivity ? runtime : .working
        default: return .working
        }
    }

    // MARK: - Widgets and notification faces

    /// Every bot, as the home and lock screen widgets draw it: who is
    /// working, who needs you, who just finished. Written to the App Group;
    /// the widgets reload when something they draw changed.
    private func publishGlances(_ state: CompanionState) {
        var byBot: [String: ChatUpdate] = [:]
        for update in state.updates where update.kind != .toReview {
            guard case let .bot(bot) = update.chat, byBot[bot.id] == nil else { continue }
            byBot[bot.id] = update
        }
        let now = Date()
        finished = finished.filter { now.timeIntervalSince($0.value.at) < 20 * 60 }
        let glances: [BotGlance] = state.bots.filter { $0.hidden != true }.map { bot in
            var glance = BotGlance(id: bot.id, name: bot.name, color: bot.color, body: bot.mascotBody, eyes: bot.mascotEyes,
                                   status: "idle", face: MausState.idle.rawValue, line: "", threadId: bot.threadId,
                                   threadTitle: nil, since: nil)
            if let update = byBot[bot.id] {
                let needsYou = update.kind == .needsYou
                let step = Self.step(for: update, state: state)
                glance.status = needsYou ? "needsYou" : "working"
                glance.face = (needsYou ? MausState.listening
                    : Self.face(forStep: step.symbol, runtime: MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last))).rawValue
                glance.line = step.line
                glance.threadId = update.chat.threadId
                glance.threadTitle = Self.title(update.chat)
                if glanceSince[bot.id]?.thread != update.chat.threadId || glanceSince[bot.id]?.kind != glance.status {
                    glanceSince[bot.id] = (update.chat.threadId, glance.status, now)
                }
                glance.since = glanceSince[bot.id]?.at
                finished.removeValue(forKey: bot.id)
            } else if let done = finished[bot.id] {
                glanceSince.removeValue(forKey: bot.id)
                glance.status = "done"
                glance.face = MausState.celebrate.rawValue
                glance.line = done.line
                glance.threadId = done.threadId ?? bot.threadId
                glance.threadTitle = done.title
                glance.since = done.at
            } else {
                glanceSince.removeValue(forKey: bot.id)
            }
            return glance
        }
        guard BotRosterStore.save(BotRosterSnapshot(bots: glances, updatedAt: now)) else { return }
        // Keep at most one trailing reload. Reserving a future slot per
        // update built an ever-growing queue during tool-heavy runs.
        guard pendingWidgetReload == nil else { return }
        let wait = max(0, 1.5 - now.timeIntervalSince(lastWidgetReload))
        pendingWidgetReload = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(wait)) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.pendingWidgetReload = nil
            self.lastWidgetReload = Date()
            WidgetCenter.shared.reloadTimelines(ofKind: BotGlanceWidgetKind.bots)
        }
    }

    /// The faces a notification can wear, drawn once per look so the
    /// notification service can pick the one matching the message's mood.
    /// Only for bots that show their mascot: a photo stays a photo.
    private func drawMoodFaces(_ bots: [Bot]) {
        var drew = false
        for bot in bots where (bot.avatarCrop ?? .mascot) == .mascot && MascotEyeStyle(stored: bot.mascotEyes) == .glyph {
            // v2: v1 marked faces drawn even when the render came out blank
            let look = [bot.color, bot.mascotBody ?? "", "v2"].joined(separator: "|")
            guard moodFacesDrawn[bot.id] != look,
                  Self.drawMoodFaces(id: bot.id, color: bot.color, body: bot.mascotBody) else { continue }
            moodFacesDrawn[bot.id] = look
            drew = true
        }
        if drew { UserDefaults.standard.set(moodFacesDrawn, forKey: "glance.moodFaces") }
    }

    /// True only when every mood came out with a visible face.
    @discardableResult
    private static func drawMoodFaces(id: String, color: String, body: String?) -> Bool {
        var all = true
        for mood in NotificationMood.all {
            let face = GlyphMark(color: color, bodyId: body, state: GlyphFaceState(rawValue: mood) ?? .happy, size: 64)
                .frame(width: 128, height: 128)
                .environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: face)
            renderer.scale = 2
            guard let png = renderer.uiImage?.pngData(),
                  NotificationAvatarCache.storeMood(png, for: "bot:\(id)", mood: mood) else { all = false; continue }
        }
        return all
    }

    private static func title(_ chat: Chat) -> String? {
        let title = chat.threadTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty || title == "Untitled thread" ? nil : title
    }

    /// What the bot is doing, in plain words — never a raw tool name.
    private static func step(for update: ChatUpdate, state: CompanionState) -> (line: String, symbol: String) {
        if update.kind == .needsYou {
            let ask = (update.card?.title ?? update.line).trimmingCharacters(in: .whitespacesAndNewlines)
            let line = ask.isEmpty || ask == "Waiting on you" ? "waiting for you" : ask
            return (lockScreenLine(line), "hand.raised.fill")
        }
        if update.typing { return ("writing the reply", "text.bubble") }
        if update.line.hasPrefix("Queued") || update.line.hasSuffix("messages queued") {
            return (update.line.lowercased(), "tray.full")
        }
        let threadId = update.chat.threadId
        if let last = state.visibleTranscript(forThread: threadId).last(where: { $0.kind != .digest }) {
            if last.kind == .activity, let tool = last.tool {
                if tool.itemId == nil, !tool.name.isEmpty {
                    // the harness's own receipts are already a sentence
                    return (lockScreenLine(tool.name), "bell")
                }
                let progress = toolProgress(for: tool.name)
                return (progress.phrase, progress.symbol)
            }
            if last.role == .user { return ("reading your message", "ellipsis") }
        }
        return ("thinking", "ellipsis")
    }

    private static func lockScreenLine(_ line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("/bin/") || trimmed.hasPrefix("/usr/bin/") || trimmed.hasPrefix("python3 ") || trimmed.hasPrefix("zsh ") {
            return "running a command"
        }
        return trimmed
    }

    #if DEBUG
    /// Simulator screenshots: launch with `-demoActivity working|needsYou|done`
    /// to show that state for bos and oracle without a paired computer.
    private static func demo(_ kind: String) async {
        for activity in Activity<BotActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        let started = Date().addingTimeInterval(-94)
        func content(_ name: String, _ thread: String) -> BotActivityContent {
            switch kind {
            case "needsYou":
                var c = BotActivityContent(face: "curious", kind: "needsYou", headline: "\(name) needs you",
                                           line: "Allow restarting the BOS server?", threadId: thread, card: nil,
                                           since: started, threadTitle: "ios: live activity polish", symbol: "hand.raised.fill")
                c.requestId = "demo"
                c.options = ["Allow", "Deny"]
                c.isPermission = true
                return c
            case "done":
                var c = BotActivityContent(face: "celebrate", kind: "done", headline: "\(name) is done",
                                           line: "shipped build 74 to your iphone. action button is ready.", threadId: thread,
                                           card: nil, since: started, threadTitle: "ios: live activity polish", symbol: "checkmark")
                c.endedAt = Date()
                return c
            default:
                return BotActivityContent(face: "working", kind: "working", headline: "\(name) is working",
                                          line: "running a command", threadId: thread, card: nil, since: started,
                                          threadTitle: "ios: live activity polish", symbol: "terminal", otherThreads: 1)
            }
        }
        let bots: [(String, String, String, String)] = [
            ("59d5f871-db6c-4850-b966-a04ecc033279", "bos", "teal", "circle"),
            ("4c4ff223-89ea-4743-a42e-1e9d62e24ea8", "oracle", "coral", "sun"),
        ]
        var running: [(Activity<BotActivityAttributes>, BotActivityContent)] = []
        for (id, name, color, body) in bots {
            let attributes = BotActivityAttributes(botId: id, threadId: "demo-\(name)", name: name, color: color,
                                                   mascotBody: body, mascotEyes: nil)
            let state = content(name, "demo-\(name)")
            if let activity = try? Activity.request(attributes: attributes,
                                                    content: .init(state: state, staleDate: nil),
                                                    pushType: nil) {
                running.append((activity, state))
            }
        }
        // the same beats a real turn plays: done celebrates, then settles;
        // working moves through what it is doing
        if kind == "done" {
            try? await Task.sleep(for: celebrateInIsland)
            for (activity, state) in running {
                var settled = state
                settled.face = MausState.happy.rawValue
                await activity.update(.init(state: settled, staleDate: nil))
            }
        } else if kind == "working" {
            let steps: [(String, String, String)] = [("thinking", "ellipsis", "thinking it through"),
                                                     ("searching", "magnifyingglass", "searching the web"),
                                                     ("working", "terminal", "running a command")]
            for round in 0..<40 {
                try? await Task.sleep(for: .seconds(4))
                let step = steps[round % steps.count]
                for (activity, state) in running {
                    var next = state
                    next.face = step.0
                    next.symbol = step.1
                    next.line = step.2
                    await activity.update(.init(state: next, staleDate: nil))
                }
            }
        }
    }

    /// The widgets' and notifications' half of the demo: a roster snapshot
    /// for the widgets, mood faces, and (with -demoNotification) a bot
    /// notification a few seconds later, to open while the app is away.
    private static func demoGlances(_ kind: String) {
        let now = Date()
        let bos = BotGlance(id: "59d5f871-db6c-4850-b966-a04ecc033279", name: "bos", color: "teal", body: "circle", eyes: nil,
                            status: kind == "done" ? "done" : "working", face: kind == "done" ? "celebrate" : "working",
                            line: kind == "done" ? "shipped build 79 to your iphone" : "running a command",
                            threadId: "demo-bos", threadTitle: "ios: live activity polish", since: now.addingTimeInterval(-94))
        let oracle = BotGlance(id: "4c4ff223-89ea-4743-a42e-1e9d62e24ea8", name: "oracle", color: "coral", body: "sun", eyes: nil,
                               status: "needsYou", face: "listening", line: "Ship the nightly run?",
                               threadId: "demo-oracle", threadTitle: "nightly assignment", since: now.addingTimeInterval(-30))
        let extras = [("mint", "green", "blob"), ("pix", "violet", "star")].map { name, color, body in
            BotGlance(id: "demo-\(name)", name: name, color: color, body: body, eyes: nil, status: "idle", face: "idle",
                      line: "", threadId: nil, threadTitle: nil, since: nil)
        }
        BotRosterStore.save(BotRosterSnapshot(bots: [bos, oracle] + extras, updatedAt: now))
        WidgetCenter.shared.reloadAllTimelines()
        for glance in [bos, oracle] { drawMoodFaces(id: glance.id, color: glance.color, body: glance.body) }

        guard let mood = UserDefaults.standard.string(forKey: "demoNotification") else { return }
        let content = UNMutableNotificationContent()
        let fromOracle = mood == "waiting"
        content.title = fromOracle ? "oracle" : "bos"
        content.body = switch mood {
        case "waiting": "the nightly run is ready. ship it tonight?"
        case "failed": "couldn't reach the build server, trying again in a minute"
        default: "shipped build 79 to your iphone. try the new widget."
        }
        content.sound = .default
        content.categoryIdentifier = BotNotificationCategory.bot
        content.threadIdentifier = fromOracle ? "demo-oracle" : "demo-bos"
        let botId = fromOracle ? oracle.id : bos.id
        content.userInfo = ["botId": botId, "threadId": content.threadIdentifier, "kind": mood == "waiting" ? "question" : "done"]
        let glyph = NotificationMood.glyph(kind: content.userInfo["kind"] as? String, title: content.title, body: content.body)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
            NotificationCoordinator.withSenderFace(content, senderID: "bot:\(botId)", name: content.title, mood: glyph) { final in
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 8, repeats: false)
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "demo-\(mood)", content: final, trigger: trigger))
            }
        }
    }
    #endif
}

/// The push tokens the Mac needs to drive the island while the app is
/// closed: the push-to-start token (iOS 17.2+) and each running activity's
/// own token, keyed by activity so a bot's replaced island drops its old one.
@MainActor
final class LiveActivityTokens {
    static let shared = LiveActivityTokens()
    private static let startKey = "bos.liveStartToken"
    private static let activitiesKey = "bos.liveActivityTokens"

    private(set) var startToken: String? = UserDefaults.standard.string(forKey: startKey)
    /// activity id → [bot id, token]
    private var byActivity: [String: [String]] = UserDefaults.standard.dictionary(forKey: activitiesKey) as? [String: [String]] ?? [:]
    private var watched = Set<String>()
    private var started = false
    /// Set by `Session`: register again with the current tokens.
    var changed: (() -> Void)?

    /// Bot id → token, the newest island per bot.
    var activities: [String: String] {
        var map: [String: String] = [:]
        for activity in Activity<BotActivityAttributes>.activities.reversed() where activity.activityState == .active || activity.activityState == .stale {
            if let entry = byActivity[activity.id], entry.count == 2 { map[entry[0]] = entry[1] }
        }
        return map
    }

    func start() {
        guard !started else { return }
        started = true
        let running = Set(Activity<BotActivityAttributes>.activities.map(\.id))
        if byActivity.keys.contains(where: { !running.contains($0) }) {
            byActivity = byActivity.filter { running.contains($0.key) }
            save()
        }
        if #available(iOS 17.2, *) {
            Task { [weak self] in
                for await data in Activity<BotActivityAttributes>.pushToStartTokenUpdates {
                    guard let self else { return }
                    let token = Self.hex(data)
                    guard token != self.startToken else { continue }
                    self.startToken = token
                    UserDefaults.standard.set(token, forKey: Self.startKey)
                    self.changed?()
                }
            }
        }
        for activity in Activity<BotActivityAttributes>.activities { watch(activity) }
        Task { [weak self] in
            for await activity in Activity<BotActivityAttributes>.activityUpdates { self?.watch(activity) }
        }
    }

    private func watch(_ activity: Activity<BotActivityAttributes>) {
        guard watched.insert(activity.id).inserted else { return }
        let id = activity.id, botId = activity.attributes.botId
        Task { [weak self] in
            for await data in activity.pushTokenUpdates {
                guard let self else { return }
                let entry = [botId, Self.hex(data)]
                guard self.byActivity[id] != entry else { continue }
                self.byActivity[id] = entry
                self.save()
                self.changed?()
            }
        }
        Task { [weak self] in
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                guard let self, self.byActivity.removeValue(forKey: id) != nil else { return }
                self.save()
                self.changed?()
                return
            }
        }
    }

    private func save() { UserDefaults.standard.set(byActivity, forKey: Self.activitiesKey) }
    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
