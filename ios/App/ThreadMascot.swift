// The open thread's face, alive (ios 1.9.4 part B, ideas 11-18).
//
// Calm when left alone, wild when touched: the header face blinks on its own
// beat, looks down at the composer while you type, reads your message after
// you send, nods as each reply lands, wears the turn's mood when it settles,
// leans toward an open question card and hops at it now and then, peeks back
// up while you scroll through history, and a long turn ends with a comet
// burst. Long-pressing a bot's message shows its face beside the menu.
//
// Every bot keeps its own body and colour. Motion is springs only; reduce
// motion leaves fades and the blink. Nothing here runs a timeline while the
// face is still: gaze and blink are animatable properties SwiftUI only
// redraws while a spring is moving, and the 30fps canvas runs only during a
// turn, as it did before.
import CompanionCore
import SwiftUI

// MARK: - Director

/// What happened in the thread, as beats the header face plays. One per
/// open chat. Counters are triggers: the face reacts when one moves.
@MainActor @Observable
final class ThreadMascotDirector {
    /// The settled turn's mood, for a few seconds.
    private(set) var mood: ThreadMood?
    private(set) var moodBeat = 0
    /// You sent something: the eyes read it.
    private(set) var readBeat = 0
    /// A bot reply landed.
    private(set) var nodBeat = 0
    /// A long turn finished.
    private(set) var burstBeat = 0
    /// A question or approval card is open in the thread.
    private(set) var cardOpen = false
    /// The reader is scrolled up through history.
    var lookingBack = false

    @ObservationIgnored private var turnStartedAt: Date?
    @ObservationIgnored private var moodTask: Task<Void, Never>?
    @ObservationIgnored private var settleTask: Task<Void, Never>?
    @ObservationIgnored private var cardKnown = false
#if DEBUG
    @ObservationIgnored private var scripted = false
#endif

    func sent() { readBeat += 1 }

    func replyLanded() { nodBeat += 1 }

    /// The first report of a chat only settles the state: a card already
    /// open when you arrive doesn't buzz, one that appears while you watch
    /// does, once.
    func cardChanged(_ open: Bool) {
        defer { cardKnown = true }
        guard open != cardOpen else { return }
        cardOpen = open
        if open, cardKnown { Haptics.impact(.soft) }
    }

    /// The thread's busy flag moved. A turn that began while the chat was
    /// open (or was already running when it opened) gets a mood and, when
    /// it ran long, the burst.
    func busyChanged(_ busy: Bool, mood settled: @escaping @MainActor () -> ThreadMood?) {
        settleTask?.cancel()
        if busy {
            if turnStartedAt == nil { turnStartedAt = Date() }
            setMood(nil)
            return
        }
        guard let started = turnStartedAt else { return }
        turnStartedAt = nil
        if ThreadMoodRules.celebrates(turnSeconds: Date().timeIntervalSince(started)) {
            burstBeat += 1
            Haptics.success()
        }
        // the turn's last line can land a beat after its end
        settleTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled, let self else { return }
            if let next = settled() { self.setMood(next) }
        }
    }

    /// Switching threads starts clean.
    func reset(busy: Bool, cardOpen open: Bool) {
        settleTask?.cancel()
        setMood(nil)
        turnStartedAt = busy ? Date() : nil
        cardOpen = open
        cardKnown = true
        lookingBack = false
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-mascot-script"), !scripted {
            scripted = true
            Task { await playScript() }
        }
#endif
    }

    private func setMood(_ next: ThreadMood?) {
        moodTask?.cancel()
        guard mood != next else { return }
        mood = next
        guard let next else { return }
        moodBeat += 1
        let hold: Duration = next == .proud ? .seconds(2.8) : .seconds(4)
        moodTask = Task { [weak self] in
            try? await Task.sleep(for: hold)
            guard !Task.isCancelled else { return }
            self?.mood = nil
        }
    }
}

