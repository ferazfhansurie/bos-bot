// The empty thread's mascot: the bot itself, alive in the middle of a fresh
// thread, with one line under it in its own voice.
//
// Calm when left alone, wild when touched. It squeezes out of the dynamic
// island and drops into place; it breathes, blinks, glances around, gets
// drowsy and falls asleep; it reacts to the draft as it is typed, pulses with
// the mic, can be grabbed and flung off the walls, shaken (it gets
// dizzy) and screenshotted (it poses). On the first send it turns to thinking
// and gets sucked up into the header's face, where the turn's own animation
// takes over.
//
// It looks exactly like the bot everywhere else: its flat body in its own
// colour and the same bold glyph eyes as the header's face, never a second
// drawing of it. While it is out, the header's face steps aside, so there is
// only ever one of it on screen.
//
// It is never fully still. A few slow waves with random frequencies sway it,
// it breathes, and its face slides across the round body from spot to spot,
// clipped at the rim as if the body turned to look. The body turns after the
// eyes and its top lags behind every move. A new mood squashes the old glyph
// eyes shut and opens the new ones. Nothing repeats on a visible loop.
//
// Everything that moves is a spring stepped once per frame on a plain
// object — no SwiftUI state per frame, so the transcript never re-renders for
// it. Its clock is a display link that runs at 120hz while it is awake, 60hz
// asleep, keeps ticking while the transcript scrolls, and stops with the app
// in the background.
// The view is gone entirely the moment the thread has a message in it.
//
// What a mood looks like and what the mascot says is `EmptyMascotBrain` in
// CompanionCore, where it is tested.
import CompanionCore
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Where the header and its face are, measured by ChatView. Written from
/// geometry callbacks and read by the mascot each frame; nothing re-renders
/// on it.
final class MascotDock {
    var avatar: CGRect = .zero
    var header: CGRect = .zero
}

extension EnvironmentValues {
    /// The launch splash is still over the app. The mascot waits it out, or
    /// it would be born where nobody can see it.
    @Entry var launchCovered = false
}

extension Notification.Name {
    static let bosDeviceShaken = Notification.Name("bos.deviceShaken")
}

/// SwiftUI has no shake. The window is the end of the responder chain, so
/// every shake that nothing else claimed lands here.
extension UIWindow {
    open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { NotificationCenter.default.post(name: .bosDeviceShaken, object: self) }
        super.motionEnded(motion, with: event)
    }
}

struct EmptyThreadMascot: View {
    let bot: Bot
    let threadId: String
    /// Loaded, no messages, nothing running, nothing being sent.
    let isEmpty: Bool
    let draft: ComposerDraft
    let focused: Bool
    let dictating: Bool
    let unread: Int
    /// The person's other bots, one of which may drop by.
    let others: [Bot]
    let dock: MascotDock

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @Environment(\.launchCovered) private var launchCovered
    @State private var creature: MascotCreature?
    @State private var origin: CGPoint = .zero
    @State private var line: String?
    @State private var rate = MascotCreature.Rate.fast
    @State private var clock = MascotClock()
    @State private var game = MascotGameBoard()

    var body: some View {
        GeometryReader { proxy in
            if let creature, !launchCovered {
                live(creature, stage: proxy.size)
            }
        }
        .ignoresSafeArea(.container, edges: .top)
        .onGeometryChange(for: CGPoint.self) { $0.frame(in: .global).origin } action: { origin = $0 }
        .onAppear { if isEmpty { arrive() } }
        .onChange(of: isEmpty) { _, empty in
            if empty { arrive() } else { creature?.leave() }
        }
        .onChange(of: focused) { _, value in creature?.focused = value }
        .onChange(of: dictating) { _, value in creature?.dictating = value }
        .onChange(of: unread) { _, value in creature?.unread = value }
        .onReceive(NotificationCenter.default.publisher(for: .bosDeviceShaken)) { _ in creature?.shake() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            creature?.pose()
        }
        .onChange(of: rate) { _, _ in syncClock() }
        .onChange(of: scenePhase) { _, _ in syncClock() }
        .onChange(of: creature == nil) { _, _ in syncClock() }
        .onAppear { syncClock() }
        .onDisappear { clock.stop() }
    }

    private func syncClock() {
        if creature != nil, scenePhase == .active { clock.run(rate) } else { clock.pause() }
    }

    private func live(_ creature: MascotCreature, stage: CGSize) -> some View {
        let home = creature.home(in: stage, origin: origin)
        return MascotFrame(creature: creature, clock: clock, stage: stage, origin: origin,
                           name: bot.name, scheme: scheme)
        .overlay(alignment: .topLeading) {
            if let line {
                Text(line)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.center)
                    .frame(width: max(stage.width - 64, 0))
                    .id(line)
                    .transition(.opacity.combined(with: .offset(y: 4)))
                    .position(x: stage.width / 2, y: home.y + creature.side * 0.5 + 34)
                    .allowsHitTesting(false)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("empty-mascot-line")
            }
        }
        // The score is part of the scene: behind the mascot, top-anchored
        // under whichever is lower, the island or the header, so it never
        // sits on either on any phone.
        .background(alignment: .top) {
            if game.shown, !focused {
                MascotScore(board: game, tint: GlyphMark.colors(bot.color, scheme: scheme).body,
                            reduceMotion: reduceMotion)
                    .frame(width: stage.width)
                    .padding(.top, creature.scoreTop)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .allowsHitTesting(false)
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .top)))
            }
        }
        // The end of a run: centred between the score's spot and the mascot,
        // behind it, and a tap anywhere on it skips it.
        .background(alignment: .topLeading) {
            if let ending = game.ending, !focused {
                MascotEndCard(ending: ending, tint: GlyphMark.colors(bot.color, scheme: scheme).body,
                              reduceMotion: reduceMotion, skip: { game.skip() })
                    .id(ending.id)
                    .frame(width: stage.width, height: 190)
                    .position(x: stage.width / 2,
                              y: max((creature.scoreTop + home.y - creature.side * 0.6) / 2, creature.scoreTop + 95))
                    .transition(.asymmetric(insertion: .identity,
                                            removal: .opacity.combined(with: .scale(scale: 0.85))))
            }
        }
        .animation(.spring(duration: 0.45, bounce: 0.2), value: line)
        .animation(.spring(duration: 0.5, bounce: 0.15), value: home.y)
        .animation(.spring(duration: 0.35, bounce: 0.2), value: game.shown && !focused)
    }

    private func arrive() {
        let pool = others.filter { $0.id != bot.id && $0.hidden != true }
        let seed = EmptyMascotBrain.seed(threadId)
        let fresh = MascotCreature(bot: bot, seed: seed, reduceMotion: reduceMotion,
                                   cameo: pool.isEmpty ? nil : pool[seed % pool.count],
                                   draft: draft, dock: dock)
        fresh.focused = focused
        fresh.dictating = dictating
        fresh.unread = unread
        fresh.onRate = { rate = $0 }
        fresh.onLine = { line = $0 }
        fresh.onGame = { game.apply($0) }
        fresh.onGone = { [weak fresh] in
            guard let fresh, creature === fresh else { return }
            creature = nil
        }
        line = nil
        rate = .fast
        game.hide()
        creature = fresh
    }
}

/// One frame of the mascot: steps the creature to the clock and draws it,
/// with its touch surface on top. Its own view so that only it re-renders
/// on every tick, not the line or the thread around it.
private struct MascotFrame: View {
    let creature: MascotCreature
    let clock: MascotClock
    let stage: CGSize
    let origin: CGPoint
    let name: String
    let scheme: ColorScheme

    var body: some View {
        let frame = creature.step(to: clock.now, stage: stage, origin: origin)
        ZStack(alignment: .topLeading) {
            Canvas { context, _ in creature.draw(in: &context, scheme: scheme) }
                // flattened on the gpu: the canvas spans the whole thread and
                // is redrawn every frame
                .drawingGroup()
                .allowsHitTesting(false)
            MascotTouchSurface(origin: origin,
                               onTouch: { creature.touch(at: $0, from: $1) },
                               onRelease: { creature.release(velocity: $0) },
                               onExtraTouch: { creature.extraTouch(at: $0) })
                .frame(width: frame.hit, height: frame.hit)
                .position(frame.centre)
                .allowsHitTesting(frame.touchable)
                .accessibilityElement()
                .accessibilityLabel(name)
                .accessibilityHint("Tap to say hi")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { creature.tap() }
        }
    }
}

/// The mascot's frame clock: a display link in the common run loop modes.
/// A TimelineView stopped ticking while the transcript's scroll view tracked
/// a finger, so the mascot froze mid-drag and then jumped to where it was let
/// go.
@MainActor @Observable final class MascotClock {
    private(set) var now = Date()
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var target: Tick?

    func run(_ rate: MascotCreature.Rate) {
        if link == nil {
            // the time this frame will be on screen, not when the callback
            // happened to run: callback jitter was stepping the motion
            // unevenly, which reads as stutter on a fast fall
            let tick = Tick { [weak self] link in
                self?.now = Date(timeIntervalSinceNow: link.targetTimestamp - CACurrentMediaTime())
            }
            let link = CADisplayLink(target: tick, selector: #selector(Tick.fire(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
            target = tick
        }
        // awake asks for the full 120 and won't accept being halved: a game
        // at 60 is visibly choppier on a promotion screen
        let fps = Float((1 / rate.interval).rounded())
        link?.preferredFrameRateRange = CAFrameRateRange(minimum: rate == .fast ? 80 : fps / 2, maximum: fps, preferred: fps)
        link?.isPaused = false
    }

    func pause() { link?.isPaused = true }

    func stop() {
        link?.invalidate()
        link = nil
        target = nil
    }

    private final class Tick: NSObject {
        let action: (CADisplayLink) -> Void
        init(_ action: @escaping (CADisplayLink) -> Void) { self.action = action }
        @objc func fire(_ link: CADisplayLink) { action(link) }
    }
}

/// Where a finger grabs the mascot. UIKit, because a SwiftUI DragGesture over
/// the transcript lost the finger to the scroll view's pan and the throw
/// never reached the mascot. This recognizer begins on touch-down and every
/// other recognizer waits for it to fail, so a finger on the mascot stays the
/// mascot's until it lifts.
struct MascotTouchSurface: UIViewRepresentable {
    /// Points are reported in the stage's space: the window point less this.
    var origin: CGPoint
    var onTouch: (CGPoint, CGPoint) -> Void
    var onRelease: (CGSize) -> Void
    /// Another finger landed while the first is still down: juggling with
    /// two thumbs, the second tap must count too.
    var onExtraTouch: (CGPoint) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        // or a second finger never reaches the recognizer
        view.isMultipleTouchEnabled = true
        let grab = GrabRecognizer(target: context.coordinator, action: #selector(Coordinator.grabbed(_:)))
        grab.delegate = context.coordinator
        grab.onExtra = { [weak coordinator = context.coordinator] window in coordinator?.extra(window) }
        view.addGestureRecognizer(grab)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) { context.coordinator.surface = self }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var surface: MascotTouchSurface
        private var start: CGPoint = .zero

        init(_ surface: MascotTouchSurface) { self.surface = surface }

        func extra(_ window: CGPoint) {
            surface.onExtraTouch(CGPoint(x: window.x - surface.origin.x, y: window.y - surface.origin.y))
        }

        @objc func grabbed(_ grab: GrabRecognizer) {
            let window = grab.location(in: nil)
            let point = CGPoint(x: window.x - surface.origin.x, y: window.y - surface.origin.y)
            switch grab.state {
            case .began:
                start = point
                surface.onTouch(point, start)
            case .changed:
                surface.onTouch(point, start)
            case .ended, .cancelled:
                surface.onRelease(grab.velocity)
            default:
                break
            }
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool { true }
    }
}

/// One finger, from touch-down to lift, with a pan's velocity.
final class GrabRecognizer: UIGestureRecognizer {
    private var finger: UITouch?
    private var samples: [(time: TimeInterval, point: CGPoint)] = []
    /// A later finger's touch-down, in window points.
    var onExtra: ((CGPoint) -> Void)?

