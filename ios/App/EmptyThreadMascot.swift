// The empty thread's mascot: the bot itself, alive in the middle of a fresh
// thread, with one line under it in its own voice.
//
// Calm when left alone, wild when touched. It squeezes out of the dynamic
// island and drops into place; it breathes, blinks, glances around, gets
// drowsy and falls asleep; it reacts to the draft as it is typed, pulses with
// the mic, can be flung off the walls, petted (it purrs), shaken (it gets
// dizzy) and screenshotted (it poses). On the first send it turns to thinking
// and gets sucked up into the header's face, where the turn's own animation
// takes over.
//
// Everything that moves is a spring stepped once per frame on a plain
// object — no SwiftUI state per frame, so the transcript never re-renders for
// it. The timeline runs at 120hz only while something is moving, drops to
// 30hz at rest and 15hz asleep, and stops with the app in the background.
// The view is gone entirely the moment the thread has a message in it.
//
// What a mood looks like and what the mascot says is `EmptyMascotBrain` in
// CompanionCore, where it is tested.
import CompanionCore
import CoreHaptics
import SwiftUI
import UIKit

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
        .onDisappear { creature?.stopPurr() }
    }

    private func live(_ creature: MascotCreature, stage: CGSize) -> some View {
        let home = creature.home(in: stage, origin: origin)
        return TimelineView(.animation(minimumInterval: rate.interval, paused: scenePhase != .active)) { timeline in
            let frame = creature.step(to: timeline.date, stage: stage, origin: origin)
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in creature.draw(in: &context, scheme: scheme) }
                    .allowsHitTesting(false)
                Color.clear
                    .frame(width: frame.hit, height: frame.hit)
                    .contentShape(Circle())
                    .position(frame.centre)
                    .gesture(
                        DragGesture(minimumDistance: 0, coordinateSpace: .named("mascot-stage"))
                            .onChanged { value in creature.touch(at: value.location, from: value.startLocation) }
                            .onEnded { value in creature.release(velocity: value.velocity) }
                    )
                    .allowsHitTesting(frame.touchable)
                    .accessibilityElement()
                    .accessibilityLabel(bot.name)
                    .accessibilityHint("Tap to say hi")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { creature.tap() }
            }
            .coordinateSpace(.named("mascot-stage"))
        }
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
        .animation(.spring(duration: 0.45, bounce: 0.2), value: line)
        .animation(.spring(duration: 0.5, bounce: 0.15), value: home.y)
    }

    private func arrive() {
        creature?.stopPurr()
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
        fresh.onGone = { [weak fresh] in
            guard let fresh, creature === fresh else { return }
            creature = nil
        }
        line = nil
        rate = .fast
        creature = fresh
    }
}

// MARK: - The creature

final class MascotCreature {
    enum Rate: Equatable {
        case fast, calm, sleepy
        var interval: Double {
            switch self {
            case .fast: 1.0 / 120
            case .calm: 1.0 / 30
            case .sleepy: 1.0 / 15
            }
        }
    }

    struct Frame {
        var centre: CGPoint
        var hit: CGFloat
        var touchable: Bool
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

    private enum Mode { case birth, home, held, flung, leaving }

    // Who it is.
    let color: String
    let bodyId: String?
    let name: String
    let side: CGFloat = 112
    private let seed: Int
    private let day: MascotDayMood
    private let reduceMotion: Bool
    private let cameo: Bot?
    private let draft: ComposerDraft
    private let dock: MascotDock

    // What the host tells it.
    var focused = false { didSet { if focused != oldValue { poke() } } }
    var dictating = false { didSet { if dictating != oldValue { poke() } } }
    var unread = 0

    var onRate: ((Rate) -> Void)?
    var onLine: ((String?) -> Void)?
    var onGone: (() -> Void)?

    // Stage, in the overlay's own space (its top is the screen's top).
    private var stage: CGSize = .zero
    private var origin: CGPoint = .zero
    private var island: CGRect = .zero
    private var hasIsland = false

    // Time, in seconds since it arrived. Paused frames do not count.
    private var t: TimeInterval = 0
    private var last: Date?
    private var rng: UInt64