#if DEBUG
extension ThreadMascotDirector {
    /// `-mascot-script`: every beat on a clock, so a simulator can be
    /// screenshotted in each pose without a live turn.
    fileprivate func playScript() async {
        func at(_ seconds: Double, _ beat: () -> Void) async {
            try? await Task.sleep(for: .seconds(seconds))
            beat()
        }
        // loops, so a slow screenshot tool still lands on every pose
        while !Task.isCancelled {
            await at(4) { sent() }
            await at(3) { replyLanded() }
            await at(2) { setMood(.proud) }
            await at(5) { setMood(.sheepish) }
            await at(5) { setMood(.curious) }
            await at(5) { setMood(nil); cardChanged(true) }
            await at(10) { cardChanged(false); lookingBack = true }
            await at(5) { lookingBack = false; burstBeat += 1; Haptics.success() }
        }
    }
}
#endif

// MARK: - Header face

/// The header pill's face for the open thread.
struct ThreadHeaderFace: View {
    let chat: Chat
    let size: CGFloat
    /// The activity feed's face for this thread, nil when it named none.
    let live: MausState?
    let director: ThreadMascotDirector
    let draft: ComposerDraft
    /// The composer has the keyboard.
    let typing: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @State private var openness: CGFloat = 1
    /// The reading sweep's eye position, while it runs.
    @State private var sweep: CGFloat?
    @State private var hopBeat = 0
    @State private var changedAt: Date?

    private var state: MausState { live ?? .idle }
    private var busy: Bool { state.showsActivity }
    private var moving: Bool { !reduceMotion && scenePhase == .active }

    /// A glyph-faced bot drawn here so its eyes can move; anything else (a
    /// photo, the older eye styles, a room) is its usual avatar, moved as a
    /// whole.
    private var glyphBot: Bot? {
        guard case let .bot(bot) = chat, MascotEyeStyle(stored: bot.mascotEyes) == .glyph,
              (bot.avatarCrop ?? .mascot) == .mascot || bot.avatarUrl == nil else { return nil }
        return bot
    }