    /// Points per second over the last few hundredths of a second. A finger
    /// that stopped before it lifted throws nothing.
    var velocity: CGSize {
        guard let last = samples.last,
              let first = samples.first(where: { last.time - $0.time <= 0.08 }),
              last.time - first.time > 0.004
        else { return .zero }
        let dt = last.time - first.time
        return CGSize(width: (last.point.x - first.point.x) / dt, height: (last.point.y - first.point.y) / dt)
    }

    override func location(in view: UIView?) -> CGPoint {
        finger?.location(in: view) ?? super.location(in: view)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if finger == nil, let touch = touches.first {
            finger = touch
            record(touch)
            state = .began
        }
        for touch in touches where touch !== finger {
            if state == .changed || state == .began { onExtra?(touch.location(in: nil)) }
            ignore(touch, for: event)
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let finger, touches.contains(finger) else { return }
        record(finger)
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let finger, touches.contains(finger) else { return }
        record(finger)
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let finger, touches.contains(finger) else { return }
        state = .cancelled
    }

    override func reset() {
        super.reset()
        finger = nil
        samples = []
    }

    private func record(_ touch: UITouch) {
        samples.append((touch.timestamp, touch.location(in: nil)))
        if let last = samples.last { samples.removeAll { last.time - $0.time > 0.2 } }
    }
}

// MARK: - The creature

final class MascotCreature {
    enum Rate: Equatable {
        case fast, sleepy
        var interval: Double {
            switch self {
            case .fast: 1.0 / 120
            case .sleepy: 1.0 / 60
            }
        }
    }

    struct Frame {
        var centre: CGPoint
        var hit: CGFloat
        var touchable: Bool
    }

    /// Something floating in the scene during a run: knock the mascot
    /// through it to collect it. Drawn as a flat glyph in the bot's accent.
    private struct Pickup {
        enum Kind {
            case star, spark, heart
            var glyph: String {
                switch self {
                case .star: "star"
                case .spark: "spark"
                case .heart: "heart"
                }
            }
        }
        let id: Int
        let kind: Kind
        let born: TimeInterval
        let life: TimeInterval
        var p: CGPoint
        var v: CGVector
        let phase: Double
        var size = Spring(0, stiffness: 300, damping: 14)
        var taken: TimeInterval?
    }

    /// A damped spring, stepped by hand. Every motion here is one of these.
    struct Spring {
        var value: CGFloat
        var velocity: CGFloat = 0
        var target: CGFloat
        var stiffness: CGFloat
        var damping: CGFloat

        init(_ value: CGFloat, stiffness: CGFloat = 170, damping: CGFloat = 14) {
            self.value = value
            self.target = value
            self.stiffness = stiffness
            self.damping = damping
        }

        mutating func step(_ dt: CGFloat) {
            velocity += (-stiffness * (value - target) - damping * velocity) * dt
            value += velocity * dt
        }

        var resting: Bool { abs(value - target) < 0.003 && abs(velocity) < 0.03 }
    }

    /// One eye's shape, each number on its own spring, so moods blend.
    /// The header's own glyph eyes. A new face squashes the old glyphs shut
    /// and opens the new ones, the way every glyph face changes.
    struct GlyphEyes {
        var left: String
        var right: String
        private var next: (left: String, right: String)?
        private var swapAt: TimeInterval?

        init(_ face: MascotMoodFace) { left = face.left; right = face.right }

        mutating func aim(_ face: MascotMoodFace, at t: TimeInterval) {
            if let next {
                guard next.left != face.left || next.right != face.right else { return }
            } else if face.left == left, face.right == right {
                return
            }
            next = (face.left, face.right)
            if swapAt == nil { swapAt = t }
        }

        /// How open the eyes are this frame: 1 ... 0.1 squashed shut at the
        /// middle of a change, when the glyphs swap.
        mutating func squash(at t: TimeInterval) -> CGFloat {
            guard let start = swapAt else { return 1 }
            let k = (t - start) / 0.14
            if k >= 0.5, let next { left = next.left; right = next.right; self.next = nil }
            if k >= 1 { swapAt = next == nil ? nil : t; return 1 }
            return max(0.1, CGFloat(abs(1 - 2 * k)))
        }
    }

    private enum Mode { case birth, home, held, flung, leaving }

    /// What the keepy-uppy game tells the view: the score lives up top, the
    /// physics live here.
    enum GameEvent {
        case start(best: Int)
        case scored(score: Int, points: Int, trick: String?, newBest: Bool, milestone: Bool)
        case missed(score: Int, newBest: Bool)
        case note(String)
        case quit
    }

    static let bestKey = "bos.mascot.keepyUppy.best"

    // Who it is.
    let color: String
    let bodyId: String?
    let name: String
    let side: CGFloat = 84
    private let seed: Int
    private let day: MascotDayMood
    private let reduceMotion: Bool
    private let cameo: Bot?
    private let draft: ComposerDraft
    private let dock: MascotDock

    // What the host tells it.
    var focused = false {
        didSet {
            guard focused != oldValue else { return }
            if focused { quitGame() }
            poke()
            keyboardMoved()
        }
    }
    var dictating = false { didSet { if dictating != oldValue { poke() } } }
    var unread = 0

    var onRate: ((Rate) -> Void)?
    var onLine: ((String?) -> Void)?
    var onGone: (() -> Void)?
    var onGame: ((GameEvent) -> Void)?

    // Stage, in the overlay's own space (its top is the screen's top).
    private var stage: CGSize = .zero
    private var origin: CGPoint = .zero
    private var island: CGRect = .zero
    private var hasIsland = false
    private var safeTop: CGFloat = 0

    // Time, in seconds since it arrived. Paused frames do not count.
    private var t: TimeInterval = 0
    private var last: Date?
    // The birth waits for a quiet screen: the thread slides in and lays out
    // on its first frames, and a drop that starts then stutters (build 86).
    private var started = false
    private var settleFrames = 0
    private var settleSince: Date?
    private var rng: UInt64

    // Body.
    private var mode: Mode
    private var p = CGPoint.zero
    private var v = CGVector.zero
    private var sx = Spring(1, stiffness: 300, damping: 15)
    private var sy = Spring(1, stiffness: 300, damping: 15)
    private var rot = Spring(0, stiffness: 150, damping: 11)
    private var scale = Spring(1, stiffness: 240, damping: 22)
    // Eyes jump (a saccade is stiff and quick); the body turns after them.
    private var gazeX = Spring(0, stiffness: 900, damping: 52)
    private var gazeY = Spring(0, stiffness: 900, damping: 52)
    private var turn = Spring(0, stiffness: 38, damping: 8.5)
    // The top of the body lags every move and wobbles back.
    private var shear = Spring(0, stiffness: 95, damping: 9)
    // The face leads: it slides toward where the body is going.
    private var leadX = Spring(0, stiffness: 420, damping: 28)
    private var leadY = Spring(0, stiffness: 420, damping: 28)
    private var eyes = GlyphEyes(EmptyMascotBrain.face(.idle))
    private var eyeSquash: CGFloat = 1
    private var opacity = Spring(1, stiffness: 140, damping: 24)
    private var voice = Spring(0, stiffness: 600, damping: 45)

    // Birth and departure.
    private var neck = Spring(0, stiffness: 320, damping: 26)
    private var pill = Spring(0, stiffness: 260, damping: 24)
    private var released = false
    private var snapped = false
    private var landedAt: TimeInterval?
    private var leftAt: TimeInterval?
    private var gone = false

    // Touch.
    private var touching = false
    private var moved = false
    private var finger = CGPoint.zero
    private var grab = CGVector.zero
    private var flungAt: TimeInterval = 0
    /// Down on the floor after a throw: when it hops back home, and whether
    /// it is in the air on the way.
    private var homeHopAt: TimeInterval?
    private var hopping = false
    private var lastBump: TimeInterval = -1
    private var tapCount = 0

    // Keepy-uppy: a flick starts a run, every hit while it is up scores, the
    // floor ends it. A wall bank and a ceiling bonk each score once between
    // hits, so a good throw is worth more than a tap.
    private var playing = false
    private var swatting = false
    private var score = 0
    private var best = 0
    private var bestAtStart = 0
    private var celebrated = false
    /// A new best just ended a run: hops left in its little celebration.
    private var cheers = 0
    private var cheerAt: TimeInterval = 0
    /// Things floating in the scene to knock it through during a run.
    private var pickups: [Pickup] = []
    private var pickupCount = 0
    private var nextPickup: TimeInterval = 0
    /// Hearts caught: each one saves a miss.
    private var saves = 0
    private var lastHit: TimeInterval = -1
    private var bankFree = false
    private var bonkFree = false
    /// A touch that landed during a run but not on it: it does nothing,
    /// no grab, no throw, no tap.
    private var whiffed = false
    private var touchStart = CGPoint.zero
    /// Where it has just been, one point a frame: a finger aims at what the
    /// screen showed a frame or two ago, so a hit counts anywhere along it.
    private var trail: [(t: TimeInterval, p: CGPoint)] = []
    /// The sideways drift that creeps in late in a run: two slow waves.
    private var drift: (a: Double, b: Double, fa: Double, fb: Double) = (0, 0, 0.5, 0.8)
#if DEBUG
    /// `-mascot-autoplay`: it juggles itself, for measuring and screenshots.
    private let autoplay = ProcessInfo.processInfo.arguments.contains("-mascot-autoplay")
    private var autoplayStop = 28
#endif

    // Life.
    private var lastPoke: TimeInterval = 0
    private var lastDraft = ""
    private var nextBlink: TimeInterval = 1.2
    private var blinkAt: TimeInterval = -1
    private var glance: (until: TimeInterval, x: CGFloat, y: CGFloat, tilt: CGFloat)?
    private var secondBlink: TimeInterval = -1
    private var nextSaccade: TimeInterval = 0.4
    private var focus = CGPoint.zero
    private var nextFidget: TimeInterval = 5
    private var shift: (until: TimeInterval, x: CGFloat)?
    private var waves: [(speed: Double, phase: Double)] = []
    private var oldAccent: (face: MascotMoodFace, at: TimeInterval)?
    private var nextNudge: TimeInterval = 4
    private var nudgeUntil: TimeInterval = -1
    private var nudged = false
    private var moment: (mood: MascotMood, line: EmptyMascotBrain.Moment?, until: TimeInterval)?
    private var suspiciousUntil: TimeInterval = -1
    private var rattleUntil: TimeInterval = -1
    private var poseUntil: TimeInterval = -1
    private var mood: MascotMood = .idle
    private var moodChangedAt: TimeInterval = 0
    private var shownLine: String?
    private var shownRate: Rate = .fast

    // The visitor.
    private var cameoAt: TimeInterval?
    private var cameoStart: TimeInterval?
    private var cameoX = Spring(0, stiffness: 120, damping: 17)
    private var cameoLeaving = false

    init(bot: Bot, seed: Int, reduceMotion: Bool, cameo: Bot?, draft: ComposerDraft, dock: MascotDock) {
        color = bot.color
        bodyId = bot.mascotBody
        name = bot.name
        self.seed = seed
        self.reduceMotion = reduceMotion
        self.cameo = cameo
        self.draft = draft
        self.dock = dock
        rng = UInt64(truncatingIfNeeded: seed) &+ 0x9E37_79B9_7F4A_7C15
        mode = reduceMotion ? .home : .birth
        lastDraft = draft.text
        var day = EmptyMascotBrain.dayMood(at: Date())
#if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-mascot-day"), i + 1 < args.count {
            day = MascotDayMood(morning: args[i + 1] == "morning", late: args[i + 1] == "late", friday: args[i + 1] == "friday")
        }
#endif
        self.day = day
        // Six slow waves at unrelated speeds: their sum never visibly repeats.
        for _ in 0..<6 { waves.append((0.33 + roll() * 0.9, roll() * 2 * .pi)) }
        nextFidget = 5 + roll() * 4
        // Rarely: about one empty thread in three gets a visitor, once.
        if cameo != nil, seed % 3 == 0 { cameoAt = 14 + Double(seed % 11) }
#if DEBUG
        if cameo != nil, args.contains("-mascot-cameo-now") { cameoAt = 2.6 }
#endif
        if reduceMotion { opacity = Spring(0, stiffness: 60, damping: 16); opacity.target = 1 }
    }


