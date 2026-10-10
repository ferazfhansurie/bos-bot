// A live voice call with one bot, Grok Bot style.
//
// The computer mints a short-lived xAI secret and the call plan
// (`Session.startVoiceCall`); the phone opens the realtime websocket itself
// and does all the audio, so no audio ever crosses the companion link. The
// model talks; when it needs real work done it calls `send_task`, which this
// object posts into the bot's chat thread as the caller's own words (tagged
// with the call's origin), and whatever the bot settles on is fed into the
// call as `async_update.add` so the model can say it out loud. Protocol
// notes: plans/grok-voice, plans/voice-v2.
import AVFoundation
import Combine
import CompanionCore
import SwiftUI

/// Mic and speaker loudness, read by the waveform at 30fps. Deliberately
/// not observable: publishing levels would redraw every view watching the
/// call thirty times a second.
final class VoiceCallLevels {
    var mic: Float = 0
    var speaker: Float = 0
    var callerSpeaking = false
    var assistantSpeaking = false
}

@MainActor
final class RealtimeVoiceCall: ObservableObject, Identifiable {
    enum Phase: Equatable {
        case connecting, live, reconnecting, ended
        case failed(String)
    }

    enum Activity: Equatable { case idle, listening, thinking, speaking }

    struct Line: Identifiable, Equatable {
        let id: String
        let speaker: RealtimeVoice.Speaker
        var text: String
        /// Settled: replayed into the model after a reconnect.
        var final: Bool
        /// The caller talked over this line; later text for it is ignored.
        var interrupted = false
    }

    let id = UUID()
    let bot: Bot
    let threadId: String
    let levels = VoiceCallLevels()
    /// What the call opens with instead of the plan's greeting: a call back
    /// about finished work, or a picked-up ring.
    let opener: String?
    /// The origin `callId` on everything this call sends. One id per call,
    /// across reconnects, so a done push for it can be held while it is live.
    var callId: String { id.uuidString.lowercased() }

    @Published private(set) var phase: Phase = .connecting
    @Published private(set) var activity: Activity = .idle
    @Published private(set) var muted = false
    @Published private(set) var elapsed = 0
    @Published private(set) var lines: [Line] = []
    @Published private(set) var settings: VoiceCallSettings
    @Published private(set) var options: VoiceCallOptions = .fallback
    /// A `send_task` went out on this call, so the bot may be working for it.
    @Published private(set) var handedWork = false

    var onEnded: ((RealtimeVoiceCall) -> Void)?
    private(set) var hasBeenLive = false
    private(set) var startedAt: Date?

    var isOver: Bool {
        switch phase {
        case .ended, .failed: return true
        default: return false
        }
    }

    private weak var session: Session?
    private let audio = VoiceCallAudio()
    private var plan: VoiceCallPlan?
    private lazy var urlSession: URLSession = URLSession(
        configuration: .default, delegate: SocketDelegate(owner: self), delegateQueue: .main)

    // The line.
    private var socket: URLSessionWebSocketTask?
    private var socketOpen = false
    private var sessionReady = false
    private var invited = false
    private var isReconnect = false
    private var micReady = false
    private var conversationId: String?
    private var reconnectAttempt = 0
    private var dialToken = 0
    private var reconnectTask: Task<Void, Never>?

    // Turn state.
    private var callerSpeaking = false
    private var callerHasSpoken = false
    private var responding = false
    private var responseRequested = false
    private var talkedOver = false
    private var spokeThisResponse = false
    private struct OwedTurn { var instructions: String?; var expires: Date? = nil }
    private var owed: OwedTurn?

    // Playback spans per `item_id:content_index`, for truncation.
    private struct Span { let itemId: String; let contentIndex: Int; var start: AVAudioFramePosition; var end: AVAudioFramePosition }
    private var spans: [String: Span] = [:]
    private var owedTruncations: [String] = []
    private var heardFraction: [String: Double] = [:]
    private var wasPlaying = false

    // Goodbye: `end_the_call` waits for the goodbye to finish playing.
    private var hangUpDeadline: Date?