    var body: some View {
        face
            .modifier(MoodPose(mood: director.mood, cardOpen: director.cardOpen,
                               lookingBack: director.lookingBack && !busy, enabled: moving))
            .keyframeAnimator(initialValue: Bounce(), trigger: director.nodBeat) { content, value in
                content.offset(y: moving ? value.y : 0).scaleEffect(x: 1, y: moving ? value.squash : 1, anchor: .bottom)
            } keyframes: { _ in
                KeyframeTrack(\.y) {
                    SpringKeyframe(2.6, duration: 0.12, spring: .snappy)
                    SpringKeyframe(0, duration: 0.4, spring: .bouncy)
                }
                KeyframeTrack(\.squash) {
                    SpringKeyframe(0.9, duration: 0.12, spring: .snappy)
                    SpringKeyframe(1, duration: 0.4, spring: .bouncy)
                }
            }
            .keyframeAnimator(initialValue: Bounce(), trigger: hopBeat) { content, value in
                content.offset(y: moving ? value.y : 0).scaleEffect(x: 1, y: moving ? value.squash : 1, anchor: .bottom)
            } keyframes: { _ in
                KeyframeTrack(\.squash) {
                    SpringKeyframe(0.88, duration: 0.1, spring: .snappy)
                    SpringKeyframe(1.06, duration: 0.18, spring: .snappy)
                    SpringKeyframe(0.94, duration: 0.14, spring: .snappy)
                    SpringKeyframe(1, duration: 0.3, spring: .bouncy)
                }
                KeyframeTrack(\.y) {
                    SpringKeyframe(0, duration: 0.1, spring: .snappy)
                    SpringKeyframe(-6, duration: 0.18, spring: .snappy)
                    SpringKeyframe(0, duration: 0.14, spring: .snappy)
                    SpringKeyframe(0, duration: 0.3, spring: .bouncy)
                }
            }
            .keyframeAnimator(initialValue: 1.0, trigger: director.moodBeat) { content, pop in
                content.scaleEffect(moving ? pop : 1)
            } keyframes: { _ in
                SpringKeyframe(1.16, duration: 0.14, spring: .snappy)
                SpringKeyframe(1, duration: 0.5, spring: .bouncy)
            }
            // always mounted while motion is on, so the first beat is a
            // change it can see; at rest it draws nothing
            .overlay {
                if moving { CometBurst(beat: director.burstBeat, color: chat.color, size: size) }
            }
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : nil, value: look)
            .onChange(of: director.readBeat) { _, _ in read() }
            .onChange(of: look) { _, _ in changedAt = Date() }
            .task(id: blinkKey) { await blinkLoop() }
            .task(id: hopKey) { await hopLoop() }
    }

    // MARK: Drawing

    @ViewBuilder private var face: some View {
        if let bot = glyphBot {
            if busy && moving {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
                    glyphFace(bot, now: timeline.date)
                }
            } else {
                glyphFace(bot, now: nil)
            }
        } else {
            ChatAvatarView(chat: chat, size: size, state: state, animated: busy)
        }
    }

    private func glyphFace(_ bot: Bot, now: Date?) -> some View {
        GlyphPoseFace(color: bot.color, bodyId: bot.mascotBody, state: state.glyphState, scheme: scheme,
                      now: now, changedAt: changedAt, look: look, size: size,
                      gazeX: gaze.width, gazeY: gaze.height, openness: openness)
            .animation(.spring(response: sweep == nil ? 0.38 : 0.9, dampingFraction: sweep == nil ? 0.72 : 0.9), value: gaze)
    }

    /// The glyphs on the face right now. The live state's own face during a
    /// turn; otherwise a mood, the card face, or open attentive eyes while
    /// you type, read back or the bot reads your message.
    private var look: GlyphLook? {
        if sweep != nil { return .eyes("ring") }
        if director.cardOpen { return .face(GlyphFaces.face(.waiting)) }
        if busy { return nil }
        switch director.mood {
        case .proud: return GlyphLook(left: "caret", right: "caret", accent: "star", anchor: .topRight)
        case .sheepish: return GlyphLook(left: "dash", right: "dash", accent: "drop", anchor: .topRight)
        case .curious: return GlyphLook(left: "ring", right: "ring", accent: "query", anchor: .topRight)
        case nil: break
        }
        if typing || director.lookingBack { return .eyes("ring") }
        return nil
    }

    /// Where the eyes point, in body diameters. Down is the composer and
    /// the card below; up is the history you scrolled back to.
    private var gaze: CGSize {
        guard !reduceMotion else { return .zero }
        if let sweep { return CGSize(width: sweep, height: 0.03) }
        if director.cardOpen { return CGSize(width: 0, height: 0.09) }
        if director.lookingBack, !busy { return CGSize(width: 0.04, height: -0.1) }
        if busy { return .zero }
        if director.mood == .sheepish { return CGSize(width: -0.05, height: 0.07) }
        if typing {
            // the eyes drift right as the line gets longer
            let along = min(CGFloat(draft.text.count), 48) / 48
            return CGSize(width: -0.06 + 0.12 * along, height: 0.09)
        }
        return .zero
    }

    // MARK: Beats

    private var blinkKey: Bool { scenePhase == .active && !(busy && moving && glyphBot != nil) }

    /// A blink every few seconds, sometimes a double. Off while the turn's
    /// canvas blinks on its own, and while the app is in the background.
    private func blinkLoop() async {
        guard blinkKey else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(Double.random(in: 2.6...5.6)))
            guard !Task.isCancelled else { return }
            await blink()
            if Int.random(in: 0..<5) == 0 {
                try? await Task.sleep(for: .milliseconds(140))
                await blink()
            }
        }
    }

    private func blink() async {
        withAnimation(.spring(response: 0.08, dampingFraction: 1)) { openness = 0.05 }
        try? await Task.sleep(for: .milliseconds(90))
        withAnimation(.spring(response: 0.18, dampingFraction: 0.75)) { openness = 1 }
    }

    private var hopKey: Bool { director.cardOpen && moving }

    /// While a card waits on you: a hop soon after it opens, then about
    /// every eight seconds.
    private func hopLoop() async {
        guard hopKey else { return }
        try? await Task.sleep(for: .milliseconds(700))
        while !Task.isCancelled {
            hopBeat += 1
            try? await Task.sleep(for: .seconds(Double.random(in: 7.5...8.5)))
        }
    }

    /// After a send the eyes scan your bubble left to right, then hand back
    /// to the turn.
    private func read() {
        guard !reduceMotion else { return }
        Task {
            sweep = -0.08
            try? await Task.sleep(for: .milliseconds(260))
            sweep = 0.08
            try? await Task.sleep(for: .milliseconds(950))
            sweep = nil
        }
    }

    private struct Bounce {
        var y: CGFloat = 0
        var squash: CGFloat = 1
    }
}