    // MARK: Geometry

    /// Where it rests: centred, a little above the middle of the space
    /// between the header and the composer.
    func home(in stage: CGSize, origin: CGPoint) -> CGPoint {
        let top = max(dock.header.maxY - origin.y, 0)
        let floor = max(stage.height, top + side * 2)
        return CGPoint(x: stage.width / 2, y: top + (floor - top) * 0.42)
    }

    private var topWall: CGFloat { max(dock.header.maxY - origin.y, 0) }

    /// Where the score's top goes, in the stage: under the lower of the
    /// header, the island and the status bar, with a little air.
    var scoreTop: CGFloat {
        max(topWall, island.maxY, safeTop - origin.y) + 22
    }

    private func local(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x - origin.x, y: point.y - origin.y) }

    private func measureIsland() {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        let width = window?.bounds.width ?? stage.width
        let safeTop = window?.safeAreaInsets.top ?? 0
        self.safeTop = safeTop
        // A dynamic island phone has a top inset of 59 or more; a notch
        // phone has less. Either way it comes out of the top centre.
        hasIsland = safeTop >= 59
        let size = hasIsland ? CGSize(width: 126, height: 37) : CGSize(width: 110, height: 28)
        let global = CGRect(x: width / 2 - size.width / 2, y: hasIsland ? 11 : 4, width: size.width, height: size.height)
        island = global.offsetBy(dx: -origin.x, dy: -origin.y)
    }

    // MARK: Events

    /// Something happened: the mascot is awake.
    private func poke() { lastPoke = t }

    func touch(at location: CGPoint, from start: CGPoint) {
        guard mode != .leaving, mode != .birth else { return }
        if !touching {
            touching = true
            moved = false
            grab = CGVector(dx: p.x - start.x, dy: p.y - start.y)
            finger = start
            touchStart = start
            homeHopAt = nil
            hopping = false
            if playing, mode == .flung {
                // a hit counts on touch-down; a near miss does nothing at all
                if hits(start) { swat(at: start) } else { whiffed = true }
            } else if rest == .asleep { wake() }
            poke()
        }
        finger = location
        if !swatting, !whiffed, !moved, !reduceMotion, hypot(location.x - start.x, location.y - start.y) > 10 {
            moved = true
            mode = .held
        }
    }

    func release(velocity: CGSize) {
        guard touching else { return }
        touching = false
        poke()
        if whiffed {
            whiffed = false
        } else if swatting {
            swatting = false
            flick(velocity)
        } else if moved {
            let speed = hypot(velocity.width, velocity.height)
            let cap: CGFloat = 5000
            let k = speed > cap ? cap / speed : 1
            v = CGVector(dx: velocity.width * k, dy: velocity.height * k)
            mode = .flung
            flungAt = t
            if speed > 500, !focused { startGame() }
        } else {
            tap()
        }
    }

    /// A second finger came down while the first is still on the glass.
    func extraTouch(at point: CGPoint) {
        guard playing, mode == .flung, hits(point) else { return }
        let was = swatting
        swat(at: point)
        swatting = was
    }

    func tap() {
        poke()
        if reduceMotion {
            blinkAt = t
            moment = (.happy, .tapped, t + 1.1)
            tapCount += 1
            return
        }
        guard mode == .home else { return }
        if let woke = moment, woke.line == .woke, woke.until > t { return }
        v.dy -= 360
        sy.velocity -= 3
        sx.velocity += 2.4
        blinkAt = t + 0.05
        moment = (.happy, .tapped, t + 1.0)
        tapCount += 1
        haptic(.soft, 0.8)
    }

    private func wake() {
        moment = (.surprised, .woke, t + 0.5)
        if !reduceMotion { v.dy -= 420; sy.velocity -= 4 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.mode != .leaving else { return }
            self.moment = (.happy, .woke, self.t + 1.2)
        }
        haptic(.medium, 1)
    }