    // Work handed to the bot, and what it writes back.
    private var watchSince: Double?
    private var deliveredIds = Set<String>()
    private var lastTaskCallId = "voice"
    /// Caller lines already posted as part of an ask.
    private var askedLineIds = Set<String>()
    private var lastAsk: (text: String, at: Date)?
    private var landedCount = 0
    private var stateSink: AnyCancellable?
    private var deliverTask: Task<Void, Never>?
    private var pendingFrames: [String] = []

    private var ticker: Timer?

    init(bot: Bot, threadId: String, session: Session, opener: String? = nil) {
        self.bot = bot
        self.threadId = threadId
        self.session = session
        self.opener = opener
        self.settings = Self.savedSettings(botId: bot.id)
    }

    // MARK: - Controls

    func start() {
        startTicker()
        Task { await prepareMicrophone() }
        Task { await dial(reconnect: false) }
    }

    func hangUp() { finish(failure: nil) }

    func toggleMute() {
        muted.toggle()
        Haptics.selection()
    }

    func setVoice(_ voice: String) { update { $0.voice = voice } }
    func setSpeed(_ speed: Double) { update { $0.speed = speed } }
    func setLanguage(_ language: String) { update { $0.language = language } }

    private func update(_ change: (inout VoiceCallSettings) -> Void) {
        var next = settings
        change(&next)
        next = next.normalized(for: options)
        guard next != settings else { return }
        settings = next
        Self.save(next, botId: bot.id)
        // Same instructions, new voice/speed/language, mid-call.
        if invited, socketOpen, let plan {
            send(RealtimeVoice.sessionUpdate(plan: plan, settings: next, reconnect: isReconnect))
        }
    }

    // MARK: - Microphone