/// The settled pose of a mood, a card or reading back, sprung into and out
/// of. Proud puffs up with its chin raised, sheepish ducks and tips away,
/// curious tilts its head; a card pulls it down toward the card; history
/// sends it up and back.
private struct MoodPose: ViewModifier {
    let mood: ThreadMood?
    let cardOpen: Bool
    let lookingBack: Bool
    let enabled: Bool

    func body(content: Content) -> some View {
        let pose = enabled ? target : (angle: 0.0, y: 0.0, scale: 1.0)
        content
            .rotationEffect(.degrees(pose.angle), anchor: .bottom)
            .offset(y: pose.y)
            .scaleEffect(pose.scale)
            .animation(.spring(response: 0.45, dampingFraction: 0.62), value: pose.angle)
            .animation(.spring(response: 0.45, dampingFraction: 0.62), value: pose.y)
            .animation(.spring(response: 0.45, dampingFraction: 0.62), value: pose.scale)
    }

    private var target: (angle: Double, y: CGFloat, scale: CGFloat) {
        if cardOpen { return (4, 2, 1) }
        switch mood {
        case .proud: return (-5, -1, 1.06)
        case .sheepish: return (-9, 1.5, 0.96)
        case .curious: return (14, 0, 1)
        case nil: break
        }
        if lookingBack { return (-6, -2, 1) }
        return (0, 0, 1)
    }
}

extension GlyphLook {
    /// Both eyes one glyph, no accent.
    static func eyes(_ glyph: String) -> GlyphLook {
        GlyphLook(left: glyph, right: glyph, hidesAccent: true)
    }

    /// A whole table face, worn whatever the live state is.
    static func face(_ face: GlyphFace) -> GlyphLook {
        GlyphLook(left: face.left, right: face.right, accent: face.accent, anchor: face.anchor,
                  hidesAccent: face.accent == nil)
    }
}

/// `GlyphMark.draw` with gaze and blink as animatable properties, so a
/// spring moves the eyes between frames without a running timeline.
struct GlyphPoseFace: View, Animatable {
    let color: String
    let bodyId: String?
    let state: GlyphFaceState
    let scheme: ColorScheme
    let now: Date?
    let changedAt: Date?
    let look: GlyphLook?
    let size: CGFloat
    var gazeX: CGFloat
    var gazeY: CGFloat
    var openness: CGFloat

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, CGFloat> {
        get { AnimatablePair(AnimatablePair(gazeX, gazeY), openness) }
        set { gazeX = newValue.first.first; gazeY = newValue.first.second; openness = newValue.second }
    }

    /// The look with the springs' gaze and blink on it.
    private var posed: GlyphLook {
        var pose = look ?? GlyphLook()
        pose.eyeShift = CGSize(width: gazeX, height: gazeY)
        // a blink sprung from outside, between timeline frames
        pose.eyeSquash = max(0.12, min(1.2, openness))
        return pose
    }

    var body: some View {
        let pose = posed
        let color = color, bodyId = bodyId, state = state, scheme = scheme, now = now, changedAt = changedAt
        Canvas { context, canvas in
            let slot = CGRect(x: canvas.width / 4, y: canvas.height / 4, width: canvas.width / 2, height: canvas.height / 2)
            GlyphMark.draw(in: &context, slot: slot, color: color, bodyId: bodyId, state: state,
                           scheme: scheme, now: now, changedAt: changedAt, look: pose)
        }
        // the accent floats outside the body, as in GlyphMark
        .frame(width: size * 2, height: size * 2)
        .contentShape(Rectangle().inset(by: size / 2))
        .frame(width: size, height: size)
    }
}