    func shake() {
        guard !playing, mode == .home || mode == .flung, landedAt != nil else { return }
        poke()
        if reduceMotion { moment = (.dizzy, .shaken, t + 2); return }
        rattleUntil = t + 0.85
        moment = (.dizzy, .shaken, t + 2.8)
        for i in 0..<4 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.11 * Double(i)) { Haptics.impact(.rigid) }
        }
    }

    func pose() {
        guard mode != .leaving, landedAt != nil else { return }
        poke()
        poseUntil = t + 2.4
        moment = (.pose, .pose, t + 2.4)
        blinkAt = -1
        haptic(.soft, 0.9)
    }

    func leave() {
        guard mode != .leaving else { return }
        dropPickups()
        // a first message before it was ever born: nothing to send up
        if !started {
            mode = .leaving
            gone = true
            DispatchQueue.main.async { [weak self] in self?.onGone?() }
            return
        }
        quitGame()
        mode = .leaving
        leftAt = t
        touching = false
        moment = nil
        cameoLeaving = true
        publishLine(nil)
        // a beat of anticipation, then up it goes
        sy.velocity -= 2.5
        sx.velocity += 2
    }

    /// The keyboard is coming up (it ducks and watches it come) or going
    /// down (it stretches up, relieved, and looks back at you).
    private func keyboardMoved() {
        nextSaccade = t + 0.3
        focus = focused ? CGPoint(x: 0, y: 1) : CGPoint(x: 0, y: 0.6)
        guard landedAt != nil, mode == .home, !reduceMotion else { return }
        if focused { sy.velocity -= 2.4; sx.velocity += 1.7 } else { sy.velocity += 2.8; sx.velocity -= 1.5 }
    }

    // MARK: Step

    private var rest: MascotRest {
        if focused || dictating || touching || !lastDraft.isEmpty || mode != .home { return .awake }
        return EmptyMascotBrain.rest(idleFor: t - lastPoke)
    }

    func step(to now: Date, stage newStage: CGSize, origin newOrigin: CGPoint) -> Frame {
        if !started {
            // Three on-time frames in a row with the page standing still (a
            // push slides it), or 0.9s at most, then the clock starts.
            let elapsed = last.map { now.timeIntervalSince($0) } ?? 1
            let still = newOrigin == origin && newStage == stage && newStage.width > 0
            settleFrames = still && elapsed < 1.0 / 45 ? settleFrames + 1 : 0
            settleSince = settleSince ?? now
            last = now
            stage = newStage
            origin = newOrigin
            guard settleFrames >= 3 || now.timeIntervalSince(settleSince!) > 0.9 else {
                return Frame(centre: .zero, hit: 1, touchable: false)
            }
            started = true
            start()
            publishRate()
            return Frame(centre: p, hit: 1, touchable: false)
        }
        let elapsed = last.map { now.timeIntervalSince($0) } ?? 0
        last = now
        stage = newStage
        origin = newOrigin
        let dt0 = min(max(elapsed, 0), 1.0 / 30)
        // A late frame advances at most two frames' worth: a hitch slows the
        // motion for a beat instead of teleporting it.
        let dt = min(max(elapsed, 0), 1.0 / 30)
        if dt > 0 {
            let steps = max(1, Int((dt * 240).rounded(.up)))
            let h = dt / Double(steps)
            for _ in 0..<steps { advance(CGFloat(h)) }
            t += dt
        }
        think()
        publishRate()
        trail.append((t, p))
        trail.removeAll { t - $0.t > Self.trailLength }
        if !pickups.isEmpty || playing { stepPickups(CGFloat(dt0)) }
        var hit = side * 0.92 * scale.value
        if playing {
            // the surface only has to catch the finger; `hits` decides
            let back = trail.first.map { hypot($0.p.x - p.x, $0.p.y - p.y) } ?? 0
            hit = 2 * (hitRadius + back + 12)
        }
#if DEBUG
        if autoplay { autoplayStep() }
#endif
        return Frame(centre: p, hit: max(hit, 1), touchable: (mode == .home || mode == .held || mode == .flung) && landedAt != nil)
    }

    private func start() {
        measureIsland()
        let home = home(in: stage, origin: origin)
        if mode == .birth {
            p = CGPoint(x: island.midX, y: island.midY + 6)
            scale = Spring(0.28, stiffness: 240, damping: 20)
            pill.target = 1
        } else {
            p = home
            landedAt = 0
            publishLine(EmptyMascotBrain.line(.arrive(day), seed: seed))
        }
    }

    /// One physics substep.
    private func advance(_ dt: CGFloat) {
        let home = home(in: stage, origin: origin)
        let r = side * 0.46 * scale.value

        switch mode {
        case .birth:
            // The island wakes first: its eyes open in the pill, look around
            // and find you (`peekEyes`). Then the body drips out on a taffy
            // neck, lets go, falls and lands with a squash and a small hop.
            if !released, t > Self.peekLength {
                released = true
                scale.target = 1
                v = CGVector(dx: 0, dy: 240)
                neck.target = 1
            }
            if released {
                p.x += (home.x - p.x) * min(dt * 10, 1)
                if !snapped {
                    // the taffy holds it back while it stretches
                    v.dy = min(v.dy + 900 * dt, 420)
                    p.y += v.dy * dt
                    if p.y - island.maxY > side * 0.85 || t > Self.peekLength + 0.5 {
                        snapped = true
                        neck.target = 0
                        pill.target = 0
                        sx.velocity += 3
                        sy.velocity -= 2.5
                        haptic(.light, 0.5)
                    }
                } else {
                    v.dy += 2200 * dt
                    p.y += v.dy * dt
                    if landedAt == nil, p.y >= home.y || t > Self.peekLength + 1.6 {
                        let impact = v.dy
                        p.y = min(p.y, home.y)
                        land(impact: impact)
                    }
                }
            } else {
                p = CGPoint(x: island.midX, y: island.midY + 6 + pill.value * 10)
            }
        case .home:
            var target = home
            if !reduceMotion {
                target = homeTarget(home)
            }
            if reduceMotion { p = home; v = .zero } else { springTo(target, stiffness: 120, damping: 12.5, dt: dt) }
            if cheers > 0, t >= cheerAt { cheer() }
        case .held:
            // Stuck to the finger, not chasing it: a spring here trailed the
            // finger by a beat and made dragging feel laggy. The velocity is
            // the finger's, smoothed, so the stretch and lean still read.
            let target = CGPoint(x: finger.x + grab.dx, y: finger.y + grab.dy)
            let follow = min(dt * 30, 1)
            v.dx += ((target.x - p.x) / dt - v.dx) * follow
            v.dy += ((target.y - p.y) / dt - v.dy) * follow
            p = target
        case .flung:
            if playing {
                // in a run: no vertical drag, so every pop rises the same
                // height and falls the same way; a run gets heavier and,
                // later, drifts a little sideways
                v.dy += gameGravity * dt
                v.dx += driftPush * dt
                v.dx *= exp(-0.5 * dt)
            } else {
                // real-ish weight: falls like a thrown thing, not a balloon
                v.dy += 1700 * dt
                let drag = exp(-0.35 * dt)
                v.dx *= drag
                v.dy *= drag
            }
            p.x += v.dx * dt
            p.y += v.dy * dt
            collide(radius: r)
            let speed = hypot(v.dx, v.dy)
            if !playing { headHome(home, radius: r, speed: speed) }
        case .leaving:
            let since = t - (leftAt ?? t)
            let avatar = dock.avatar == .zero
                ? CGPoint(x: stage.width / 2, y: topWall - 30)
                : local(CGPoint(x: dock.avatar.midX, y: dock.avatar.midY))
            if since > 0.08 {
                springTo(avatar, stiffness: 260, damping: 26, dt: dt)
                let target = dock.avatar == .zero ? 0.25 : dock.avatar.width / side
                scale.target = target
            }
            let distance = hypot(p.x - avatar.x, p.y - avatar.y)
            if distance < 16 || since > 0.7 { opacity.target = 0 }
            if !gone, opacity.value < 0.03 || since > 1.4 {
                gone = true
                DispatchQueue.main.async { [weak self] in self?.onGone?() }
            }
        }

        // Squash and stretch: volume kept, the long side along the motion.
        let speedX = abs(v.dx), speedY = abs(v.dy)
        let stretchCap: CGFloat = mode == .birth ? 0.3 : 0.55
        var stretchY = 1 + min(speedY / 1700, stretchCap) - min(speedX / 3600, 0.18)
        var stretchX = 1 + min(speedX / 1700, 0.55) - min(speedY / 3600, 0.18)
        if mode == .birth, !snapped { stretchY += neck.value * 0.18; stretchX -= neck.value * 0.08 }
        if mode == .home, !reduceMotion {
            let r = rest
            let period: Double = r == .asleep ? 5.2 : r == .drowsy ? 4.4 : 3.4
            let depth: CGFloat = r == .asleep ? 0.04 : 0.024
            let breath = CGFloat(sin(t * 2 * .pi / period))
            stretchY += breath * depth
            stretchX -= breath * depth * 0.6
            if dictating {
                stretchY += voice.value * 0.16 + CGFloat(sin(t * 2 * .pi * 6)) * voice.value * 0.03
                stretchX += voice.value * 0.12
            }
        }
        if mode == .leaving, let leftAt, t - leftAt < 0.08 { stretchY = 0.86; stretchX = 1.1 }
        sx.target = stretchX
        sy.target = stretchY
        voice.target = dictating ? CGFloat(MicLevel.current) : 0

        rot.damping = 11
        rot.target = reduceMotion ? 0 : rotationTarget()
        let gaze = gazeTarget(home)
        // Reduce Motion keeps the eyes looking, a little, and stills the rest.
        gazeX.target = reduceMotion ? gaze.x * 0.5 : gaze.x
        gazeY.target = reduceMotion ? gaze.y * 0.5 : gaze.y
        turn.target = reduceMotion || mode != .home ? 0 : gazeX.value
        shear.target = reduceMotion ? 0 : max(min(v.dx / 2600, 0.26), -0.26)
        leadX.target = reduceMotion ? 0 : max(min(v.dx / 2400, 0.7), -0.7)
        leadY.target = reduceMotion ? 0 : max(min(v.dy / 2400, 0.7), -0.7)
        let poseScale: CGFloat = t < poseUntil ? 1.08 : 1
        if mode == .home || mode == .held || mode == .flung { scale.target = poseScale }

        sx.step(dt); sy.step(dt); rot.step(dt); scale.step(dt)
        gazeX.step(dt); gazeY.step(dt); opacity.step(dt); voice.step(dt)
        turn.step(dt); shear.step(dt); leadX.step(dt); leadY.step(dt)
        eyeSquash = eyes.squash(at: t)
        neck.step(dt); pill.step(dt)
        if cameoStart != nil { cameoX.step(dt) }
    }

    /// Down after a throw or a miss: it gathers itself, then hops back to
    /// its spot in one arc, eyes on where it is going. Grab it on the way
    /// and it is yours to throw again.
    private func headHome(_ home: CGPoint, radius r: CGFloat, speed: CGFloat) {
        if let at = homeHopAt {
            if t >= at, !hopping {
                hopping = true
                // a jump that lands on the spot: up over it, a little higher
                // the further it has to go
                let dx = home.x - p.x, dy = home.y - p.y
                let g: CGFloat = 1700
                let rise = max(-dy, 0) + 40 + min(abs(dx) * 0.15, 60)
                let up = sqrt(2 * g * rise)
                let fall = sqrt(2 * g * max(rise + dy, 1))
                let time = up / g + fall / g
                v = CGVector(dx: dx / time / exp(-0.35 * time / 2), dy: -up)
                sy.velocity += 4
                sx.velocity -= 2.6
                haptic(.light, 0.5)
            }
            if hopping, v.dy > 0, p.y >= home.y - 4 {
                hopping = false
                homeHopAt = nil
                mode = .home
                v.dy *= 0.25
                v.dx *= 0.3
                sy.velocity -= 3
                sx.velocity += 2.2
                blinkAt = t
            }
            return
        }
        let floored = p.y >= stage.height - r - 3
        let far = hypot(home.x - p.x, home.y - p.y) > 40
        if floored, far, speed < 260, t - flungAt > 0.45 {
            // the crouch before the hop
            homeHopAt = t + 0.2
            sy.velocity -= 3.2
            sx.velocity += 2.4
            moment = moment ?? (.alert, nil, t + 0.6)
        } else if (t - flungAt > 0.8 && speed < 240 && !floored) || t - flungAt > 2.4 {
            mode = .home
        }
    }

    private func springTo(_ target: CGPoint, stiffness: CGFloat, damping: CGFloat, dt: CGFloat) {
        v.dx += (-stiffness * (p.x - target.x) - damping * v.dx) * dt
        v.dy += (-stiffness * (p.y - target.y) - damping * v.dy) * dt
        p.x += v.dx * dt
        p.y += v.dy * dt
    }

    private func land(impact: CGFloat = 0) {
        landedAt = t
        mode = .home
        if impact > 0 {
            // squash by how hard it came down, then a small hop off the floor
            sy.velocity -= min(impact / 180, 8)
            sx.velocity += min(impact / 240, 6)
            v = CGVector(dx: 0, dy: -min(impact * 0.22, 300))
        } else {
            sy.velocity -= 3
            sx.velocity += 2.4
        }
        blinkAt = t + 0.2
        nextBlink = t + 3
        haptic(.soft, 0.9)
        poke()
        publishLine(EmptyMascotBrain.line(.arrive(day), seed: seed))
        if day.friday {
            moment = (.excited, nil, t + 1.8)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.hop(300) }
        } else if day.morning {
            moment = (.yawn, nil, t + 2.4)
        }
    }

    private func hop(_ speed: CGFloat) {
        guard mode == .home, !reduceMotion else { return }
        v.dy -= speed
        sy.velocity -= 2.5
    }

    private func collide(radius r: CGFloat) {
        let top = topWall + r
        let bottom = stage.height - r
        // positions are clamped every 240hz substep, so nothing tunnels
        let wall: CGFloat = playing ? 0.7 : 0.62
        if p.x < r { p.x = r; if v.dx < 0 { bank(-v.dx); bump(-v.dx, horizontal: true); v.dx = -v.dx * wall } }
        if p.x > stage.width - r { p.x = stage.width - r; if v.dx > 0 { bank(v.dx); bump(v.dx, horizontal: true); v.dx = -v.dx * wall } }
        if p.y < top {
            p.y = top
            if v.dy < 0 {
                let speed = -v.dy
                if playing, bonkFree, speed > 450 { bonkFree = false; scored(1, trick: "bonk") }
                bump(speed, horizontal: false)
                v.dy = -v.dy * 0.6
                if speed > 850 {
                    // a hard bonk on the ceiling: a blink, no dizzy spirals (firaz hates them on a throw)
                    blinkAt = t
                    rot.velocity += (v.dx >= 0 ? 1 : -1) * 6
                    haptic(.heavy, 1)
                }
            }
        }
        if p.y > bottom {
            p.y = bottom
            if v.dy > 0, playing, saves > 0 {
                // a heart saves it: back up, harder than a pop
                saves -= 1
                bump(v.dy, horizontal: false)
                v.dy = -popSpeed * 1.08
                moment = (.surprised, nil, t + 0.5)
                haptic(.heavy, 1)
                publishGame(.note("saved"))
            } else if v.dy > 0 {
                let missed = playing
                // the miss has its own soft thud, not the floor's knock
                if missed { miss(); lastBump = t }
                bump(v.dy, horizontal: false)
                // a miss lands soft: it plops down instead of bouncing away
                v.dy = -v.dy * (missed ? 0.32 : 0.55)
                if missed { v.dx *= 0.5 }
            }
        }
    }

    // MARK: Keepy-uppy

    // Difficulty is a function of the score alone, so it climbs with every
    // hit, never jumps, and a new run starts easy again. Build 95's climb was
    // too gentle to notice (firaz: "it doesnt get harder at all"): now it is
    // twice as heavy by 50, pops lower and quicker, the target shrinks to
    // near the body, a wind blows from 8, and the pickups move and fade
    // faster.
    private static let trailLength: TimeInterval = 0.07
    private var level: CGFloat { playing ? CGFloat(min(score, 50)) : 0 }
    /// Floaty enough at the start for anyone to keep it up; 2% heavier per
    /// hit, 2x by 50.
    private var gameGravity: CGFloat { 1250 * (1 + level * 0.02) }
    /// Every pop rises the same height, whatever it was doing when hit, a
    /// little lower as the run goes, so the beat gets quicker.
    private var popSpeed: CGFloat {
        let room = max(stage.height - topWall, 400)
        let height = min(max(room * 0.42, 230), 330) * (1 - level * 0.004)
        return sqrt(2 * gameGravity * height)
    }
    /// A generous circle round the body (it is 0.46 of the side), shrinking
    /// to 0.63 of the side by 40.
    private var hitRadius: CGFloat { side * (0.95 - CGFloat(min(score, 40)) * 0.008) * scale.value }
    /// From 8 a slow sideways wind, up to full strength at 30.
    private var driftPush: CGFloat {
        let k = min(max(CGFloat(score) - 8, 0) / 22, 1)
        guard k > 0 else { return 0 }
        let wave = 0.6 * sin(t * drift.fa * 2 * .pi + drift.a) + 0.4 * sin(t * drift.fb * 2 * .pi + drift.b)
        return 380 * k * CGFloat(wave)
    }

    /// How far `point` is from the segment `a`-`b`.
    private func reach(_ point: CGPoint, from a: CGPoint, to b: CGPoint) -> CGFloat {
        let ab = CGVector(dx: b.x - a.x, dy: b.y - a.y)
        let len = ab.dx * ab.dx + ab.dy * ab.dy
        let u = len > 0 ? max(0, min(1, ((point.x - a.x) * ab.dx + (point.y - a.y) * ab.dy) / len)) : 0
        return hypot(point.x - (a.x + ab.dx * u), point.y - (a.y + ab.dy * u))
    }

    /// Another bot drops in from the top: it pops into being, hangs for a
    /// beat while gravity eases in, then it is yours to keep up too.
    /// A finger at `point` is on it: within the radius of anywhere it has
    /// been over the last few frames.
    private func hits(_ point: CGPoint) -> Bool {
        reach(point, from: trail.first?.p ?? p, to: p) <= hitRadius
    }

    // MARK: Pickups

    /// How many float at once, by score: one from 3, two from 15, three
    /// from 35.
    private var pickupRoom: Int { score >= 35 ? 3 : score >= 15 ? 2 : score >= 3 ? 1 : 0 }

    /// Spawns, moves, collects and clears the pickups, once a frame.
    private func stepPickups(_ dt: CGFloat) {
        let r = side * 0.46 * scale.value
        let from = trail.count > 1 ? trail[trail.count - 2].p : p
        for i in pickups.indices {
            var k = pickups[i]
            k.size.step(dt)
            guard k.taken == nil else { pickups[i] = k; continue }
            // later in a run they wander, and a spark always does
            k.p.x += k.v.dx * dt
            k.p.y += k.v.dy * dt
            let pad: CGFloat = 26
            if k.p.x < pad || k.p.x > stage.width - pad { k.v.dx = -k.v.dx; k.p.x = min(max(k.p.x, pad), stage.width - pad) }
            if k.p.y < topWall + pad || k.p.y > stage.height - r * 2.2 {
                k.v.dy = -k.v.dy
                k.p.y = min(max(k.p.y, topWall + pad), stage.height - r * 2.2)
            }
            if playing, mode == .flung, reach(k.p, from: from, to: p) < r + 16 * k.size.value {
                k.taken = t
                k.size.target = 1.7
                k.size.stiffness = 500
                pickups[i] = k
                collect(k.kind)
                continue
            }
            if t - k.born > k.life || !playing { k.size.target = 0 }
            pickups[i] = k
        }
        pickups.removeAll { k in
            if let taken = k.taken { return t - taken > 0.3 }
            return k.size.target == 0 && k.size.value < 0.04
        }
        guard playing, t >= nextPickup, pickups.filter({ $0.taken == nil && $0.size.target > 0 }).count < pickupRoom else { return }
        spawnPickup()
    }

    private func spawnPickup() {
        let rollKind = roll()
        let kind: Pickup.Kind = score >= 20 && saves == 0 && rollKind < 0.14 ? .heart
            : score >= 8 && rollKind < 0.32 ? .spark
            : .star
        // somewhere it can reach: between the top of a pop and a little
        // above where it is usually hit
        let lift = popSpeed * popSpeed / (2 * gameGravity)
        let low = stage.height * 0.7
        let high = max(topWall + 60, stage.height * 0.8 - lift)
        var spot = CGPoint.zero
        for _ in 0..<6 {
            spot = CGPoint(x: 40 + CGFloat(roll()) * max(stage.width - 80, 1),
                           y: high + CGFloat(roll()) * max(low - high, 1))
            // not on top of it, and not on top of another
            let clear = hypot(spot.x - p.x, spot.y - p.y) > side * 1.1
                && pickups.allSatisfy { hypot($0.p.x - spot.x, $0.p.y - spot.y) > 70 }
            if clear { break }
        }
        let wander = min(max(CGFloat(score) - 25, 0) / 25, 1) * 70 + (kind == .spark ? 60 : 0)
        let angle = roll() * 2 * .pi
        pickupCount += 1
        var pickup = Pickup(id: pickupCount, kind: kind, born: t,
                            life: kind == .spark ? 3.5 : kind == .heart ? 5 : max(6 - Double(score) * 0.05, 3.5),
                            p: spot, v: CGVector(dx: CGFloat(cos(angle)) * wander, dy: CGFloat(sin(angle)) * wander * 0.6),
                            phase: roll() * 2 * .pi)
        pickup.size.target = 1
        pickups.append(pickup)
        nextPickup = t + 1.1 + roll() * 0.8
    }

    /// Knocked through one: a star is +2, a spark +5, a heart saves the
    /// next miss.
    private func collect(_ kind: Pickup.Kind) {
        nextPickup = max(nextPickup, t + 0.8)
        blinkAt = t
        sy.velocity -= 2.5
        sx.velocity += 2
        switch kind {
        case .star:
            scored(2, trick: "star")
        case .spark:
            haptic(.medium, 0.9)
            scored(5, trick: "spark")
        case .heart:
            saves = 1
            moment = (.happy, nil, t + 0.8)
            haptic(.medium, 0.8)
            publishGame(.note("+1 save"))
        }
    }

    /// The run ended: what is still floating shrinks away.
    private func dropPickups() {
        for i in pickups.indices where pickups[i].taken == nil { pickups[i].size.target = 0 }
    }

    private func startGame() {
        guard !reduceMotion, !playing else { return }
        playing = true
        score = 0
        best = UserDefaults.standard.integer(forKey: Self.bestKey)
        bestAtStart = best
        celebrated = false
        cheers = 0
        pickups.removeAll()
        saves = 0
        nextPickup = t + 1.2
        if cameoStart != nil { cameoLeaving = true }
        bankFree = true
        bonkFree = true
        whiffed = false
        lastHit = t
        drift = (roll() * 2 * .pi, roll() * 2 * .pi, 0.35 + roll() * 0.25, 0.7 + roll() * 0.3)
        // a wild opening throw is still a throw, just not a rocket
        let speed = hypot(v.dx, v.dy), cap: CGFloat = 2600
        if speed > cap { v.dx *= cap / speed; v.dy *= cap / speed }
        Self.prepareHaptics()
        publishGame(.start(best: best))
    }

    /// A finger on it while it is up: the same pop every time, straight up
    /// with a small push away from where it was hit.
    private func swat(at point: CGPoint) {
        swatting = true
        guard t - lastHit > 0.1 else { return }
        lastHit = t
        bankFree = true
        bonkFree = true
        let off = max(min((p.x - point.x) / hitRadius, 1), -1)
        scored(1, trick: nil)
        v.dy = -popSpeed
        v.dx = v.dx * 0.3 + off * 240
        sy.velocity -= 3.4
        sx.velocity += 2.4
        rot.velocity -= off * 5
        blinkAt = t
    }

    /// The finger kept going through it: the throw aims it and scores again.
    private func flick(_ velocity: CGSize) {
        let speed = hypot(velocity.width, velocity.height)
        // a quick tap has a fast but tiny wobble; a flick goes somewhere
        let travel = hypot(finger.x - touchStart.x, finger.y - touchStart.y)
        guard playing, speed > 900, travel > 24 else { return }
        v.dx = v.dx * 0.4 + velocity.width * 0.45
        v.dy = min(v.dy, velocity.height * 0.55)
        let now = hypot(v.dx, v.dy), cap: CGFloat = 3200
        if now > cap { v.dx *= cap / now; v.dy *= cap / now }
        scored(1, trick: "flick")
    }

    private func bank(_ speed: CGFloat) {
        guard playing, bankFree, speed > 420 else { return }
        bankFree = false
        scored(1, trick: "bank")
    }

    private static let milestones: Set<Int> = [10, 25, 50]

    private func scored(_ points: Int, trick: String?) {
        let before = score
        score += points
        var newBest = false
        if score > best {
            best = score
            UserDefaults.standard.set(best, forKey: Self.bestKey)
            if !celebrated, score > bestAtStart, score >= 3 { celebrated = true; newBest = true }
        }
        // 10, 25, 50, then every 50: it is getting harder, and it says so
        let milestone = (before + 1...score).contains { Self.milestones.contains($0) || ($0 > 50 && $0 % 50 == 0) }
        poke()
        if milestone {
            moment = (.excited, nil, t + 1.0)
            haptic(.heavy, 1)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) { [weak self] in self?.haptic(.rigid, 0.8) }
        } else if newBest {
            moment = (.excited, nil, t + 1.2)
            DispatchQueue.main.async { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        } else {
            if moment?.mood != .excited { moment = (.nodding, nil, t + 0.45) }
            // a little firmer as the run goes on
            let combo = min(Double(score), 25) * 0.02
            haptic(trick == nil ? .rigid : .light, trick == nil ? 0.5 + combo : 0.7)
            if trick == "flick" { haptic(.medium, 0.6 + combo) }
        }
        publishGame(.scored(score: score, points: points, trick: trick, newBest: newBest, milestone: milestone))
    }

    private func miss() {
        guard playing else { return }
        playing = false
        dropPickups()
        swatting = false
        whiffed = false
        flungAt = t
        let record = score > bestAtStart && score >= 3
        if record {
            // a new best: it lands, then bounces about it twice with a spin,
            // and the phone celebrates with it
            moment = (.excited, nil, t + 2.6)
            cheers = 2
            cheerAt = t + 0.35
            haptic(.heavy, 1)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
        } else {
            // a plain miss: one soft thud and a surprised look, nothing more
            moment = (.surprised, nil, t + 0.9)
            haptic(.soft, score > 0 ? 1 : 0.7)
            if score > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in self?.haptic(.soft, 0.45) }
            }
        }
        publishGame(.missed(score: score, newBest: record))
        score = 0
    }