    private func prepareMicrophone() async {
        let granted = await AVAudioApplication.requestRecordPermission()
        guard !isOver else { return }
        guard granted else {
            return finish(failure: "Microphone access is off for BOS. Turn it on in Settings to talk to \(bot.name).")
        }
        audio.onCapture = { [weak self] data, level in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.captured(data, level: level) } }
        }
        audio.onSpeakerLevel = { [weak self] level in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.levels.speaker = level } }
        }
        audio.onReset = { [weak self] in
            MainActor.assumeIsolated { self?.audioWasReset() }
        }
        do {
            try audio.start()
        } catch {
            return finish(failure: "Couldn't start the microphone: \(error.localizedDescription)")
        }
        micReady = true
        maybeInvite()
    }

    private func captured(_ pcm: Data, level: Float) {
        levels.mic = muted ? 0 : level
        // Muted frames are simply not sent: the server's VAD sees a gap.
        guard !muted, socketOpen, invited, let socket else { return }
        socket.send(.string(RealtimeVoice.audioAppend(base64: pcm.base64EncodedString()))) { _ in }
    }

    private func audioWasReset() {
        // Everything scheduled is gone; treat it as heard up to now.
        spans.removeAll()
        wasPlaying = false
    }

    // MARK: - Dialing

    private func dial(reconnect: Bool) async {
        guard let session, !isOver else { return }
        dialToken &+= 1
        let token = dialToken
        do {
            let language = settings.language == VoiceCallSettings.autoLanguage ? nil : settings.language
            let start = try await session.startVoiceCall(botId: bot.id, language: language, callId: callId)
            guard token == dialToken, !isOver else { return }
            if plan == nil || !reconnect { plan = start.plan }
            options = start.options
            let normalized = settings.normalized(for: options)
            if normalized != settings { settings = normalized }
            let url = try RealtimeVoice.realtimeURL(credential: start.credential,
                                                    conversationId: reconnect ? conversationId : nil)
            let task = urlSession.webSocketTask(with: url, protocols: RealtimeVoice.subprotocols(for: start.credential))
            task.maximumMessageSize = 16 * 1024 * 1024
            socket = task
            socketOpen = false
            sessionReady = false
            invited = false
            isReconnect = reconnect
            task.resume()
            receive(on: task)
            armDialTimeout(task)
        } catch {
            guard token == dialToken, !isOver else { return }
            if reconnect, !Self.isFatal(error) { scheduleReconnect() }
            else { finish(failure: Self.describe(error)) }
        }
    }

    private static func isFatal(_ error: Error) -> Bool {
        if case let APIError.status(code, _) = error { return [401, 403, 404, 409].contains(code) }
        if error is RealtimeVoice.URLError { return true }
        return false
    }

    private static func describe(_ error: Error) -> String {
        if case RealtimeVoice.URLError.undialable = error { return "The computer pointed the call at an address BOS won't dial." }
        if case let APIError.status(code, message) = error {
            if code == 409 { return message ?? "Add an xAI key in Settings on the computer to turn on voice calls." }
            if code == 502 { return message.map { "xAI refused the call: \($0)" } ?? "xAI refused the call." }
            if code == 404 { return "Update BOS on the computer to use voice calls, or this bot is gone." }
        }
        return error.localizedDescription
    }

    private func armDialTimeout(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, task === self.socket, !self.sessionReady, !self.isOver else { return }
            task.cancel(with: .goingAway, reason: nil)
            self.socketDropped(task, code: nil)
        }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, task === self.socket else { return }
                    switch result {
                    case let .success(.string(text)):
                        self.handle(text)
                        self.receive(on: task)
                    case .success:
                        // Binary frames are not part of the protocol.
                        self.receive(on: task)
                    case .failure:
                        self.socketDropped(task, code: task.closeCode == .invalid ? nil : task.closeCode.rawValue)
                    }
                }
            }
        }
    }

    fileprivate func socketOpened(_ task: URLSessionWebSocketTask) {
        guard task === socket, !isOver else { return }
        socketOpen = true
        maybeInvite()
    }

    fileprivate func socketDropped(_ task: URLSessionTask, code: Int?) {
        guard task === socket, !isOver else { return }
        socket = nil
        socketOpen = false
        sessionReady = false
        invited = false
        if code == RealtimeVoice.policyCloseCode {
            return finish(failure: "xAI closed the call. Check the xAI key on the computer.")
        }
        if hasBeenLive { scheduleReconnect() }
        else { finish(failure: "Couldn't reach the voice service. Try again in a moment.") }
    }

    private func scheduleReconnect() {
        guard !isOver else { return }
        guard reconnectAttempt < RealtimeVoice.maxReconnectAttempts else {
            return finish(failure: "Lost the line to \(bot.name). Try calling again.")
        }
        phase = .reconnecting
        resetLine()
        let delay = RealtimeVoice.reconnectDelay(attempt: reconnectAttempt)
        reconnectAttempt += 1
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled, let self else { return }
            await self.dial(reconnect: true)
        }
    }

    /// The server forgot the in-flight turn; so does the phone.
    private func resetLine() {
        audio.dropScheduled()
        spans.removeAll()
        owedTruncations.removeAll()
        responding = false
        responseRequested = false
        callerSpeaking = false
        talkedOver = false
        owed = nil
        for index in lines.indices where !lines[index].final {
            if lines[index].text.isEmpty { continue }
            lines[index].final = true
        }
        lines.removeAll { $0.text.isEmpty }
    }

    /// session.update once the socket is open and the mic is running; on a
    /// reconnect, the settled turns follow so the model has its memory back.
    private func maybeInvite() {
        guard socketOpen, micReady, !invited, let plan else { return }
        invited = true
        send(RealtimeVoice.sessionUpdate(plan: plan, settings: settings, reconnect: isReconnect))
        if isReconnect {
            for line in lines where line.final && !line.text.isEmpty {
                send(RealtimeVoice.replay(role: line.speaker, text: line.text))
            }
        }
    }

    private func becameLive() {
        phase = .live
        reconnectAttempt = 0
        if !hasBeenLive {
            hasBeenLive = true
            startedAt = Date()
            audio.playChime(rising: true)
            Haptics.impact(.light)
            // Open with a greeting (or the reason for this call) unless they
            // already started talking. Held at most 15 s; speaking first
            // cancels it.
            if !callerHasSpoken, let direction = opener ?? plan?.greeting.direction {
                requestResponse(direction,
                                expires: Date().addingTimeInterval(RealtimeVoice.greetingGraceSeconds))
            }
        }
        let queued = pendingFrames
        pendingFrames.removeAll()
        queued.forEach(send)
    }

    private func send(_ frame: String) {
        socket?.send(.string(frame)) { _ in }
    }

    // MARK: - Events

    private func handle(_ text: String) {
        guard let event = RealtimeServerEvent.parse(text) else { return }
        switch event {
        case .sessionReady:
            // Only once our session.update has gone out, so the greeting
            // never reaches the model ahead of its instructions.
            if invited, !sessionReady {
                sessionReady = true
                becameLive()
            }
        case let .conversationCreated(id):
            if conversationId == nil { conversationId = id }
        case .responseCreated:
            responding = true
            responseRequested = false
            talkedOver = false
            spokeThisResponse = false
        case .responseDone:
            responding = false
            responseRequested = false
            owedTruncations.forEach(send)
            owedTruncations.removeAll()
            payOwed()
        case let .audioDelta(itemId, contentIndex, base64):
            guard !talkedOver, !callerSpeaking, let data = Data(base64Encoded: base64) else { return }
            spokeThisResponse = true
            play(RealtimeVoice.floats(fromPCM16: data), itemId: itemId, contentIndex: contentIndex)
        case let .speechStarted(itemId):
            callerStartedSpeaking(itemId: itemId)
        case .speechStopped:
            callerSpeaking = false
        case let .userTranscript(itemId, text, replace, final):
            upsertUser(itemId: itemId, text: text, replace: replace, final: final)
        case let .userTranscriptFailed(itemId):
            lines.removeAll { $0.id == itemId && $0.text.isEmpty }
        case let .assistantTranscriptDelta(itemId, delta):
            guard !talkedOver else { return }
            spokeThisResponse = true
            appendAssistant(itemId: itemId, delta: delta)
        case let .assistantTranscriptDone(itemId, transcript):
            guard let index = lines.firstIndex(where: { $0.id == itemId }), !lines[index].interrupted else { return }
            if let transcript, !transcript.isEmpty { lines[index].text = transcript }
            lines[index].final = true
        case let .itemTruncated(itemId, _, transcript):
            truncated(itemId: itemId, transcript: transcript)
        case let .functionCall(callId, name, arguments):
            handleTool(callId: callId, name: name, arguments: arguments)
        case .error, .unsupported:
            break
        }
    }

    private func play(_ samples: [Float], itemId: String, contentIndex: Int) {
        guard let span = audio.schedule(samples) else { return }
        let key = "\(itemId):\(contentIndex)"
        if var existing = spans[key] {
            existing.end = span.end
            spans[key] = existing
        } else {
            spans[key] = Span(itemId: itemId, contentIndex: contentIndex, start: span.start, end: span.end)
        }
    }

    /// Barge-in: stop talking now, tell the server how much was actually
    /// heard, and drop the rest of that response.
    private func callerStartedSpeaking(itemId: String?) {
        callerSpeaking = true
        callerHasSpoken = true
        // A held turn is moot: the model answers what they just said.
        owed = nil
        if responding || responseRequested {
            talkedOver = true
            for index in lines.indices where lines[index].speaker == .assistant && !lines[index].final {
                lines[index].final = true
                lines[index].interrupted = true
            }
        }
        truncateWhatTheyNeverHeard()
        if let itemId, !itemId.isEmpty, !lines.contains(where: { $0.id == itemId }) {
            lines.append(Line(id: itemId, speaker: .user, text: "", final: false))
        }
    }

    private func truncateWhatTheyNeverHeard() {
        let now = audio.now
        var cuts: [String] = []
        for span in spans.values where span.end > now {
            let played = max(0, now - span.start)
            let total = max(1, span.end - span.start)
            heardFraction[span.itemId] = min(1, Double(played) / Double(total))
            let ms = RealtimeVoice.audioEndMs(playedSeconds: Double(played) / VoiceCallAudio.rate)
            cuts.append(RealtimeVoice.truncate(itemId: span.itemId, contentIndex: span.contentIndex, audioEndMs: ms))
        }
        audio.dropScheduled()
        spans.removeAll()
        wasPlaying = false
        if responding { owedTruncations.append(contentsOf: cuts) } else { cuts.forEach(send) }
    }

    private func truncated(itemId: String, transcript: String?) {
        guard let index = lines.firstIndex(where: { $0.id == itemId }) else { return }
        if let transcript {
            lines[index].text = transcript
        } else if let fraction = heardFraction[itemId] {
            lines[index].text = Self.cut(lines[index].text, keeping: fraction)
        }
        lines[index].final = true
        lines[index].interrupted = true
        if lines[index].text.isEmpty { lines.remove(at: index) }
    }

    /// The heard part of a line, to a word boundary.
    static func cut(_ text: String, keeping fraction: Double) -> String {
        guard fraction < 1 else { return text }
        let words = text.split(separator: " ", omittingEmptySubsequences: true)
        let kept = Int((Double(words.count) * max(0, fraction)).rounded(.up))
        return words.prefix(kept).joined(separator: " ")
    }

    private func upsertUser(itemId: String, text: String, replace: Bool, final: Bool) {
        let id = itemId.isEmpty ? "user-\(lines.count)" : itemId
        if let index = lines.firstIndex(where: { $0.id == id }) {
            lines[index].text = replace ? text : lines[index].text + text
            if final { lines[index].final = true }
        } else {
            // A user line that arrives after the reply started still belongs
            // before it.
            let line = Line(id: id, speaker: .user, text: text, final: final)
            if let reply = lines.lastIndex(where: { $0.speaker == .assistant && !$0.final }) {
                lines.insert(line, at: reply)
            } else {
                lines.append(line)
            }
        }
        if final, let index = lines.firstIndex(where: { $0.id == id }) {
            lines[index].text = lines[index].text.trimmingCharacters(in: .whitespacesAndNewlines)
            if lines[index].text.isEmpty { lines.remove(at: index) }
        }
    }

    private func appendAssistant(itemId: String, delta: String) {
        if let index = lines.firstIndex(where: { $0.id == itemId }) {
            guard !lines[index].interrupted, !lines[index].final else { return }
            lines[index].text += delta
        } else {
            lines.append(Line(id: itemId, speaker: .assistant, text: delta, final: false))
        }
        if lines.count > 200 { lines.removeFirst(lines.count - 200) }
    }

    // MARK: - Turn gate

    /// Ask the model to speak now if the line is free, else once it is.
    private func requestResponse(_ instructions: String?, expires: Date? = nil) {
        if lineIsFree { sendResponseCreate(instructions) }
        else { owed = OwedTurn(instructions: instructions, expires: expires) }
    }

    private var lineIsFree: Bool {
        socketOpen && sessionReady && !callerSpeaking && !responding && !responseRequested && !audio.isPlaying
    }

    private func payOwed() {
        guard let turn = owed else { return }
        if let expires = turn.expires, Date() >= expires { owed = nil; return }
        guard lineIsFree else { return }
        owed = nil
        sendResponseCreate(turn.instructions)
    }

    private func sendResponseCreate(_ instructions: String?) {
        responseRequested = true
        send(RealtimeVoice.responseCreate(instructions: instructions))
    }

    // MARK: - Tools

    private func handleTool(callId: String, name: String, arguments: String) {
        switch RealtimeVoice.ToolName(rawValue: name) {
        case .sendTask:
            sendTask(callId: callId, arguments: arguments)
        case .recallTextMessages:
            let messages = session?.state.visibleTranscript(forThread: threadId) ?? []
            output(callId, RealtimeVoice.recallOutput(messages))
            requestResponse(nil)
        case .staySilent:
            output(callId, [:])
        case .endTheCall:
            output(callId, [:])
            // Let the goodbye finish playing, at most fifteen seconds.
            hangUpDeadline = Date().addingTimeInterval(RealtimeVoice.goodbyeWaitSeconds)
        case nil:
            output(callId, ["error": .string("There is no tool called \(name).")])
            requestResponse(nil)
        }
    }

    private func output(_ callId: String, _ value: JSONValue) {
        send(RealtimeVoice.functionCallOutput(callId: callId, output: value))
    }

    private func sendTask(callId: String, arguments: String) {
        switch RealtimeVoice.sendTaskRequest(arguments: arguments, maxChars: plan?.maxRequestChars ?? 2000) {
        case let .failure(rejection):
            output(callId, ["error": .string(rejection.message)])
            requestResponse(nil)
        case let .success(request):
            watchForReplies()
            lastTaskCallId = callId
            handedWork = true
            // A receipt, at once: the call never waits on the work.
            output(callId, ["status": "sent"])
            if !spokeThisResponse, let plan { requestResponse(plan.receiptTurn) }
            let botId = bot.id, threadId = threadId, name = bot.name, origin = self.callId
            Task { [weak self] in
                // The caller's last words may still be transcribing.
                await self?.waitForCallerTranscript()
                guard let self, let session = self.session, !self.isOver else { return }
                let ask = VoiceCallAsk.make(spoken: self.takeCallerWords(), request: request)
                // The model asking twice for one thing is one message.
                guard !ask.repeats(self.lastAsk, now: Date()) else { return }
                self.lastAsk = (ask.text, Date())
                if let failure = await session.sendFromVoiceCall(ask.text, job: ask.job, callId: origin,
                                                                 botId: botId, threadId: threadId) {
                    self.landed(eventId: "\(callId).failed", text: "That job never reached \(name): \(failure) Tell them it did not go through.", at: Date())
                }
            }
        }
    }

    /// Up to 1.5 s for an in-flight caller transcript to settle.
    private func waitForCallerTranscript() async {
        for _ in 0..<15 {
            let pending = lines.contains { $0.speaker == .user && !$0.final && !askedLineIds.contains($0.id) }
            guard pending, !isOver else { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// What the caller said since the previous ask, verbatim, oldest first.
    private func takeCallerWords() -> [String] {
        let fresh = lines.filter { $0.speaker == .user && !askedLineIds.contains($0.id) && !$0.text.isEmpty }
        fresh.forEach { askedLineIds.insert($0.id) }
        return fresh.map(\.text)
    }

    /// From the first send_task on, every settled bot text line that lands
    /// in the thread is fed into the call, batched so a burst is one update.
    private func watchForReplies() {
        guard watchSince == nil, let session else { return }
        watchSince = Date().timeIntervalSince1970 * 1000 - 1000
        deliveredIds = Set(session.state.transcript(forThread: threadId).map(\.id))
        stateSink = session.stateChanges.sink { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleDelivery() }
        }
    }

    private func scheduleDelivery() {
        guard deliverTask == nil, !isOver else { return }
        deliverTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard let self, !Task.isCancelled else { return }
            self.deliverTask = nil
            self.deliverLanded()
        }
    }

    /// Only settled text: while the bot works, half-written lines and tool
    /// chatter stay unspoken; the turn's last line, or everything once the
    /// bot is idle, goes in.
    private func deliverLanded() {
        guard let session, let since = watchSince, !isOver else { return }
        let current = session.state.bot(bot.id)
        let busy = current?.projected(forThread: threadId)?.busy ?? current?.busy ?? false
        let fresh = RealtimeVoice.landedReplies(session.state.transcript(forThread: threadId),
                                                since: since, busy: busy, delivered: deliveredIds)
        guard !fresh.isEmpty else { return }
        fresh.forEach { deliveredIds.insert($0.id) }
        landedCount += 1
        let eventId = landedCount == 1 ? lastTaskCallId : "\(lastTaskCallId).\(landedCount)"
        let text = fresh.compactMap(\.text).joined(separator: "\n\n")
        landed(eventId: eventId, text: text, at: Date(timeIntervalSince1970: (fresh.last?.at ?? 0) / 1000))
    }

    /// `async_update.add`: the server starts its own response for it.
    private func landed(eventId: String, text: String, at: Date) {
        let frame = RealtimeVoice.asyncUpdate(eventId: eventId, text: text, timestampMs: at.timeIntervalSince1970 * 1000)
        if socketOpen, sessionReady { send(frame) } else { pendingFrames.append(frame) }
    }

    // MARK: - Ticker

    private func startTicker() {
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    private func tick() {
        let playing = audio.isPlaying
        if wasPlaying, !playing {
            spans.removeAll()
            payOwed()
        }
        wasPlaying = playing
        levels.callerSpeaking = callerSpeaking
        levels.assistantSpeaking = playing
        if !playing { levels.speaker *= 0.8 }

        let next: Activity
        if phase != .live { next = .idle }
        else if callerSpeaking { next = .listening }
        else if playing { next = .speaking }
        else if responding || responseRequested { next = .thinking }
        else { next = .idle }
        if next != activity { activity = next }

        if let startedAt {
            let seconds = Int(Date().timeIntervalSince(startedAt))
            if seconds != elapsed { elapsed = seconds }
        }

        if let deadline = hangUpDeadline, (!responding && !playing) || Date() >= deadline {
            hangUpDeadline = nil
            hangUp()
        }
    }

    // MARK: - Ending

    private func finish(failure: String?) {
        guard !isOver else { return }
        dialToken &+= 1
        reconnectTask?.cancel()
        deliverTask?.cancel()
        stateSink = nil
        ticker?.invalidate()
        ticker = nil
        if let socket {
            socket.cancel(with: .normalClosure, reason: Data(RealtimeVoice.hangUpReason.utf8))
        }
        socket = nil
        socketOpen = false
        urlSession.finishTasksAndInvalidate()
        let audio = self.audio
        if hasBeenLive, failure == nil {
            audio.playChime(rising: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { audio.stop() }
        } else {
            audio.stop()
        }
        if let startedAt {
            elapsed = Int(Date().timeIntervalSince(startedAt))
            session?.reportVoiceCallUsage(callId: callId, seconds: elapsed)
        }
        activity = .idle
        levels.mic = 0
        levels.speaker = 0
        phase = failure.map(Phase.failed) ?? .ended
        onEnded?(self)
    }

    // MARK: - Settings persistence

    private static func settingsKey(_ botId: String) -> String { "voiceCall.settings.\(botId)" }

    static func savedSettings(botId: String) -> VoiceCallSettings {
        guard let data = UserDefaults.standard.data(forKey: settingsKey(botId)),
              let settings = try? JSONDecoder().decode(VoiceCallSettings.self, from: data)
        else { return VoiceCallSettings() }
        return settings
    }

    static func save(_ settings: VoiceCallSettings, botId: String) {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        UserDefaults.standard.set(data, forKey: settingsKey(botId))
    }
}

/// URLSession's websocket open/close callbacks, forwarded to the call.
private final class SocketDelegate: NSObject, URLSessionWebSocketDelegate {
    weak var owner: RealtimeVoiceCall?

    init(owner: RealtimeVoiceCall) { self.owner = owner }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        MainActor.assumeIsolated { owner?.socketOpened(webSocketTask) }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        MainActor.assumeIsolated { owner?.socketDropped(webSocketTask, code: closeCode.rawValue) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error != nil else { return }
        MainActor.assumeIsolated { owner?.socketDropped(task, code: nil) }
    }
}

// MARK: - Call center

/// One voice call at a time, app-wide: it survives navigating away from the
/// chat (the pill) and is drawn above the whole app.
struct VoiceCallRecord: Codable, Identifiable, Hashable {
    var id: String
    var botId: String
    var threadId: String
    var endedAt: Double
    var seconds: Int
}

@MainActor
final class VoiceCallCenter: ObservableObject {
    static let shared = VoiceCallCenter()

    enum Presentation { case splash, full, pill }

    @Published private(set) var call: RealtimeVoiceCall?
    @Published var presentation: Presentation = .splash
    @Published var showingSettings = false
    @Published private(set) var records: [VoiceCallRecord]
    /// A bot ringing, shown full screen above the app until answered.
    @Published private(set) var incoming: IncomingVoiceRing?

    private static let recordsKey = "voiceCall.records"
    private var seenRings = Set<String>()
    private var ringer: VoiceRinger?

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.recordsKey),
           let records = try? JSONDecoder().decode([VoiceCallRecord].self, from: data) {
            self.records = records
        } else {
            records = []
        }
    }

    func start(bot: Bot, threadId: String, session: Session, opener: String? = nil) {
        if let call, !call.isOver {
            if call.bot.id == bot.id, opener == nil {
                withAnimation(.spring(duration: 0.4)) { presentation = .full }
                return
            }
            call.hangUp()
        }
        Haptics.impact(.medium)
        let call = RealtimeVoiceCall(bot: bot, threadId: threadId, session: session, opener: opener)
        call.onEnded = { [weak self] ended in self?.ended(ended) }
        showingSettings = false
        presentation = .splash
        withAnimation(.easeOut(duration: 0.2)) { self.call = call }
        call.start()
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, self.call === call, self.presentation == .splash else { return }
            withAnimation(.spring(duration: 0.35)) { self.presentation = .full }
        }
    }

    func minimize() {
        withAnimation(.spring(duration: 0.4)) {
            showingSettings = false
            presentation = .pill
        }
    }

    func expand(settings: Bool = false) {
        withAnimation(.spring(duration: 0.4)) {
            showingSettings = settings
            presentation = .full
        }
    }

    func dismiss() {
        withAnimation(.easeIn(duration: 0.25)) { call = nil }
    }

    private func ended(_ ended: RealtimeVoiceCall) {
        if ended.hasBeenLive {
            records.append(VoiceCallRecord(id: ended.id.uuidString, botId: ended.bot.id, threadId: ended.threadId,
                                           endedAt: Date().timeIntervalSince1970 * 1000, seconds: ended.elapsed))
            if records.count > 200 { records.removeFirst(records.count - 200) }
            if let data = try? JSONEncoder().encode(records) { UserDefaults.standard.set(data, forKey: Self.recordsKey) }
        }
        guard call === ended else { return }
        if case .failed = ended.phase { CallKitRinger.shared.callEnded(failed: true) } else { CallKitRinger.shared.callEnded(failed: false) }
        if case .failed = ended.phase {
            // The failure card stays until they dismiss it.
            withAnimation(.spring(duration: 0.35)) { presentation = .full }
            return
        }
        withAnimation(.easeIn(duration: 0.25)) { call = nil }
    }

    func records(botId: String, threadId: String) -> [VoiceCallRecord] {
        records.filter { $0.botId == botId && $0.threadId == threadId }
    }

    // MARK: Rings

    /// Show a ring full screen. Each ring once; a ring during a live call
    /// stays a notification, never a second call over the first.
    func ring(_ ring: VoiceRing, bot: Bot, session: Session, viaCallKitWait: Bool = true) {
        guard !CallKitRinger.shared.reported(ring.ringId) else { return }
        // This phone gets a VoIP push for the ring: CallKit rings it. Only if
        // that push never lands does the in-app ring take over.
        if viaCallKitWait, CallKitRinger.shared.ringsThroughCallKit {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(3))
                self?.ring(ring, bot: bot, session: session, viaCallKitWait: false)
            }
            return
        }
        guard seenRings.insert(ring.ringId).inserted, incoming == nil, liveCallId == nil else { return }
        incoming = IncomingVoiceRing(ring: ring, bot: bot, session: session)
        let ringer = VoiceRinger()
        self.ringer = ringer
        ringer.start()
        let ringId = ring.ringId
        // Unanswered rings stop on their own, like a phone.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard let self, self.incoming?.ring.ringId == ringId else { return }
            self.decline()
        }
    }

    func accept() {
        guard let incoming else { return }
        stopRinging()
        start(bot: incoming.bot, threadId: incoming.ring.threadId ?? incoming.bot.threadId, session: incoming.session,
              opener: RealtimeVoice.ringOpener(reason: incoming.ring.reason))
    }

    func decline() {
        guard incoming != nil else { return }
        stopRinging()
        Haptics.impact(.light)
    }

    /// A ring already answered from its notification.
    func markRingAnswered(_ ringId: String) {
        seenRings.insert(ringId)
        if incoming?.ring.ringId == ringId { stopRinging() }
    }

    private func stopRinging() {
        ringer?.stop()
        ringer = nil
        withAnimation(.easeIn(duration: 0.2)) { incoming = nil }
    }

    /// The live call's origin id: its done pushes stay quiet, the call says it.
    var liveCallId: String? {
        guard let call, !call.isOver else { return nil }
        return call.callId
    }

    /// The live call for this bot, if any.
    func activeCall(botId: String) -> RealtimeVoiceCall? {
        guard let call, call.bot.id == botId, !call.isOver else { return nil }
        return call
    }
}