// MARK: - Comet burst

/// A long turn's finish: comets fly out of the face and fade, in the bot's
/// colour and a few friendly palette hues (never red). Draws only for the
/// second it plays.
private struct CometBurst: View {
    let beat: Int
    let color: String
    let size: CGFloat

    private static let hues = ["blue", "yellow", "teal", "purple", "cyan", "pink"].map { GlyphFaces.resolveColor($0) }

    var body: some View {
        Color.clear
            .frame(width: size, height: size)
            .keyframeAnimator(initialValue: 1.0, trigger: beat) { content, progress in
                content.overlay {
                    if progress < 0.999 { streaks(progress) }
                }
            } keyframes: { _ in
                SpringKeyframe(0, duration: 0.001)
                SpringKeyframe(1, duration: 1.0, spring: .smooth(duration: 1.0))
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private func streaks(_ progress: Double) -> some View {
        let own = GlyphFaces.resolveColor(color)
        let count = 12
        return Canvas { context, canvas in
            let centre = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
            let p = CGFloat(progress)
            for i in 0..<count {
                let angle = Double(i) / Double(count) * 2 * .pi + 0.26
                let hex = i % 2 == 0 ? own : Self.hues[(i / 2) % Self.hues.count]
                let ink = Color(hex: hex)
                let reach = size * (0.5 + 1.25 * p) * (i % 3 == 0 ? 1.1 : 0.92)
                let tail = size * 0.5 * (1 - p) + 2
                let direction = CGPoint(x: cos(angle), y: sin(angle))
                let head = CGPoint(x: centre.x + direction.x * reach, y: centre.y + direction.y * reach)
                let back = CGPoint(x: head.x - direction.x * tail, y: head.y - direction.y * tail)
                var path = Path()
                path.move(to: back)
                path.addLine(to: head)
                let fade = 1 - p
                context.stroke(path, with: .linearGradient(Gradient(colors: [ink.opacity(0), ink.opacity(fade)]),
                                                           startPoint: back, endPoint: head),
                               style: StrokeStyle(lineWidth: 2.2 * fade + 0.6, lineCap: .round))
                let dot = 1.7 * fade + 0.5
                context.fill(Path(ellipseIn: CGRect(x: head.x - dot, y: head.y - dot, width: dot * 2, height: dot * 2)),
                             with: .color(ink.opacity(fade)))
            }
        }
        .frame(width: size * 4, height: size * 4)
    }
}

// MARK: - Long-press face

extension View {
    /// The message menu, with the bot's face popping in beside a copy of
    /// the bubble when `bot` is set (a bot's own text). Everything else
    /// keeps the system's lifted bubble.
    @ViewBuilder
    func botFaceContextMenu<Menu: View>(bot: Bot?, text: String, @ViewBuilder menu: () -> Menu) -> some View {
        if let bot, !text.isEmpty {
            contextMenu(menuItems: menu) { BotFaceMenuPreview(bot: bot, text: text) }
        } else {
            contextMenu(menuItems: menu)
        }
    }
}

private struct BotFaceMenuPreview: View {
    let bot: Bot
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            MausAvatar(color: bot.color, size: 40, bodyId: bot.mascotBody, state: .happy,
                       eyeStyle: MascotEyeStyle(stored: bot.mascotEyes), animated: true)
                .scaleEffect(shown || reduceMotion ? 1 : 0.3, anchor: .bottomTrailing)
                .rotationEffect(.degrees(shown || reduceMotion ? 0 : -24), anchor: .bottom)
                .opacity(shown ? 1 : 0)
                .padding(.top, 4)
            Text(text)
                .font(.body)
                .lineLimit(14)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .padding(12)
        .frame(width: 320, alignment: .leading)
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.55).delay(0.05)) {
                shown = true
            }
        }
    }
}