#if DEBUG
    /// Juggles itself: starts a run once it has landed, then hits it on the
    /// way down near the bottom third, off-centre by a varying amount.
    private func autoplayStep() {
        guard landedAt != nil, mode != .leaving, !focused else { return }
        if !playing {
            guard mode == .home, t - flungAt > 1.5 else { return }
            v = CGVector(dx: 300, dy: -1400)
            mode = .flung
            flungAt = t
            autoplayStop = 12 + Int(roll() * 30)
            startGame()
            return
        }
        guard score < autoplayStop, v.dy > 0, p.y > stage.height * 0.62 else { return }
        let off = CGFloat(roll() - 0.5) * hitRadius * 0.9
        swat(at: CGPoint(x: p.x - off, y: p.y + 10))
        swatting = false
    }
#endif

    /// The composer took focus or a send started: the run ends without a
    /// miss, and the score gets out of the way.
    /// One hop of the new-best celebration: up, a spin, eyes shut tight for
    /// a beat, a tap of the haptic.
    private func cheer() {
        guard !reduceMotion else { cheers = 0; return }
        let first = cheers == 2
        v.dy -= first ? 640 : 460
        sy.velocity -= 4.5
        sx.velocity += 3.2
        rot.velocity += (first ? 1 : -1) * 16
        poseUntil = t + 0.45
        blinkAt = t
        haptic(first ? .rigid : .light, first ? 0.9 : 0.7)
        cheers -= 1
        cheerAt = t + 0.6
    }

    private func quitGame() {
        guard playing else { return }
        playing = false
        dropPickups()
        swatting = false
        whiffed = false
        score = 0
        flungAt = t - 0.6
        publishGame(.quit)
    }

    private func publishGame(_ event: GameEvent) {
        DispatchQueue.main.async { [weak self] in self?.onGame?(event) }
    }

    private func bump(_ speed: CGFloat, horizontal: Bool) {
        guard speed > 140 else { return }
        let squash = min(speed / 260, 9)
        if horizontal { sx.velocity -= squash; sy.velocity += squash * 0.6 } else { sy.velocity -= squash; sx.velocity += squash * 0.6 }
        if t - lastBump > 0.06 {
            lastBump = t
            haptic(.rigid, min(Double(speed) / 2200, 1))
        }
    }

    /// Where it wants to be at home: the rest spot plus whatever it is doing.
    private func homeTarget(_ home: CGPoint) -> CGPoint {
        var target = home
        switch rest {
        case .drowsy: target.y += 5
        case .asleep: target.y += 10
        case .awake: break
        }
        if moodNow == .nodding { target.y += CGFloat(sin(t * 2 * .pi * 1.1)) * 6 }
        if t < nudgeUntil { target.x -= 14 }
        if t < rattleUntil {
            target.x += CGFloat(sin(t * 61) * 7 + sin(t * 37) * 4)
            target.y += CGFloat(cos(t * 47) * 5)
        }
        if let cameoStart, !cameoLeaving, t - cameoStart > 0.5 { target.x += cameoSide * 8 }
        // never quite still: a slow sway, the body turning after the eyes,
        // and now and then a shift of weight
        let energy = self.energy
        target.x += (wave(0) * 2.6 + wave(1) * 1.3) * energy + turn.value * 6
        target.y += (wave(2) * 1.8 + wave(3) * 0.9) * energy
        if let shift, t < shift.until { target.x += shift.x }
        return target
    }

    /// How much life is in it: less as it gets drowsy, a little asleep.
    private var energy: CGFloat {
        switch rest {
        case .asleep: 0.35
        case .drowsy: 0.65
        case .awake: 1
        }
    }

    private func wave(_ i: Int) -> CGFloat {
        guard i < waves.count else { return 0 }
        return CGFloat(sin(t * waves[i].speed + waves[i].phase))
    }

    private func rotationTarget() -> CGFloat {
        if mode == .held || mode == .flung { return max(min(v.dx / 4000, 0.35), -0.35) }
        if t < rattleUntil { return CGFloat(sin(t * 53)) * 0.16 }
        if moodNow == .dizzy { return CGFloat(sin(t * 6)) * 0.12 }
        if t < poseUntil { return 0.14 }
        if t < nudgeUntil { return -0.14 }
        if let cameoStart, !cameoLeaving, t - cameoStart > 0.5 { return cameoSide * 0.08 }
        let sway = (wave(4) * 0.022 + wave(5) * 0.012) * energy + turn.value * 0.07
        if rest == .asleep { return 0.09 + sway }
        if moodNow == .nodding { return CGFloat(sin(t * 2 * .pi * 1.1)) * 0.03 + sway }
        if let glance, t < glance.until { return glance.tilt + sway }
        return sway
    }

    private func gazeTarget(_ home: CGPoint) -> CGPoint {
        if mode == .held || mode == .flung {
            let speed = max(hypot(v.dx, v.dy), 1)
            return CGPoint(x: v.dx / speed, y: v.dy / speed)
        }
        if t < nudgeUntil {
            let back = local(CGPoint(x: dock.header.minX + 44, y: dock.avatar == .zero ? dock.header.midY : dock.avatar.midY))
            let dx = back.x - p.x, dy = back.y - p.y
            let length = max(hypot(dx, dy), 1)
            return CGPoint(x: dx / length, y: dy / length)
        }
        if let cameoStart, !cameoLeaving, t - cameoStart > 0.35 { return CGPoint(x: cameoSide, y: 0.25) }
        if touching {
            // on the finger, wherever it is
            let dx = finger.x - p.x, dy = finger.y - p.y
            let length = max(hypot(dx, dy), 1)
            let reach = min(length / side, 1)
            return CGPoint(x: dx / length * reach, y: dy / length * reach)
        }
        if moodNow == .suspicious { return CGPoint(x: CGFloat(sin(t * 2.2)) * 0.9, y: 0) }
        if moodNow == .listening, dictating { return CGPoint(x: focus.x * 0.3, y: 0.15) }
        return focus
    }

    // MARK: Mood

    private var cameoSide: CGFloat { seed % 2 == 0 ? -1 : 1 }

    private var moodNow: MascotMood { mood }

    /// The slow half of a frame: mood, line, idle habits, the visitor.
    private func think() {
        // The draft, read once per frame. A big cut is suspicious.
        let text = draft.text
        if text != lastDraft {
            if EmptyMascotBrain.isHeavyDelete(from: lastDraft, to: text) { suspiciousUntil = t + 2.2 }
            lastDraft = text
            poke()
        }
        if dictating { poke() }

        if let current = moment, current.until <= t { moment = nil }

        let reaction = EmptyMascotBrain.reaction(to: text, focused: focused)
        let restNow = rest
        var next: MascotMood
        var line: EmptyMascotBrain.Moment? = .arrive(day)

        if mode == .leaving {
            next = .thinking
            line = nil
        } else if let moment {
            next = moment.mood
            line = moment.line ?? line
        } else if dictating {
            next = .listening
            line = .voice
        } else if t < suspiciousUntil {
            next = .suspicious
            line = .suspicious
        } else {
            switch reaction {
            case .scared: next = .scared; line = .scared
            case .alert: next = .alert; line = .alert
            case .happy: next = .happy; line = .thanks
            case .nodding: next = .nodding; line = .nodding
            case .listening: next = .listening; line = text.isEmpty ? .listening : .nodding
            case .none:
                switch restNow {
                case .asleep: next = .asleep; line = .asleep
                case .drowsy: next = day.late ? .late : .drowsy; line = .drowsy
                case .awake:
                    next = day.late ? .late : .idle
                    if nudged, unread > 0 { line = .unread(unread) }
                }
            }
            if reaction == .listening, text.count < 3 { line = .listening }
        }
        if let cameoStart, let cameo, !cameoLeaving, t - cameoStart > 0.6, moment == nil, reaction == .none {
            line = .cameo(cameo.name)
        }
        if next != mood {
            let before = EmptyMascotBrain.face(mood), after = EmptyMascotBrain.face(next)
            if before.accent != nil, before.accent != after.accent { oldAccent = (before, t) }
            // a small hop of feeling as the face changes
            if !reduceMotion, landedAt != nil, mode == .home { sy.velocity += 1.4; sx.velocity -= 0.9 }
            mood = next
            moodChangedAt = t
        }
        eyes.aim(EmptyMascotBrain.face(mood), at: t)

        guard landedAt != nil, mode != .birth else { return }
        if playing { line = nil }
        if mode != .leaving {
            let variant = line == .tapped ? seed &+ tapCount : seed
            publishLine(line.map { EmptyMascotBrain.line($0, seed: variant) })
        }

        // Blink on its own beat, now and then twice; asleep, the eyes are
        // already shut.
        if t >= nextBlink {
            blink()
            nextBlink = t + 1.8 + roll() * 4.4
            if roll() < 0.18 { secondBlink = t + 0.24 }
        }
        if secondBlink >= 0, t >= secondBlink {
            secondBlink = -1
            blink()
        }

        let calm = mode == .home && !touching && moment == nil && reaction == .none && !dictating && restNow == .awake && t >= suspiciousUntil
        // The eyes never rest on one spot for long.
        if t >= nextSaccade { saccade(calm: calm, text: text, rest: restNow) }
        // Every few seconds, at random, a small habit.
        if calm, !reduceMotion, t >= nextFidget {
            nextFidget = t + 4 + roll() * 7
            fidget()
        } else if !calm {
            nextFidget = max(nextFidget, t + 3 + roll() * 2)
        }
        // Something needs you back there: look at it and lean.
        if unread > 0, calm, t >= nextNudge, cameoStart == nil || cameoLeaving {
            nudgeUntil = t + 1.5
            nextNudge = t + 11
            nudged = true
            if !reduceMotion { hop(160) }
        }
        if unread == 0 { nudged = false }

        stepCameo(calm: calm)
    }

    private func stepCameo(calm: Bool) {
        guard let cameoAt, cameo != nil, !reduceMotion else { return }
        let size = side * 0.62
        let off = cameoSide < 0 ? -size * 0.7 : stage.width + size * 0.7
        let peek = cameoSide < 0 ? size * 0.16 : stage.width - size * 0.16
        if cameoStart == nil {
            guard t >= cameoAt, calm, rest == .awake else { return }
            cameoStart = t
            cameoX = Spring(off, stiffness: 120, damping: 17)
            cameoX.target = peek
            return
        }
        guard let cameoStart else { return }
        let since = t - cameoStart
        if !calm, moment != nil || touching { cameoLeaving = true }
        if since > 3.2 { cameoLeaving = true }
        if cameoLeaving { cameoX.target = off }
        // the shared look ends in a blink together
        if !cameoLeaving, since > 1.7, since < 1.72 { blinkAt = t }
        if cameoLeaving, abs(cameoX.value - off) < 2 {
            self.cameoAt = nil
            self.cameoStart = nil
            cameoLeaving = false
        }
    }

    private func blink() {
        blinkAt = t
        if !reduceMotion, mode == .home { sy.velocity -= 0.5 }
    }

    /// Where the eyes jump next, and when. Typing, they read along at the
    /// caret; with the keyboard up and nothing typed they watch the composer
    /// and check on you; left alone they mostly hold your eye, with small
    /// drifts, and now and then a proper look around with a tilt.
    private func saccade(calm: Bool, text: String, rest: MascotRest) {
        var gap = 0.5 + roll() * 1.6
        let jitter = CGPoint(x: (roll() - 0.5) * 0.16, y: (roll() - 0.5) * 0.12)
        if rest == .asleep {
            focus = .zero
            gap = 1.5
        } else if focused, !text.isEmpty {
            let column = CGFloat(text.count % 36) / 36
            focus = CGPoint(x: -0.75 + column * 1.5, y: 0.9)
            gap = 0.18 + roll() * 0.4
        } else if focused {
            focus = roll() < 0.7 ? CGPoint(x: 0, y: 0.85) : .zero
            gap = 0.6 + roll() * 1.4
        } else if calm, roll() < 0.22 {
            let spots: [(CGFloat, CGFloat)] = [(-1, 0), (1, 0), (0, -1), (-0.75, -0.6), (0.75, -0.6), (0.85, 0.5), (-0.85, 0.5)]
            let pick = spots[Int(roll() * Double(spots.count)) % spots.count]
            focus = CGPoint(x: pick.0, y: pick.1)
            glance = (t + 0.7 + roll(), pick.0, pick.1, (roll() > 0.5 ? 1 : -1) * 0.07)
            gap = 0.8 + roll() * 0.9
            // a big look often takes a blink with it
            if roll() < 0.35 { blink() }
        } else {
            focus = .zero
        }
        focus.x += jitter.x
        focus.y += jitter.y
        nextSaccade = t + gap
    }

    private func fidget() {
        switch Int(roll() * 4) {
        case 0:
            // shift its weight to one side for a moment
            shift = (t + 1.2 + roll() * 1.8, (roll() > 0.5 ? 1 : -1) * (4 + CGFloat(roll()) * 5))
        case 1:
            // crouch, then a little bounce
            sy.velocity -= 1.8
            sx.velocity += 1.3
            let speed = 110 + CGFloat(roll()) * 70
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) { [weak self] in self?.hop(speed) }
        case 2:
            // a stretch
            sy.velocity += 3
            sx.velocity -= 1.9
        default:
            blink()
            secondBlink = t + 0.22
        }
    }

    private func publishLine(_ line: String?) {
        guard line != shownLine else { return }
        shownLine = line
        DispatchQueue.main.async { [weak self] in self?.onLine?(line) }
    }

    private func publishRate() {
        let moving = mode != .home || touching || moment != nil || dictating || hypot(v.dx, v.dy) > 4
        let rate: Rate = !moving && rest == .asleep ? .sleepy : .fast
        guard rate != shownRate else { return }
        shownRate = rate
        DispatchQueue.main.async { [weak self] in self?.onRate?(rate) }
    }

    // MARK: Drawing

    private struct Paint {
        var body: Color
        var ink: Color
        var accent: Color
        var lowContrast: Bool
    }

    private var paints: [String: Paint] = [:]
    private var paintScheme: ColorScheme?

    private func palette(_ color: String, _ scheme: ColorScheme) -> Paint {
        if paintScheme != scheme { paints = [:]; paintScheme = scheme }
        if let known = paints[color] { return known }
        let colors = GlyphMark.colors(color, scheme: scheme)
        let hex = GlyphFaces.resolveColor(color)
        let made = Paint(body: colors.body, ink: colors.ink, accent: colors.accent,
                         lowContrast: GlyphFaces.contrast(hex, scheme == .dark ? "#111111" : "#FFFFFF") < 1.25)
        paints[color] = made
        return made
    }

    func draw(in context: inout GraphicsContext, scheme: ColorScheme) {
        guard started, stage.width > 0 else { return }
        let paint = palette(color, scheme)
        context.opacity = Double(max(min(opacity.value, 1), 0))
        let home = home(in: stage, origin: origin)

        // The visitor peeks in behind.
        if let cameo, let cameoStart {
            let size = side * 0.62
            let since = t - cameoStart
            let blink: CGFloat = since > 1.7 && since < 1.84 ? 0.1 : 1
            let idle = EmptyMascotBrain.face(.idle)
            drawBody(in: &context, centre: CGPoint(x: cameoX.value, y: home.y + side * 0.42), side: size,
                     sx: 1, sy: 1, rotation: -cameoSide * 0.24, shear: 0, color: cameo.color, bodyId: cameo.mascotBody,
                     face: idle, left: idle.left, right: idle.right, open: blink,
                     gaze: CGPoint(x: -cameoSide, y: 0.2), lead: .zero, changedAt: -10, scheme: scheme)
        }

        for k in pickups { drawPickup(k, in: &context, paint: paint) }

        // The taffy neck back up to the island while it is being born.
        if neck.value > 0.02, released {
            let top = CGPoint(x: island.midX, y: island.maxY + pill.value * 8 - 6)
            let bodyTop = p.y - side * 0.4 * sy.value * scale.value
            let bottom = CGPoint(x: p.x, y: top.y + max(bodyTop - top.y, 0) * min(neck.value, 1))
            if bottom.y > top.y {
                let topWidth = side * 0.26 * neck.value
                let bottomWidth = side * 0.4 * neck.value * scale.value
                let waist = side * 0.06 * neck.value
                let mid = CGPoint(x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2)
                var path = Path()
                path.move(to: CGPoint(x: top.x - topWidth / 2, y: top.y))
                path.addQuadCurve(to: CGPoint(x: bottom.x - bottomWidth / 2, y: bottom.y), control: CGPoint(x: mid.x - waist, y: mid.y))
                path.addLine(to: CGPoint(x: bottom.x + bottomWidth / 2, y: bottom.y))
                path.addQuadCurve(to: CGPoint(x: top.x + topWidth / 2, y: top.y), control: CGPoint(x: mid.x + waist, y: mid.y))
                path.closeSubpath()
                context.fill(path, with: .color(paint.body))
            }
        }

        if let old = oldAccent, t - old.at < 0.2 {
            drawAccent(in: &context, centre: p, side: side * scale.value, sx: sx.value, sy: sy.value, rotation: rot.value,
                       face: old.face, grow: CGFloat(1 - (t - old.at) / 0.2), color: color, scheme: scheme)
        }
        drawBody(in: &context, centre: p, side: side * scale.value, sx: sx.value, sy: sy.value, rotation: rot.value,
                 shear: shear.value, color: color, bodyId: bodyId, face: EmptyMascotBrain.face(mood),
                 left: eyes.left, right: eyes.right, open: min(eyeOpenness, eyeSquash),
                 gaze: CGPoint(x: gazeX.value, y: gazeY.value),
                 lead: CGPoint(x: leadX.value, y: leadY.value), changedAt: moodChangedAt, scheme: scheme)
        // a caught heart rides along until it saves a miss
        if saves > 0, playing {
            drawGlyph("heart", at: CGPoint(x: p.x + side * 0.46, y: p.y - side * 0.5), box: 22,
                      rotation: sin(t * 2 * .pi / 1.4) * 0.15, opacity: 1, in: &context, paint: paint)
        }

        // The island swells to let it out, then closes behind it.
        if pill.value > 0.01, mode == .birth || mode == .home {
            let w = island.width + 34 * pill.value
            let h = island.height + 18 * pill.value
            let rect = CGRect(x: island.midX - w / 2, y: island.minY, width: w, height: h)
            var pillContext = context
            if !hasIsland { pillContext.opacity *= Double(min(pill.value * 3, 1)) }
            pillContext.fill(Path(roundedRect: rect, cornerRadius: h / 2, style: .continuous), with: .color(.black))
            if mode == .birth { peekEyes(in: &pillContext, pill: rect, paint: paint) }
        }
    }

    private func drawPickup(_ k: Pickup, in context: inout GraphicsContext, paint: Paint) {
        let bob = CGFloat(sin((t - k.born) * 2 * .pi / 1.6 + k.phase)) * 4
        let spin: Double = switch k.kind {
        case .star: (t - k.born) * 0.9
        case .spark: (t - k.born) * 3
        case .heart: sin((t - k.born) * 2 * .pi / 1.2) * 0.12
        }
        let fade = k.taken.map { max(0, 1 - (t - $0) / 0.3) } ?? 1
        // the last second of its life it blinks, so a miss is fair
        let left = k.life - (t - k.born)
        let blink = k.taken == nil && left < 1 && left > 0 && Int(left * 8) % 2 == 0 ? 0.35 : 1
        drawGlyph(k.kind.glyph, at: CGPoint(x: k.p.x, y: k.p.y + bob), box: (k.kind == .spark ? 30 : 34) * k.size.value,
                  rotation: spin, opacity: fade * blink, in: &context, paint: paint)
    }

    /// One flat glyph in the accent colour, the way the face accents are drawn.
    private func drawGlyph(_ glyph: String, at centre: CGPoint, box: CGFloat, rotation: Double, opacity: Double,
                           in context: inout GraphicsContext, paint: Paint) {
        let scale = box / GlyphFaces.viewBox
        guard scale > 0.01, opacity > 0.01 else { return }
        var c = context
        c.opacity *= opacity
        c.translateBy(x: centre.x, y: centre.y)
        c.rotate(by: .radians(rotation))
        c.translateBy(x: -box / 2, y: -box / 2)
        c.scaleBy(x: scale, y: scale)
        c.stroke(Path(EmptyMascotBrain.path(glyph)), with: .color(paint.accent),
                 style: StrokeStyle(lineWidth: max(GlyphFaces.stroke, 2.6 / scale), lineCap: .round, lineJoin: .round))
    }

    /// How long the eyes look around in the island before the body drops.
    static let peekLength: TimeInterval = 0.7

    /// The bot's eyes, awake in the island: they open, glance left, right,
    /// blink, then look down at you, and close up as the body lets go.
    private func peekEyes(in context: inout GraphicsContext, pill: CGRect, paint: Paint) {
        let appear = smooth((t - 0.08) / 0.12)
        let vanish = smooth((t - Self.peekLength) / 0.08)
        let alpha = appear * (1 - vanish)
        guard alpha > 0.01 else { return }
        // where they look: left, right, then down at you
        let lookX = CGFloat(-smooth((t - 0.18) / 0.1) + 2 * smooth((t - 0.32) / 0.12) - smooth((t - 0.5) / 0.1))
        let lookY = CGFloat(smooth((t - 0.5) / 0.1))
        let blink: CGFloat = t > 0.44 && t < 0.52 ? 0.12 : 1
        let eyeSide = pill.height * 0.5
        let scale = eyeSide / GlyphFaces.viewBox
        let ink = GlyphFaces.contrast(GlyphFaces.resolveColor(color), "#000000") >= 2 ? paint.body : Color.white
        for (glyph, x) in [(eyes.left, -pill.height * 0.42), (eyes.right, pill.height * 0.42)] {
            var eye = context
            eye.opacity *= alpha
            eye.translateBy(x: pill.midX + x + lookX * pill.width * 0.1, y: pill.midY + lookY * pill.height * 0.12)
            eye.rotate(by: .degrees(GlyphFaces.tiltDegrees))
            eye.scaleBy(x: scale, y: scale * blink * (0.6 + 0.4 * CGFloat(appear)))
            eye.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            eye.stroke(Path(EmptyMascotBrain.path(glyph)), with: .color(ink),
                       style: StrokeStyle(lineWidth: max(GlyphFaces.stroke, 1.4 / scale), lineCap: .round, lineJoin: .round))
        }
    }

    private func smooth(_ x: Double) -> Double {
        let k = min(max(x, 0), 1)
        return k * k * (3 - 2 * k)
    }

    /// 1 open ... 0.1 shut: a fast squash and a slower open, 0.15s in all.
    private var eyeOpenness: CGFloat {
        guard blinkAt >= 0 else { return 1 }
        let phase = (t - blinkAt) / 0.15
        guard phase >= 0, phase < 1 else { return 1 }
        let open = phase < 0.4 ? 1 - phase / 0.4 : (phase - 0.4) / 0.6
        return max(0.1, CGFloat(open))
    }

    /// The body flat in its colour, the header's glyph eyes on it. The face
    /// slides across the body to look, and the rim clips it, so a look to
    /// the side reads as the whole round body turning.
    private func drawBody(in context: inout GraphicsContext, centre: CGPoint, side: CGFloat, sx: CGFloat, sy: CGFloat,
                          rotation: CGFloat, shear: CGFloat, color: String, bodyId: String?, face: MascotMoodFace,
                          left: String, right: String, open: CGFloat, gaze: CGPoint, lead: CGPoint,
                          changedAt: TimeInterval, scheme: ColorScheme) {
        guard side > 1 else { return }
        let paint = palette(color, scheme)
        let layout = GlyphFaces.layout
        let outline = FlatMascotBodies.outline(bodyId)
        let bounds = outline.boundingBoxOfPath
        let k = side / 100

        var c = context
        c.translateBy(x: centre.x, y: centre.y)
        c.rotate(by: .radians(rotation))
        c.scaleBy(x: max(sx, 0.2), y: max(sy, 0.2))
        // The top lags behind a move: a shear about the base.
        if abs(shear) > 0.0005 {
            let base = bounds.height * k / 2
            c.translateBy(x: 0, y: base)
            c.concatenate(CGAffineTransform(a: 1, b: 0, c: shear, d: 1, tx: 0, ty: 0))
            c.translateBy(x: 0, y: -base)
        }

        let shape = Path(outline).applying(CGAffineTransform(translationX: -bounds.midX, y: -bounds.midY)
            .concatenating(CGAffineTransform(scaleX: k, y: k)))
        c.fill(shape, with: .color(paint.body))
        if paint.lowContrast {
            c.stroke(shape, with: .color(paint.ink.opacity(0.22)), lineWidth: max(1, side / 52))
        }

        let diameter = min(bounds.width, bounds.height) * k
        let mass = GlyphMark.massCentre[FlatMascotBodies.body(bodyId).id] ?? CGPoint(x: bounds.midX, y: bounds.midY)
        // The eyes lead: gaze and the direction of travel both carry the face.
        let look = CGPoint(x: (gaze.x * 0.2 + lead.x * 0.06) * diameter, y: (gaze.y * 0.15 + lead.y * 0.06) * diameter)
        var eyes = c
        eyes.clip(to: shape)
        eyes.translateBy(x: (mass.x - bounds.midX) * k + look.x, y: (mass.y - bounds.midY) * k + look.y)
        eyes.rotate(by: .degrees(GlyphFaces.tiltDegrees))
        let eyeSide = layout.eyeBox * diameter
        let eyeScale = eyeSide / GlyphFaces.viewBox
        guard eyeScale > 0.01 else { return }
        let eyeStroke = max(GlyphFaces.stroke, layout.minStrokePx / eyeScale)
        // Turned aside, the pair closes up a little on the round body.
        let spread = 1 - 0.12 * min(abs(gaze.x), 1)
        for (glyph, x) in [(left, -layout.eyeX), (right, layout.eyeX)] {
            var eye = eyes
            eye.translateBy(x: x * spread * diameter, y: layout.eyeY * diameter)
            eye.scaleBy(x: eyeScale, y: eyeScale * max(open, 0.1))
            eye.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            eye.stroke(Path(EmptyMascotBrain.path(glyph)), with: .color(paint.ink),
                       style: StrokeStyle(lineWidth: eyeStroke, lineCap: .round, lineJoin: .round))
        }

        let sinceChange = t - changedAt
        let grow = sinceChange < 0.26 ? CGFloat(Self.easeOutBack(sinceChange / 0.26)) : 1
        drawAccent(in: &c, face: face, grow: grow, diameter: diameter, paint: paint)
    }

    /// The old accent shrinking away while the new one pops in.
    private func drawAccent(in context: inout GraphicsContext, centre: CGPoint, side: CGFloat, sx: CGFloat, sy: CGFloat,
                            rotation: CGFloat, face: MascotMoodFace, grow: CGFloat, color: String, scheme: ColorScheme) {
        let paint = palette(color, scheme)
        let outline = FlatMascotBodies.outline(bodyId)
        let bounds = outline.boundingBoxOfPath
        let k = side / 100
        var c = context
        c.translateBy(x: centre.x, y: centre.y)
        c.rotate(by: .radians(rotation))
        c.scaleBy(x: max(sx, 0.2), y: max(sy, 0.2))
        drawAccent(in: &c, face: face, grow: grow, diameter: min(bounds.width, bounds.height) * k, paint: paint)
    }

    private func drawAccent(in c: inout GraphicsContext, face: MascotMoodFace, grow: CGFloat, diameter: CGFloat, paint: Paint) {
        let layout = GlyphFaces.layout
        guard let accent = face.accent, let anchor = face.anchor, let place = GlyphFaces.placement(anchor) else { return }
        var boxSide = place.box * diameter * grow
        var lift2: CGFloat = anchor == .split ? 0 : CGFloat(sin(t * 2 * .pi / 1.8)) * 0.025 * diameter
        var alpha = 1.0
        if accent == "zz" {
            // the z's drift up and fade, over and over
            let phase = CGFloat((t * 0.45).truncatingRemainder(dividingBy: 1))
            lift2 = -phase * 0.22 * diameter
            alpha = Double(1 - phase * phase)
            boxSide *= 0.8 + phase * 0.3
        }
        let boxScale = boxSide / GlyphFaces.viewBox
        guard boxScale > 0.01 else { return }
        var mark = c
        mark.opacity *= alpha
        mark.translateBy(x: place.x * diameter, y: place.y * diameter + lift2)
        if accent == "star" { mark.rotate(by: .radians(t * 3)) }
        mark.translateBy(x: -boxSide / 2, y: -boxSide / 2)
        mark.scaleBy(x: boxScale, y: boxScale)
        mark.stroke(Path(EmptyMascotBrain.path(accent)), with: .color(paint.accent),
                    style: StrokeStyle(lineWidth: max(place.stroke, layout.minStrokePx / boxScale), lineCap: .round, lineJoin: .round))
    }

    private static func easeOutBack(_ t: Double) -> Double {
        let c = 1.7, u = min(max(t, 0), 1) - 1
        return 1 + (c + 1) * u * u * u + c * u * u
    }

    // MARK: Bits

    private func roll() -> Double {
        rng = rng &* 6364136223846793005 &+ 1442695040888963407
        return Double(rng >> 11) / Double(1 << 53)
    }

    private func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle, _ intensity: Double) {
        DispatchQueue.main.async {
            let generator = Self.impact(style)
            generator.impactOccurred(intensity: CGFloat(intensity))
            // a fresh generator spins up the engine on the hit itself; a
            // prepared one fires on the frame
            generator.prepare()
        }
    }

    @MainActor private static var impacts: [UIImpactFeedbackGenerator.FeedbackStyle: UIImpactFeedbackGenerator] = [:]

    @MainActor private static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator {
        if let generator = impacts[style] { return generator }
        let generator = UIImpactFeedbackGenerator(style: style)
        impacts[style] = generator
        return generator
    }

    private static func prepareHaptics() {
        DispatchQueue.main.async {
            for style in [UIImpactFeedbackGenerator.FeedbackStyle.rigid, .light, .medium, .heavy, .soft] {
                impact(style).prepare()
            }
        }
    }
}