    // Body.
    private var mode: Mode
    private var p = CGPoint.zero
    private var v = CGVector.zero
    private var sx = Spring(1, stiffness: 300, damping: 10)
    private var sy = Spring(1, stiffness: 300, damping: 10)
    private var rot = Spring(0, stiffness: 150, damping: 11)
    private var scale = Spring(1, stiffness: 240, damping: 22)
    private var gazeX = Spring(0, stiffness: 140, damping: 18)
    private var gazeY = Spring(0, stiffness: 140, damping: 18)
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
    private var petting = false
    private var touchStart: TimeInterval = 0
    private var finger = CGPoint.zero
    private var grab = CGVector.zero
    private var flungAt: TimeInterval = 0
    private var wiggleUntil: TimeInterval = 0
    private var lastBump: TimeInterval = -1
    private var tapCount = 0
    private let purr = MascotPurr()

    // Life.
    private var lastPoke: TimeInterval = 0
    private var lastDraft = ""
    private var nextBlink: TimeInterval = 1.2
    private var blinkAt: TimeInterval = -1
    private var nextGlance: TimeInterval = 6
    private var glance: (until: TimeInterval, x: CGFloat, y: CGFloat, tilt: CGFloat)?
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
        // Rarely: about one empty thread in three gets a visitor, once.
        if cameo != nil, seed % 3 == 0 { cameoAt = 14 + Double(seed % 11) }
#if DEBUG
        if cameo != nil, args.contains("-mascot-cameo-now") { cameoAt = 2.6 }
#endif
        if reduceMotion { opacity = Spring(0, stiffness: 60, damping: 16); opacity.target = 1 }
    }

    deinit { purr.stop() }

    // MARK: Geometry

    /// Where it rests: centred, a little above the middle of the space
    /// between the header and the composer.
    func home(in stage: CGSize, origin: CGPoint) -> CGPoint {
        let top = max(dock.header.maxY - origin.y, 0)
        let floor = max(stage.height, top + side * 2)
        return CGPoint(x: stage.width / 2, y: top + (floor - top) * 0.42)
    }

    private var topWall: CGFloat { max(dock.header.maxY - origin.y, 0) }

