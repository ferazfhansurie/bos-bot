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
    /// When each bot's job in a thread began, keyed "bot:thread": one clock
    /// for the whole job, whatever state it moves through.
    private var jobs: [String: Date] = [:]
    /// Each bot's last real step line and when it changed, so a step too
    /// vague to say keeps the last one instead of a bare "thinking".
    private var steps: [String: (threadId: String, line: String, symbol: String, at: Date, recent: [String])] = [:]
    /// Bots whose card was asked to peek, and the task that ends the peek.
    private var peeking: [String: (until: Date, task: Task<Void, Never>)] = [:]
    /// Bots showing their done card, and the task that will end it.
    private var finishing: [String: Task<Void, Never>] = [:]
    /// The done line each finished bot shows on the widgets, and when.
    private var finished: [String: (line: String, threadId: String?, title: String?, at: Date)] = [:]
    /// Each bot's look the notification mood faces were last drawn for.
    private var moodFacesDrawn: [String: String] = UserDefaults.standard.dictionary(forKey: "glance.moodFaces") as? [String: String] ?? [:]
    private var lastWidgetReload = Date.distantPast
    private var pendingWidgetReload: Task<Void, Never>?
    /// Live voice calls, per bot: what the call is doing and since when.
    private var calls: [String: (bot: Bot, threadId: String, phase: LiveCallPhase, since: Date)] = [:]
    private var lastState: CompanionState?

    /// The running app's coordinator, for the voice engine's call hook.
    private static weak var current: LiveActivityCoordinator?

    /// The voice engine's one hook: what a live call with `bot` is doing,
    /// or nil once it ends. It rides on that bot's Live Activity (the island,
    /// the lock screen, and CarPlay's car view), and starts one for a bot
    /// that has nothing running. Only optional content fields change, so an
    /// older widget just ignores them.
    static func updateCall(bot: Bot, threadId: String, phase: LiveCallPhase?) {
        current?.setCall(bot: bot, threadId: threadId, phase: phase)
    }

    private func setCall(bot: Bot, threadId: String, phase: LiveCallPhase?) {
        if let phase {
            if calls[bot.id]?.phase == phase { return }
            calls[bot.id] = (bot, threadId, phase, calls[bot.id]?.since ?? Date())
        } else if calls.removeValue(forKey: bot.id) == nil {
            return
        }
        if let lastState { sync(lastState) }
    }

    /// How long the done card stays in the island before it ends, and how
    /// long the ended card then stays on the lock screen.
    private static let doneInIsland: Duration = .seconds(8)
    private static let doneOnLockScreen: TimeInterval = 2 * 60
    /// The celebrate face's beat at the start of the done card.
    private static let celebrateInIsland: Duration = .milliseconds(2600)

    func attach(to session: Session) {
        Self.current = self
        // Answer and stop from the island: the intents run in this process.
        AnswerApprovalIntent.handler = { [weak self, weak session] threadId, requestId, choice, isPermission in
            await self?.answer(session: session, threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }
        StopBotIntent.handler = { [weak session] botId, threadId in
            await session?.interrupt(botId: botId, threadId: threadId)
        }
        PeekBotIntent.handler = { [weak self] botId in
            await self?.peek(botId)
        }
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "renderLiveCards") { Self.renderLiveCards() }
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

    /// Show the plan and the last steps on a bot's working card for a few
    /// seconds, then fold back.
    private func peek(_ botId: String) {
        peeking.removeValue(forKey: botId)?.task.cancel()
        let until = Date().addingTimeInterval(Self.peekFor)
        let task = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.peekFor))
            guard let self, !Task.isCancelled else { return }
            self.peeking.removeValue(forKey: botId)
            if let state = self.lastState { self.sync(state) }
        }
        peeking[botId] = (until, task)
        if let lastState { sync(lastState) }
    }

    private static let peekFor: TimeInterval = 8

    /// When this job began: the first time the bot was seen busy in this
    /// thread, or the message it is answering if that came earlier (the app
    /// opened mid-job).
    private func jobStart(bot: Bot, threadId: String, state: CompanionState, now: Date) -> Date {
        let key = "\(bot.id):\(threadId)"
        if let known = jobs[key] { return known }
        let transcript = state.visibleTranscript(forThread: threadId)
        var start = now
        if let asked = transcript.last(where: { $0.role == .user && $0.kind == .text }),
           !transcript.contains(where: { $0.role == .bot && $0.kind == .text && $0.at > asked.at }) {
            let at = Date(timeIntervalSince1970: asked.at / 1000)
            if now.timeIntervalSince(at) < 6 * 3600 { start = min(start, at) }
        }
        jobs[key] = start
        return start
    }

    private static var live: [Activity<BotActivityAttributes>] {
        Activity<BotActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }

    private func sync(_ state: CompanionState) {
        lastState = state
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

        // every bot in one line, for the car: "3 working · 1 needs you"
        let waiting = byBot.values.filter { $0.update.kind == .needsYou }.count
        let summary = CarGlance.summary(working: byBot.count - waiting, needsYou: waiting)

        // a job that is no longer running in any thread forgets its clock
        let now = Date()
        let busy = Set(state.updates.compactMap { update -> String? in
            guard update.kind != .toReview, case let .bot(bot) = update.chat else { return nil }
            return "\(bot.id):\(update.chat.threadId)"
        })
        jobs = jobs.filter { busy.contains($0.key) }

        for botId in order {
            guard let (bot, update, count) = byBot[botId] else { continue }
            finishing.removeValue(forKey: botId)?.cancel()
            let needsYou = update.kind == .needsYou
            let kind = needsYou ? "needsYou" : "working"
            let threadId = update.chat.threadId
            let started = jobStart(bot: bot, threadId: threadId, state: state, now: now)
            let live = Self.step(for: update, state: state, since: started)
            let step = held(botId: bot.id, threadId: threadId, step: live, needsYou: needsYou, now: now)
            let face = needsYou ? MausState.listening
                : Self.face(forStep: step.symbol, runtime: MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last))
            var content = BotActivityAttributes.ContentState(
                face: face.rawValue,
                kind: kind,
                headline: needsYou ? "\(bot.name) needs you" : "\(bot.name) is working",
                line: step.line,
                threadId: threadId,
                card: update.card,
                since: started,
                threadTitle: Self.title(update.chat, state: state, since: started),
                symbol: step.symbol,
                otherThreads: count > 1 ? count - 1 : nil
            )
            content.jobSince = started
            content.stepSince = steps[bot.id]?.at ?? started
            if let plan = live.plan, plan.count >= 2 {
                content.stepIndex = plan.index
                content.stepCount = plan.count
                content.planStep = plan.step
            }
            if !needsYou, let peek = peeking[bot.id], peek.until > now {
                content.peekUntil = peek.until
                content.recent = steps[bot.id]?.recent
            }
            content.summary = summary
            if let call = calls[bot.id] {
                content.call = call.phase.word
                content.callSince = call.since
            }
            show(bot: bot, content: content)
        }

        // a call with a bot that has no turn running gets its own card
        for (botId, call) in calls where byBot[botId] == nil {
            finishing.removeValue(forKey: botId)?.cancel()
            steps.removeValue(forKey: botId)
            var content = BotActivityAttributes.ContentState(
                face: Self.face(forCall: call.phase).rawValue,
                kind: "call",
                headline: "on a call with \(call.bot.name)",
                line: call.phase.word,
                threadId: call.threadId,
                card: nil,
                since: call.since,
                symbol: "phone.fill"
            )
            content.summary = summary
            content.call = call.phase.word
            content.callSince = call.since
            show(bot: call.bot, content: content)
        }

        // bots that went quiet: a finished turn gets its done card, anything
        // else (a cleared state, a reconnect, an old run's leftover) just ends
        let wanted = Set(order).union(calls.keys)
        for activity in Self.live where !wanted.contains(activity.attributes.botId) {
            let botId = activity.attributes.botId
            guard finishing[botId] == nil else { continue }
            let previous = lastSent.removeValue(forKey: botId)
            steps.removeValue(forKey: botId)
            peeking.removeValue(forKey: botId)?.task.cancel()
            guard let previous, previous.kind != "call",
                  let done = Self.doneContent(after: previous, name: activity.attributes.name, state: state) else {
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
                continue
            }
            finished[botId] = (done.line, done.threadId, done.threadTitle, Date())
            finishing[botId] = Task { [weak self] in
                // celebrate in the island first, then settle into a happy face
                await activity.update(.init(state: done, staleDate: Date().addingTimeInterval(10 * 60),
                                            relevanceScore: CarGlance.relevance(done)))
                try? await Task.sleep(for: Self.celebrateInIsland)
                guard !Task.isCancelled else { return }
                var settled = done
                settled.face = MausState.happy.rawValue
                await activity.update(.init(state: settled, staleDate: Date().addingTimeInterval(10 * 60),
                                            relevanceScore: CarGlance.relevance(settled)))
                try? await Task.sleep(for: Self.doneInIsland - Self.celebrateInIsland)
                guard !Task.isCancelled else { return }
                await activity.end(.init(state: settled, staleDate: nil),
                                   dismissalPolicy: .after(Date().addingTimeInterval(Self.doneOnLockScreen)))
                self?.finishing.removeValue(forKey: botId)
            }
        }
    }

    /// The step line to show: a real step replaces the last one; a vague one
    /// ("working on it", a receipt) keeps the last real step of this job.
    private func held(botId: String, threadId: String, step: LiveLine, needsYou: Bool, now: Date)
        -> (line: String, symbol: String) {
        if needsYou { return (step.line, step.symbol) }
        let before = steps[botId].flatMap { $0.threadId == threadId ? $0 : nil }
        if !step.vague {
            if before?.line != step.line {
                let recent = Array(((before?.recent ?? []) + [step.line]).suffix(3))
                steps[botId] = (threadId, step.line, step.symbol, now, recent)
            }
            return (step.line, step.symbol)
        }
        if let before { return (before.line, before.symbol) }
        return (step.line, step.symbol)
    }

    /// Start, or update in place, one bot's activity with this content. A
    /// bot stopping for you alerts; nothing else does.
    private func show(bot: Bot, content: BotActivityContent) {
        let needsYou = content.needsYou
        if lastSent[bot.id] == content { return }
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
            Task { await activity.update(.init(state: content, staleDate: nil, relevanceScore: CarGlance.relevance(content)),
                                         alertConfiguration: newAsk ? alert : nil) }
        } else {
            for old in Activity<BotActivityAttributes>.activities where old.attributes.botId == bot.id {
                Task { await old.end(nil, dismissalPolicy: .immediate) }
            }
            let attributes = BotActivityAttributes(botId: bot.id, threadId: bot.threadId, name: bot.name, color: bot.color, mascotBody: bot.mascotBody, mascotEyes: bot.mascotEyes)
            let started = try? Activity.request(attributes: attributes,
                                                content: .init(state: content, staleDate: nil, relevanceScore: CarGlance.relevance(content)),
                                                pushType: .token)
            // a fresh activity cannot alert on request; one immediate alerting update does it
            if let alert, let started {
                Task { await started.update(.init(state: content, staleDate: nil, relevanceScore: CarGlance.relevance(content)),
                                            alertConfiguration: alert) }
            }
        }
    }

    private static func face(forCall phase: LiveCallPhase) -> MausState {
        switch phase {
        case .listening, .connecting: return .listening
        case .thinking, .reconnecting: return .thinking
        case .speaking: return .excited
        case .sending: return .sending
        case .jobSaved: return .happy
        }
    }

    /// The done card: only when the thread really ended on a reply from the
    /// bot during this activity, never a guess from a state that emptied.
    private static func doneContent(after previous: BotActivityContent, name: String, state: CompanionState) -> BotActivityContent? {
        guard let threadId = previous.threadId, !threadId.isEmpty,
              let last = state.visibleTranscript(forThread: threadId).last(where: { $0.kind != .digest }),
              last.role == .bot, last.kind == .text,
              last.at / 1000 >= previous.clockStart.timeIntervalSince1970 - 1
        else { return nil }
        let line = replyFirstLine(last.text)
        var done = previous
        done.kind = "done"
        done.face = MausState.celebrate.rawValue
        done.headline = "\(name) is done"
        done.line = line.isEmpty ? "finished" : line
        done.result = done.line
        done.symbol = "checkmark"
        if let count = done.stepCount { done.stepIndex = count }
        done.peekUntil = nil
        done.recent = nil
        done.requestId = nil
        done.options = []
        done.otherThreads = nil
        done.call = nil
        done.callSince = nil
        done.endedAt = Date()
        return done
    }

    /// The face for what the bot is doing: thinking while it reads and
    /// reasons, searching while it looks things up, working while it runs
    /// and edits. A step too vague to say falls back to the runtime's face.
    private static func face(forStep symbol: String, runtime: MausState) -> MausState {
        switch symbol {
        case "ellipsis", "tray.full", "list.bullet": return .thinking
        case "doc.text": return .reading
        case "square.and.pencil", "pencil": return .writing
        case "magnifyingglass", "text.magnifyingglass", "globe", "safari", "envelope", "calendar", "message":
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
                let started = jobStart(bot: bot, threadId: update.chat.threadId, state: state, now: now)
                let live = Self.step(for: update, state: state, since: started)
                let held = steps[bot.id].flatMap { $0.threadId == update.chat.threadId && live.vague && !needsYou ? $0 : nil }
                let step = (line: held?.line ?? live.line, symbol: held?.symbol ?? live.symbol)
                glance.status = needsYou ? "needsYou" : "working"
                glance.face = (needsYou ? MausState.listening
                    : Self.face(forStep: step.symbol, runtime: MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last))).rawValue
                glance.line = step.line
                glance.threadId = update.chat.threadId
                glance.threadTitle = Self.title(update.chat, state: state, since: started)
                glance.since = started
                glance.stepIndex = live.plan?.index
                glance.stepCount = live.plan?.count
                finished.removeValue(forKey: bot.id)
            } else if let done = finished[bot.id] {
                glance.status = "done"
                glance.face = MausState.celebrate.rawValue
                glance.line = done.line
                glance.threadId = done.threadId ?? bot.threadId
                glance.threadTitle = done.title
                glance.since = done.at
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
            // v2: v1 marked faces drawn even when the render came out blank;
            // v3: the B dot eyes
            let look = [bot.color, bot.mascotBody ?? "", "v3"].joined(separator: "|")
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

    /// The job in at most five words: the thread's own short name, else the
    /// message that started the job, cleaned and cut short.
    private static func title(_ chat: Chat, state: CompanionState, since: Date) -> String? {
        let transcript = state.visibleTranscript(forThread: chat.threadId)
        let floor = since.timeIntervalSince1970 * 1000 + 2000
        let asked = transcript.last(where: { $0.role == .user && $0.kind == .text && $0.at <= floor })
            ?? transcript.last(where: { $0.role == .user && $0.kind == .text })
        return liveJobTitle(threadTitle: chat.threadTitle, message: asked?.text)
    }

    /// One step line and the plan behind it. `vague` lines give way to the
    /// last real step of the job.
    private struct LiveLine {
        var line: String
        var symbol: String
        var vague = false
        var plan: (index: Int, count: Int, step: String?)?
    }

    /// What the bot is doing, in plain words — never a raw tool name, a
    /// path, or a bare "thinking".
    private static func step(for update: ChatUpdate, state: CompanionState, since: Date) -> LiveLine {
        let transcript = state.visibleTranscript(forThread: update.chat.threadId)
        let live = liveStep(transcript, since: since)
        let plan = live?.stepCount.map { (live?.stepIndex ?? 1, $0, live?.planStep) }
        if update.kind == .needsYou {
            let ask = (update.card?.title ?? update.line).trimmingCharacters(in: .whitespacesAndNewlines)
            let line = ask.isEmpty || ask == "Waiting on you" ? "waiting for you" : ask
            return LiveLine(line: lockScreenLine(line), symbol: "hand.raised.fill", plan: plan)
        }
        if update.typing { return LiveLine(line: "writing the reply", symbol: "text.bubble", plan: plan) }
        if update.line.hasPrefix("Queued") || update.line.hasSuffix("messages queued") {
            return LiveLine(line: update.line.lowercased(), symbol: "tray.full", plan: plan)
        }
        // the newest real tool step of this job; a receipt or nothing yet
        // keeps whatever real step came before
        if let live, let last = transcript.last(where: { $0.kind != .digest }), last.kind == .activity, last.tool?.itemId != nil {
            return LiveLine(line: live.line, symbol: live.symbol, vague: live.line == "working on it", plan: plan)
        }
        if let live, transcript.last(where: { $0.kind != .digest })?.role != .user {
            return LiveLine(line: live.line, symbol: live.symbol, vague: true, plan: plan)
        }
        return LiveLine(line: "reading your message", symbol: "text.magnifyingglass", vague: true, plan: plan)
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
    private static func demoContent(_ kind: String, name: String, thread: String, started: Date) -> BotActivityContent {
        var c: BotActivityContent
        switch kind {
        case "needsYou":
            c = BotActivityContent(face: "listening", kind: "needsYou", headline: "\(name) needs you",
                                   line: "restart the bos server?", threadId: thread, card: nil,
                                   since: started, threadTitle: "live card redesign", symbol: "hand.raised.fill")
            c.requestId = "demo"
            c.options = ["Allow", "Deny"]
            c.isPermission = true
        case "done":
            c = BotActivityContent(face: "celebrate", kind: "done", headline: "\(name) is done",
                                   line: "build 150 is on your iphone", threadId: thread,
                                   card: nil, since: started, threadTitle: "live card redesign", symbol: "checkmark")
            c.result = c.line
            c.endedAt = Date()
        default:
            c = BotActivityContent(face: "working", kind: "working", headline: "\(name) is working",
                                   line: "running tests", threadId: thread, card: nil, since: started,
                                   threadTitle: "live card redesign", symbol: "checkmark.seal", otherThreads: 1)
            c.planStep = "porting the step words"
            c.recent = ["reading liveactivities.swift", "editing botactivitycontent.swift", "running tests"]
            if kind == "peek" { c.peekUntil = Date().addingTimeInterval(3600) }
        }
        c.jobSince = started
        c.stepSince = Date().addingTimeInterval(-12)
        c.stepIndex = kind == "done" ? 5 : 3
        c.stepCount = 5
        return c
    }

    /// -renderLiveCards YES: draws every card state with the widget's own
    /// views into Documents/livecards/*.png, for looking at without a lock
    /// screen. The system draws the real thing; this is the same SwiftUI.
    private static func renderLiveCards() {
        let started = Date().addingTimeInterval(-252)
        let folder = URL.documentsDirectory.appending(path: "livecards")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let bos = BotActivityAttributes(botId: "59d5f871-db6c-4850-b966-a04ecc033279", threadId: "demo-bos", name: "bos",
                                        color: "teal", mascotBody: "circle", mascotEyes: nil)
        let oracle = BotActivityAttributes(botId: "4c4ff223-89ea-4743-a42e-1e9d62e24ea8", threadId: "demo-oracle", name: "oracle",
                                           color: "coral", mascotBody: "sun", mascotEyes: nil)
        var noPlan = demoContent("working", name: "oracle", thread: "demo-oracle", started: started)
        noPlan.stepIndex = nil
        noPlan.stepCount = nil
        noPlan.threadTitle = "check the ads now"
        noPlan.line = "reading the meta report"
        noPlan.symbol = "chart.bar"
        var call = demoContent("working", name: "bos", thread: "demo-bos", started: started)
        call.call = "listening"
        call.callSince = Date().addingTimeInterval(-41)
        let cases: [(String, BotActivityAttributes, BotActivityContent)] = [
            ("working", bos, demoContent("working", name: "bos", thread: "demo-bos", started: started)),
            ("peek", bos, demoContent("peek", name: "bos", thread: "demo-bos", started: started)),
            ("needsyou", oracle, demoContent("needsYou", name: "oracle", thread: "demo-oracle", started: started)),
            ("done", bos, demoContent("done", name: "bos", thread: "demo-bos", started: started)),
            ("noplan", oracle, noPlan),
            ("call", bos, call),
        ]
        func save(_ view: some View, _ name: String, width: CGFloat) {
            let renderer = ImageRenderer(content: view.frame(width: width).environment(\.colorScheme, .dark)
                                                .environment(\.liveCardSnapshot, true))
            renderer.scale = 3
            if let data = renderer.uiImage?.pngData() { try? data.write(to: folder.appending(path: "\(name).png")) }
        }
        let wallpaper = LinearGradient(colors: [Color(red: 0.12, green: 0.16, blue: 0.30), Color(red: 0.30, green: 0.18, blue: 0.34)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
        for (name, attributes, state) in cases {
            let card = LiveCard(attributes: attributes, state: state)
            // lock screen: the card on glass over a wallpaper
            save(LiveLockCard(card: card)
                    .background(.ultraThinMaterial.opacity(0.6))
                    .background(Color.black.opacity(0.42))
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .padding(14)
                    .background(wallpaper), "lock-\(name)", width: 400)
            // expanded island: black, the same regions iOS lays out
            save(VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 10) {
                        LiveCardFace(card: card, size: 44)
                        VStack(alignment: .leading, spacing: 1) {
                            LiveCardStatus(card: card, showsClock: false, showsOthers: true, compact: true)
                            Text(card.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                        }
                        Spacer()
                        LiveCardClock(card: card).font(.system(size: 15, weight: .semibold).monospacedDigit())
                    }
                    LiveIslandBottom(card: card)
                 }
                 .padding(18)
                 .background(Color.black, in: RoundedRectangle(cornerRadius: 44, style: .continuous))
                 .padding(10)
                 .background(wallpaper), "island-\(name)", width: 400)
            // car / smart stack: the small family
            save(LiveCarCard(card: card)
                    .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .padding(10)
                    .background(wallpaper), "car-\(name)", width: 330)
        }
        print("livecards ->", folder.path)
    }

    private static func demo(_ kind: String) async {
        for activity in Activity<BotActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        let started = Date().addingTimeInterval(-252)
        func content(_ name: String, _ thread: String) -> BotActivityContent {
            demoContent(kind, name: name, thread: thread, started: started)
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
            let steps: [(String, String, String)] = [("reading", "doc.text", "reading liveactivities.swift"),
                                                     ("writing", "pencil", "editing BosWidgets.swift"),
                                                     ("working", "checkmark.seal", "running tests")]
            for round in 0..<40 {
                try? await Task.sleep(for: .seconds(4))
                let step = steps[round % steps.count]
                for (activity, state) in running {
                    var next = state
                    next.face = step.0
                    next.symbol = step.1
                    next.line = step.2
                    next.stepSince = Date()
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
                            line: kind == "done" ? "build 150 is on your iphone" : "running tests",
                            threadId: "demo-bos", threadTitle: "live card redesign", since: now.addingTimeInterval(-252),
                            stepIndex: kind == "done" ? nil : 3, stepCount: kind == "done" ? nil : 5)
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