// MARK: - Keepy-uppy score

/// The score board's state. The creature sends events; this turns them into
/// what the number does: pop on a hit, a ring at a milestone, and at the end
/// of a run a score moment in the middle of the scene: the final number lands
/// big with the best under it, or a burst for a new best, then goes.
@MainActor @Observable final class MascotGameBoard {
    /// A finished run, on screen until it times out or is tapped away.
    struct Ending: Equatable {
        let id: Int
        let score: Int
        let best: Int
        let newBest: Bool
    }

    private(set) var shown = false
    private(set) var score = 0
    private(set) var best = 0
    private(set) var newBest = false
    private(set) var pops = 0
    private(set) var bigPop = false
    private(set) var milestones = 0
    private(set) var flash = false
    private(set) var trick: (text: String, id: Int)?
    private(set) var ending: Ending?
    @ObservationIgnored private var endings = 0
    @ObservationIgnored private var hold: Task<Void, Never>?
    @ObservationIgnored private var trickClear: Task<Void, Never>?
    @ObservationIgnored private var flashClear: Task<Void, Never>?

    func apply(_ event: MascotCreature.GameEvent) {
        switch event {
        case .start(let best):
            // a new throw clears the last run's moment straight away
            hold?.cancel()
            if ending != nil { withAnimation(.smooth(duration: 0.2)) { ending = nil } }
            self.best = best
            score = 0
            newBest = false
            flash = false
            trick = nil
            shown = true
        case let .scored(score, points, trick, isBest, milestone):
            guard shown else { return }
            withAnimation(.snappy(duration: 0.22)) { self.score = score }
            if score > best { best = score }
            bigPop = isBest || milestone
            if isBest { withAnimation(.spring(duration: 0.4, bounce: 0.3)) { newBest = true } }
            pops += 1
            if milestone { mark() }
            if let trick { show("+\(points) \(trick)") }
        case .note(let text):
            guard shown else { return }
            show(text)
        case let .missed(final, record):
            guard shown else { return }
            hold?.cancel()
            let best = max(best, final)
            withAnimation(.smooth(duration: 0.2)) {
                shown = false
                trick = nil
            }
            // a toss that never got a hit is not a run: no moment for it
            guard final > 0 else { return }
            endings += 1
            ending = Ending(id: endings, score: final, best: best, newBest: record)
            let id = endings
            hold = Task { [weak self] in
                // long enough to enjoy it, short enough not to be in the way
                try? await Task.sleep(for: .milliseconds(record ? 2500 : 2000))
                guard let self, !Task.isCancelled, self.ending?.id == id else { return }
                withAnimation(.smooth(duration: 0.45)) { self.ending = nil }
            }
        case .quit:
            hide()
        }
    }