    private func local(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x - origin.x, y: point.y - origin.y) }

    private func measureIsland() {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        let width = window?.bounds.width ?? stage.width
        let safeTop = window?.safeAreaInsets.top ?? 0
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
            touchStart = t
            grab = CGVector(dx: p.x - start.x, dy: p.y - start.y)
            if rest == .asleep { wake() }
            poke()
        }
        finger = location
        if !moved, !reduceMotion, hypot(location.x - start.x, location.y - start.y) > 10 {
            moved = true
            if petting { petting = false; purr.stop() }
            mode = .held
        }
    }

    func release(velocity: CGSize) {
        guard touching else { return }
        touching = false
        poke()
        if moved {
            let speed = hypot(velocity.width, velocity.height)
            let cap: CGFloat = 3600
            let k = speed > cap ? cap / speed : 1
            v = CGVector(dx: velocity.width * k, dy: velocity.height * k)
            mode = .flung
            flungAt = t
        } else if petting {
            petting = false
            purr.stop()
            // a happy wiggle
            wiggleUntil = t + 0.9
            rot.velocity += (roll() > 0.5 ? 1 : -1) * 7
            sx.velocity += 2.5
            moment = (.happy, .purr, t + 1.3)
            haptic(.soft, 0.7)
        } else {
            tap()
        }
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
        guard mode == .home || mode == .flung, landedAt != nil else { return }
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
        mode = .leaving
        leftAt = t
        touching = false
        petting = false
        purr.stop()
        moment = nil
        cameoLeaving = true
        publishLine(nil)
        // a beat of anticipation, then up it goes
        sy.velocity -= 2.5
        sx.velocity += 2
    }

    func stopPurr() { purr.stop() }

    // MARK: Step

    private var rest: MascotRest {
        if focused || dictating || touching || !lastDraft.isEmpty || mode != .home { return .awake }
        return EmptyMascotBrain.rest(idleFor: t - lastPoke)
    }

    func step(to now: Date, stage newStage: CGSize, origin newOrigin: CGPoint) -> Frame {
        let firstFrame = last == nil
        let elapsed = last.map { now.timeIntervalSince($0) } ?? 0
        last = now
        stage = newStage
        origin = newOrigin
        if firstFrame { start() }
        let dt = min(max(elapsed, 0), 1.0 / 15)
        if dt > 0 {
            let steps = max(1, Int((dt * 240).rounded(.up)))
            let h = dt / Double(steps)
            for _ in 0..<steps { advance(CGFloat(h)) }
            t += dt
        }
        think()
        publishRate()
        let hit = side * 0.92 * scale.value
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
        nextGlance = EmptyMascotBrain.nextGlance(after: 2, unit: roll())
    }

    /// One physics substep.
    private func advance(_ dt: CGFloat) {
        let home = home(in: stage, origin: origin)
        let r = side * 0.46 * scale.value

        switch mode {
        case .birth:
            if !released, t > 0.45 {
                released = true
                scale.target = 1
                v = CGVector(dx: 0, dy: 300)
                neck.target = 1
            }
            if released {
                springTo(home, stiffness: 70, damping: 7.5, dt: dt)
                let below = p.y - island.maxY
                if !snapped, below > side * 1.2 || t > 0.97 {
                    snapped = true
                    neck.target = 0
                    pill.target = 0
                    // snap back into shape
                    sx.velocity += 5
                    sy.velocity -= 4
                    haptic(.light, 0.6)
                }
                if snapped, landedAt == nil, v.dy < 0, p.y > home.y - 4 {
                    land()
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
            if petting {
                // lean into the finger
                let pull = CGVector(dx: (finger.x - p.x) * 0.1, dy: (finger.y - p.y) * 0.06)
                p.x += pull.dx * dt * 8
                p.y += pull.dy * dt * 8
            }
        case .held:
            let target = CGPoint(x: finger.x + grab.dx, y: finger.y + grab.dy)
            springTo(target, stiffness: 900, damping: 48, dt: dt)
        case .flung:
            v.dy += 700 * dt
            let drag = exp(-0.8 * dt)
            v.dx *= drag
            v.dy *= drag
            p.x += v.dx * dt
            p.y += v.dy * dt
            collide(radius: r)
            let speed = hypot(v.dx, v.dy)
            if (t - flungAt > 1.0 && speed < 260) || t - flungAt > 2.2 { mode = .home }
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
        var stretchY = 1 + min(speedY / 1700, 0.55) - min(speedX / 3600, 0.18)
        var stretchX = 1 + min(speedX / 1700, 0.55) - min(speedY / 3600, 0.18)
        if mode == .birth, !snapped { stretchY += neck.value * 0.3; stretchX -= neck.value * 0.12 }
        if mode == .home, !reduceMotion {
            let r = rest
            let period: Double = r == .asleep ? 5.2 : r == .drowsy ? 4.4 : 3.4
            let depth: CGFloat = r == .asleep ? 0.04 : 0.024
            let breath = CGFloat(sin(t * 2 * .pi / period))
            stretchY += breath * depth
            stretchX -= breath * depth * 0.6
            if petting { stretchY -= 0.05 + CGFloat(sin(t * 2 * .pi * 9)) * 0.012; stretchX += 0.04 }
            if dictating {
                stretchY += voice.value * 0.16 + CGFloat(sin(t * 2 * .pi * 6)) * voice.value * 0.03
                stretchX += voice.value * 0.12
            }
        }
        if mode == .leaving, let leftAt, t - leftAt < 0.08 { stretchY = 0.86; stretchX = 1.1 }
        sx.target = stretchX
        sy.target = stretchY
        voice.target = dictating ? CGFloat(MicLevel.current) : 0

        rot.damping = t < wiggleUntil ? 3.5 : 11
        rot.target = reduceMotion ? 0 : rotationTarget()
        let gaze = reduceMotion ? CGPoint.zero : gazeTarget(home)
        gazeX.target = gaze.x
        gazeY.target = gaze.y
        let poseScale: CGFloat = t < poseUntil ? 1.08 : 1
        if mode == .home || mode == .held || mode == .flung { scale.target = poseScale }

        sx.step(dt); sy.step(dt); rot.step(dt); scale.step(dt)
        gazeX.step(dt); gazeY.step(dt); opacity.step(dt); voice.step(dt)
        neck.step(dt); pill.step(dt)
        if cameoStart != nil { cameoX.step(dt) }
    }

    private func springTo(_ target: CGPoint, stiffness: CGFloat, damping: CGFloat, dt: CGFloat) {
        v.dx += (-stiffness * (p.x - target.x) - damping * v.dx) * dt
        v.dy += (-stiffness * (p.y - target.y) - damping * v.dy) * dt
        p.x += v.dx * dt
        p.y += v.dy * dt
    }

    private func land() {
        landedAt = t
        mode = .home
        sy.velocity -= 4.5
        sx.velocity += 3.5
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
        if p.x < r { p.x = r; if v.dx < 0 { bump(-v.dx, horizontal: true); v.dx = -v.dx * 0.62 } }
        if p.x > stage.width - r { p.x = stage.width - r; if v.dx > 0 { bump(v.dx, horizontal: true); v.dx = -v.dx * 0.62 } }
        if p.y < top {
            p.y = top
            if v.dy < 0 {
                let speed = -v.dy
                bump(speed, horizontal: false)
                v.dy = -v.dy * 0.6
                if speed > 850 {
                    // a hard bonk on the ceiling
                    moment = (.dizzy, .dizzy, t + 2.6)
                    rot.velocity += (v.dx >= 0 ? 1 : -1) * 6
                    haptic(.heavy, 1)
                }
            }
        }
        if p.y > bottom { p.y = bottom; if v.dy > 0 { bump(v.dy, horizontal: false); v.dy = -v.dy * 0.55 } }
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
        return target
    }

    private func rotationTarget() -> CGFloat {
        if mode == .held || mode == .flung { return max(min(v.dx / 4000, 0.35), -0.35) }
        if petting { return max(min((finger.x - p.x) / side * 0.4, 0.3), -0.3) }
        if t < rattleUntil { return CGFloat(sin(t * 53)) * 0.16 }
        if moodNow == .dizzy { return CGFloat(sin(t * 6)) * 0.12 }
        if t < poseUntil { return 0.14 }
        if t < nudgeUntil { return -0.14 }
        if let cameoStart, !cameoLeaving, t - cameoStart > 0.5 { return cameoSide * 0.08 }
        if rest == .asleep { return 0.09 }
        if moodNow == .nodding { return CGFloat(sin(t * 2 * .pi * 1.1)) * 0.03 }
        if let glance, t < glance.until { return glance.tilt }
        return 0
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
        switch moodNow {
        case .suspicious: return CGPoint(x: CGFloat(sin(t * 2.2)) * 0.9, y: 0)
        case .listening where !dictating: return CGPoint(x: 0, y: 0.9)
        case .nodding: return CGPoint(x: 0, y: 0.7)
        default: break
        }
        if let glance, t < glance.until { return CGPoint(x: glance.x, y: glance.y) }
        return .zero
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

        // A finger resting on it is petting: it purrs.
        if touching, !moved, !petting, !reduceMotion, mode == .home, t - touchStart > 0.42 {
            petting = true
            moment = nil
            purr.start()
            haptic(.soft, 0.5)
        }

        if let current = moment, current.until <= t { moment = nil }

        let reaction = EmptyMascotBrain.reaction(to: text, focused: focused)
        let restNow = rest
        var next: MascotMood
        var line: EmptyMascotBrain.Moment? = .arrive(day)

        if mode == .leaving {
            next = .thinking
            line = nil
        } else if petting {
            next = .purr
            line = .purr
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
            mood = next
            moodChangedAt = t
        }

        guard landedAt != nil, mode != .birth else { return }
        if mode != .leaving {
            let variant = line == .tapped ? seed &+ tapCount : seed
            publishLine(line.map { EmptyMascotBrain.line($0, seed: variant) })
        }

        // Blink on its own beat; asleep, the eyes are already shut.
        if t >= nextBlink {
            blinkAt = t
            nextBlink = t + 2.6 + roll() * 3
        }

        let calm = mode == .home && !touching && moment == nil && reaction == .none && !dictating && restNow == .awake && t >= suspiciousUntil
        // A glance or a head tilt every five to eight seconds.
        if t >= nextGlance {
            nextGlance = EmptyMascotBrain.nextGlance(after: t, unit: roll())
            if calm {
                let choices: [(CGFloat, CGFloat)] = [(-1, 0), (1, 0), (0, -1), (-0.7, -0.6), (0.7, -0.6), (0.8, 0.5)]
                let pick = choices[Int(roll() * Double(choices.count)) % choices.count]
                glance = (t + 1.3, pick.0, pick.1, (roll() > 0.5 ? 1 : -1) * 0.07)
            }
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

    private func publishLine(_ line: String?) {
        guard line != shownLine else { return }
        shownLine = line
        DispatchQueue.main.async { [weak self] in self?.onLine?(line) }
    }

    private func publishRate() {
        let moving = mode != .home || touching || moment != nil || dictating || t < (glance?.until ?? 0) + 0.4
            || t < nudgeUntil + 0.4 || cameoStart != nil || mood == .nodding || mood == .suspicious
            || !sx.resting || !sy.resting || !rot.resting || !opacity.resting || hypot(v.dx, v.dy) > 4
            || t - (landedAt ?? t) < 1.5 || t < poseUntil + 0.5
        let rate: Rate = moving ? .fast : (rest == .awake ? .calm : .sleepy)
        guard rate != shownRate else { return }
        shownRate = rate
        DispatchQueue.main.async { [weak self] in self?.onRate?(rate) }
    }

    // MARK: Drawing

    func draw(in context: inout GraphicsContext, scheme: ColorScheme) {
        guard stage.width > 0 else { return }
        let paint = GlyphMark.colors(color, scheme: scheme)
        context.opacity = Double(max(min(opacity.value, 1), 0))

        // The visitor peeks in behind.
        if let cameo, let cameoStart {
            let size = side * 0.62
            let home = home(in: stage, origin: origin)
            let since = t - cameoStart
            let blink = since > 1.7 && since < 1.84 ? 0.1 : 1.0
            drawBody(in: &context, centre: CGPoint(x: cameoX.value, y: home.y + side * 0.42), side: size,
                     sx: 1, sy: 1, rotation: -cameoSide * 0.24, color: cameo.color, bodyId: cameo.mascotBody,
                     face: EmptyMascotBrain.face(.idle), open: blink, gaze: CGPoint(x: -cameoSide, y: 0.2),
                     changedAt: -10, scheme: scheme)
        }

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

        let open = eyeOpenness
        drawBody(in: &context, centre: p, side: side * scale.value, sx: sx.value, sy: sy.value, rotation: rot.value,
                 color: color, bodyId: bodyId, face: EmptyMascotBrain.face(mood), open: open,
                 gaze: CGPoint(x: gazeX.value, y: gazeY.value), changedAt: moodChangedAt, scheme: scheme)

        // The island swells to let it out, then closes behind it.
        if pill.value > 0.01, mode == .birth || mode == .home {
            let w = island.width + 34 * pill.value
            let h = island.height + 18 * pill.value
            let rect = CGRect(x: island.midX - w / 2, y: island.minY, width: w, height: h)
            var pillContext = context
            if !hasIsland { pillContext.opacity *= Double(min(pill.value * 3, 1)) }
            pillContext.fill(Path(roundedRect: rect, cornerRadius: h / 2, style: .continuous), with: .color(.black))
        }
    }

    private var eyeOpenness: CGFloat {
        guard blinkAt >= 0 else { return 1 }
        let phase = (t - blinkAt) / 0.14
        guard phase >= 0, phase < 1 else { return 1 }
        return max(0.08, abs(1 - 2 * CGFloat(phase)))
    }

    private func drawBody(in context: inout GraphicsContext, centre: CGPoint, side: CGFloat, sx: CGFloat, sy: CGFloat,
                          rotation: CGFloat, color: String, bodyId: String?, face: MascotMoodFace, open: CGFloat,
                          gaze: CGPoint, changedAt: TimeInterval, scheme: ColorScheme) {
        guard side > 1 else { return }
        let paint = GlyphMark.colors(color, scheme: scheme)
        let layout = GlyphFaces.layout
        let outline = FlatMascotBodies.outline(bodyId)
        let bounds = outline.boundingBoxOfPath
        let k = side / 100

        var c = context
        c.translateBy(x: centre.x, y: centre.y)
        c.rotate(by: .radians(rotation))
        c.scaleBy(x: max(sx, 0.2), y: max(sy, 0.2))

        var body = c
        body.scaleBy(x: k, y: k)
        body.translateBy(x: -bounds.midX, y: -bounds.midY)
        body.fill(Path(outline), with: .color(paint.body))
        if GlyphFaces.contrast(GlyphFaces.resolveColor(color), scheme == .dark ? "#111111" : "#FFFFFF") < 1.25 {
            body.stroke(Path(outline), with: .color(paint.ink.opacity(0.22)), lineWidth: max(1, side / 52) / k)
        }

        let diameter = min(bounds.width, bounds.height) * k
        let mass = GlyphMark.massCentre[FlatMascotBodies.body(bodyId).id] ?? CGPoint(x: bounds.midX, y: bounds.midY)
        let look = CGPoint(x: gaze.x * 0.07 * diameter, y: gaze.y * 0.06 * diameter)
        let faceCentre = CGPoint(x: (mass.x - bounds.midX) * k + look.x, y: (mass.y - bounds.midY) * k + look.y)

        let sinceChange = t - changedAt
        let squash = sinceChange < 0.12 ? max(0.15, abs(1 - 2 * CGFloat(sinceChange / 0.12))) : 1
        let eyeSide = layout.eyeBox * diameter
        let eyeScale = eyeSide / GlyphFaces.viewBox
        let stroke = max(GlyphFaces.stroke, layout.minStrokePx / eyeScale)
        let style = StrokeStyle(lineWidth: stroke, lineCap: .round, lineJoin: .round)
        var eyes = c
        eyes.translateBy(x: faceCentre.x, y: faceCentre.y)
        eyes.rotate(by: .degrees(GlyphFaces.tiltDegrees))
        let lift: CGFloat = face.mouth == nil ? 0 : -0.06
        for (glyph, x) in [(face.left, -layout.eyeX), (face.right, layout.eyeX)] {
            var eye = eyes
            eye.translateBy(x: x * diameter, y: (layout.eyeY + lift) * diameter)
            eye.scaleBy(x: eyeScale, y: eyeScale * squash * open)
            eye.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            eye.stroke(Path(EmptyMascotBrain.path(glyph)), with: .color(paint.ink), style: style)
        }
        if let mouth = face.mouth {
            let box = (mouth == "yawn" ? 0.3 : 0.24) * diameter
            let scale = box / GlyphFaces.viewBox
            var m = eyes
            m.translateBy(x: 0, y: 0.27 * diameter)
            m.scaleBy(x: scale, y: scale * squash)
            m.translateBy(x: -GlyphFaces.viewBox / 2, y: -GlyphFaces.viewBox / 2)
            m.stroke(Path(EmptyMascotBrain.path(mouth)), with: .color(paint.ink),
                     style: StrokeStyle(lineWidth: max(GlyphFaces.stroke, layout.minStrokePx / scale), lineCap: .round, lineJoin: .round))
        }

        guard let accent = face.accent, let anchor = face.anchor, let place = GlyphFaces.placement(anchor) else { return }
        let pop = sinceChange < 0.22 ? Self.easeOutBack(sinceChange / 0.22) : 1
        var boxSide = place.box * diameter * CGFloat(pop)
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
        guard boxScale > 0 else { return }
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
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.impactOccurred(intensity: CGFloat(intensity))
        }
    }
}

// MARK: - Purr

/// A low continuous rumble that swells and settles like breathing, for as
/// long as the mascot is being petted.
final class MascotPurr {
    private var engine: CHHapticEngine?
    private var player: CHHapticAdvancedPatternPlayer?

    func start() {
        guard player == nil, CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            let engine = try engine ?? CHHapticEngine()
            self.engine = engine
            engine.isAutoShutdownEnabled = true
            try engine.start()
            let duration: TimeInterval = 30
            let rumble = CHHapticEvent(eventType: .hapticContinuous, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.5),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.06),
            ], relativeTime: 0, duration: duration)
            // a curve holds at most 16 points, so the swell is laid out in runs
            var curves: [CHHapticParameterCurve] = []
            var start: TimeInterval = 0
            while start < duration {
                let points = (0..<15).map { i in
                    CHHapticParameterCurve.ControlPoint(relativeTime: Double(i) * 0.45, value: i % 2 == 0 ? 0.35 : 0.85)
                }
                curves.append(CHHapticParameterCurve(parameterID: .hapticIntensityControl, controlPoints: points, relativeTime: start))
                start += 15 * 0.45
            }
            let pattern = try CHHapticPattern(events: [rumble], parameterCurves: curves)
            let player = try engine.makeAdvancedPlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
            self.player = player
        } catch {
            player = nil
        }
    }

    func stop() {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
    }
}
