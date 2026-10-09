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
// foreground-only and there is no push path yet, so the island is exact
// while the app is alive and goes quiet with it; an activity left over from
// a previous run is ended on the next launch if the bot has moved on.
import ActivityKit
import Combine
import Foundation
import CompanionCore

@MainActor
final class LiveActivityCoordinator {
    private var cancellable: AnyCancellable?
    private var lastSent: [String: BotActivityAttributes.ContentState] = [:]
    /// When each bot's current kind began, so an update does not reset the clock.
    private var since: [String: (kind: String, at: Date)] = [:]
    /// Bots showing their done card, and the task that will end it.
    private var finishing: [String: Task<Void, Never>] = [:]

    /// How long the done card stays in the island before it ends, and how
    /// long the ended card then stays on the lock screen.
    private static let doneInIsland: Duration = .seconds(8)
    private static let doneOnLockScreen: TimeInterval = 2 * 60

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
            let face = MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last)
            let step = Self.step(for: update, state: state)
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
                let started = try? Activity.request(attributes: attributes, content: .init(state: content, staleDate: nil), pushType: nil)
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
            finishing[botId] = Task { [weak self] in
                await activity.update(.init(state: done, staleDate: Date().addingTimeInterval(10 * 60)))
                try? await Task.sleep(for: Self.doneInIsland)
                guard !Task.isCancelled else { return }
                await activity.end(.init(state: done, staleDate: nil),
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
        done.face = MausState.happy.rawValue
        done.headline = "\(name) is done"
        done.line = line.isEmpty ? "finished" : line
        done.symbol = "checkmark"
        done.requestId = nil
        done.options = []
        done.otherThreads = nil
        done.endedAt = Date()
        return done
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
                var c = BotActivityContent(face: "happy", kind: "done", headline: "\(name) is done",
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
        let bots: [(String, String, String)] = [
            ("59d5f871-db6c-4850-b966-a04ecc033279", "bos", "white"),
            ("4c4ff223-89ea-4743-a42e-1e9d62e24ea8", "oracle", "#7C8CFF"),
        ]
        for (id, name, color) in bots {
            let attributes = BotActivityAttributes(botId: id, threadId: "demo-\(name)", name: name, color: color,
                                                   mascotBody: nil, mascotEyes: nil)
            let state = content(name, "demo-\(name)")
            _ = try? Activity.request(attributes: attributes,
                                      content: .init(state: state, staleDate: nil),
                                      pushType: nil)
        }
    }
    #endif
}