    /// A tap on the moment: it goes now.
    func skip() {
        hold?.cancel()
        withAnimation(.smooth(duration: 0.3)) { ending = nil }
    }

    func hide() {
        hold?.cancel()
        withAnimation(.smooth(duration: 0.25)) {
            shown = false
            ending = nil
        }
        trick = nil
    }

    /// A milestone: the number takes the bot's colour for a beat and a ring
    /// leaves it.
    private func mark() {
        milestones += 1
        withAnimation(.easeOut(duration: 0.12)) { flash = true }
        flashClear?.cancel()
        flashClear = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(650))
            guard let self, !Task.isCancelled else { return }
            withAnimation(.smooth(duration: 0.5)) { self.flash = false }
        }
    }

    private func show(_ text: String) {
        withAnimation(.spring(duration: 0.3, bounce: 0.25)) { trick = (text, pops) }
        let id = pops
        trickClear?.cancel()
        trickClear = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(900))
            guard let self, !Task.isCancelled, self.trick?.id == id else { return }
            withAnimation(.smooth(duration: 0.3)) { self.trick = nil }
        }
    }
}

/// The score during a run: a big rounded number in the scene under the
/// header, the best small and quiet beneath it, and the trick that scored,
/// briefly, in the bot's colour. Drawn behind the mascot, so it flies over it.
private struct MascotScore: View {
    let board: MascotGameBoard
    let tint: Color
    let reduceMotion: Bool

    var body: some View {
        VStack(spacing: 0) {
            number
            Group {
                if board.newBest {
                    Text("new best")
                        .foregroundStyle(tint)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                } else if board.best > 0 {
                    Text("best \(board.best)")
                        .foregroundStyle(.tertiary)
                        .contentTransition(.numericText(value: Double(board.best)))
                }
            }
            .font(.system(size: 13, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .frame(height: 20)
            ZStack {
                if let trick = board.trick {
                    Text(trick.text)
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundStyle(tint)
                        .id(trick.id)
                        .transition(.asymmetric(insertion: .scale(scale: 0.5).combined(with: .opacity),
                                                removal: .opacity.combined(with: .offset(y: -8))))
                }
            }
            .frame(height: 22)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("score \(board.score), best \(board.best)")
    }

    @ViewBuilder private var number: some View {
        let text = Text("\(board.score)")
            .font(.system(size: 64, weight: .bold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(board.flash ? AnyShapeStyle(tint) : AnyShapeStyle(.primary))
            .contentTransition(.numericText(value: Double(board.score)))
        if reduceMotion {
            text
        } else {
            let big = board.bigPop
            text
                .background { ring }
                .keyframeAnimator(initialValue: CGFloat(1), trigger: board.pops) { content, scale in
                    content.scaleEffect(scale)
                } keyframes: { _ in
                    SpringKeyframe(big ? 1.4 : 1.14, duration: big ? 0.12 : 0.07, spring: .snappy)
                    SpringKeyframe(1, duration: big ? 0.6 : 0.36, spring: .bouncy)
                }
        }
    }

    /// The milestone ring: leaves the number and fades.
    private var ring: some View {
        Circle()
            .stroke(tint, lineWidth: 3)
            .frame(width: 70, height: 70)
            // at rest k is 1: fully out and invisible
            .keyframeAnimator(initialValue: CGFloat(1), trigger: board.milestones) { content, k in
                content.scaleEffect(0.7 + k * 1.3).opacity(Double(1 - k) * 0.7)
            } keyframes: { _ in
                MoveKeyframe(0)
                LinearKeyframe(1, duration: 0.7, timingCurve: .easeOut)
            }
    }
}

/// The end of a run, in the middle of the scene. A plain miss: the number
/// drops in and lands with a thud, the best quiet under it. A new best: the
/// number springs up from nothing in the bot's colour, a burst of flat dots
/// and two rings leave it, and "new best" pops in under it. Tap to skip.
private struct MascotEndCard: View {
    let ending: MascotGameBoard.Ending
    let tint: Color
    let reduceMotion: Bool
    let skip: () -> Void
    @State private var landed = false
    @State private var label = false
    @State private var burst = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                if ending.newBest, !reduceMotion { MascotBurst(tint: tint, out: burst) }
                Text("\(ending.score)")
                    .font(.system(size: ending.newBest ? 116 : 100, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(ending.newBest ? AnyShapeStyle(tint) : AnyShapeStyle(.primary))
                    .scaleEffect(landed ? 1 : ending.newBest ? 0.2 : 1.3)
                    .offset(y: landed || ending.newBest ? 0 : -36)
                    .opacity(landed ? 1 : 0)
            }
            Group {
                if ending.newBest {
                    Text("new best")
                        .font(.system(size: 26, weight: .heavy, design: .rounded))
                        .foregroundStyle(tint)
                } else {
                    Text("best \(ending.best)")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                }
            }
            .monospacedDigit()
            .scaleEffect(label ? 1 : 0.5)
            .opacity(label ? 1 : 0)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: skip)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ending.newBest ? "new best, \(ending.score)" : "final score \(ending.score), best \(ending.best)")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Tap to dismiss")
        .onAppear {
            guard !reduceMotion else { landed = true; label = true; return }
            if ending.newBest {
                withAnimation(.spring(duration: 0.6, bounce: 0.55)) { landed = true }
                withAnimation(.easeOut(duration: 0.95).delay(0.06)) { burst = true }
                withAnimation(.spring(duration: 0.5, bounce: 0.5).delay(0.22)) { label = true }
            } else {
                // a thud: falls a little, lands, barely bounces
                withAnimation(.spring(duration: 0.38, bounce: 0.28)) { landed = true }
                withAnimation(.smooth(duration: 0.35).delay(0.2)) { label = true }
            }
        }
    }
}

/// The new-best burst: flat dots and dashes thrown out in a ring, and two
/// rings expanding, all in the bot's colour, gone in under a second.
private struct MascotBurst: View {
    let tint: Color
    let out: Bool
    private static let count = 14

    var body: some View {
        ZStack {
            ForEach(0..<2, id: \.self) { i in
                Circle()
                    .stroke(tint, lineWidth: i == 0 ? 4 : 2.5)
                    .frame(width: 96, height: 96)
                    .scaleEffect(out ? (i == 0 ? 2.6 : 3.4) : 0.5)
                    .opacity(out ? 0 : 0.8)
            }
            ForEach(0..<Self.count, id: \.self) { i in
                let angle = Double(i) / Double(Self.count) * 2 * .pi + (i.isMultiple(of: 2) ? 0 : 0.18)
                let far: CGFloat = i.isMultiple(of: 2) ? 150 : 115
                Capsule()
                    .fill(tint.opacity(i.isMultiple(of: 3) ? 0.55 : 1))
                    .frame(width: i.isMultiple(of: 2) ? 16 : 10, height: i.isMultiple(of: 2) ? 7 : 10)
                    .rotationEffect(.radians(angle))
                    .offset(x: CGFloat(cos(angle)) * (out ? far : 40), y: CGFloat(sin(angle)) * (out ? far : 40))
                    .scaleEffect(out ? 0.5 : 1)
                    .opacity(out ? 0 : 1)
            }
        }
        .allowsHitTesting(false)
    }
}
