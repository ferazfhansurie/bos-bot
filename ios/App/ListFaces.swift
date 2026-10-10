// The chat list's faces, alive while they sit there.
//
// One director drives every row: a single loop that, every half second or
// so, picks one idle face on screen and gives it something small to do — a
// blink, a glance, a breath, a look at whichever bot is working. One event on
// one row at a time, so no two faces ever move in sync and the list never
// redraws as a whole. Each row reads only its own `ListFacePose`; nothing
// ticks per frame unless a spring or keyframe is actually playing, and the
// loop stops when the list is off screen or the app is in the background.
//
// The rule from the 1.9.4 plan: calm when left alone, wild when touched.
// Reduce motion keeps the blinks and fades, never the hops or glances.
import CompanionCore
import CoreHaptics
import SwiftUI
import UIKit

/// What one row's face is doing right now.
@MainActor @Observable final class ListFacePose {
    /// Eye glyphs instead of the state's own; nil is the state's face.
    var left: String?
    var right: String?
    var accent: String?
    /// In body diameters, before the face's tilt.
    var gaze: CGSize = .zero
    /// 1 open, ~0.1 shut.
    var squash: CGFloat = 1
    /// Slumped with its eyes shut, before the launch greeting wakes it.
    var asleep = false
    /// Counters: bumping one plays that motion once.
    var hop = 0
    var nod = 0
    var stretch = 0
    var wave = 0
    /// Size of the next hop, so a breath and an arrival can share a motion.
    fileprivate(set) var hopHeight: CGFloat = 1

    var look: GlyphLook {
        GlyphLook(left: left, right: right, accent: accent, anchor: accent == nil ? nil : .topRight,
                  hidesAccent: left != nil, eyeShift: gaze, eyeSquash: squash)
    }
}

@MainActor @Observable final class ListFaceDirector {

    @ObservationIgnored private var poses: [String: ListFacePose] = [:]
    @ObservationIgnored private var onScreen = Set<String>()
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var workers = Set<String>()
    @ObservationIgnored private var lastEvent: [String: Date] = [:]
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var listVisible = false
    @ObservationIgnored private var sceneActive = true
    @ObservationIgnored var reduceMotion = false
    /// True from launch until the first greeting runs: faces built before it
    /// are born asleep so the greeting has something to wake.
    @ObservationIgnored private var greetingPending = true
    @ObservationIgnored private var greeting: Task<Void, Never>?
    @ObservationIgnored private var lastHaptic = Date.distantPast
    /// When the app last went to the background, and when it came back:
    /// bots that finished in between look proud until they are opened.
    @ObservationIgnored private(set) var awayAt: Double
    @ObservationIgnored private(set) var returnedAt: Double

    private static let awayKey = "bos.listFaces.awayAt"

    init() {
        awayAt = UserDefaults.standard.double(forKey: Self.awayKey)
        returnedAt = Date().timeIntervalSince1970 * 1000
    }

    func pose(_ id: String) -> ListFacePose {
        if let pose = poses[id] { return pose }
        let pose = ListFacePose()
        if greetingPending { sleep(pose) }
        poses[id] = pose
        return pose
    }

    // MARK: - What is on screen

    func appear(_ id: String) {
        onScreen.insert(id)
        if greetingPending && greeting == nil { scheduleGreeting() }
    }

    func disappear(_ id: String) { onScreen.remove(id) }

    func setOrder(_ ids: [String]) { order = ids }
    func setWorkers(_ ids: Set<String>) { workers = ids }

    func setListVisible(_ visible: Bool) {
        listVisible = visible
        updateLoop()
    }

    func setScene(_ phase: ScenePhase) {
        let active = phase == .active
        guard active != sceneActive else { return }
        sceneActive = active
        let now = Date().timeIntervalSince1970 * 1000
        if active {
            returnedAt = now
            // back after a long while: the faces dozed off, wake them again
            if awayAt > 0, now - awayAt > 10 * 60 * 1000 {
                greetingPending = true
                for id in onScreen { if let pose = poses[id] { sleep(pose) } }
                scheduleGreeting()
            }
        } else if phase == .background {
            awayAt = now
            UserDefaults.standard.set(now, forKey: Self.awayKey)
        }
        updateLoop()
    }

    /// A bot that finished while the app was closed, not yet opened.
    func isProud(_ chat: Chat, lastActivity: Double) -> Bool {
        awayAt > 0 && chat.isBot && chat.unread && !chat.busy && lastActivity > awayAt && lastActivity <= returnedAt + 5000
    }

    private func updateLoop() {
        if listVisible && sceneActive {
            guard loop == nil else { return }
            loop = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(Int.random(in: 420...1000)))
                    guard !Task.isCancelled, let self else { return }
                    self.tick()
                }
            }
        } else {
            loop?.cancel()
            loop = nil
        }
    }

    // MARK: - Idle life

    private func tick() {
        guard !greetingPending else { return }
        let now = Date()
        let idle = onScreen.filter { id in
            !workers.contains(id) && now.timeIntervalSince(lastEvent[id] ?? .distantPast) > 3.4 && poses[id] != nil
        }
        guard let id = idle.randomElement(), let pose = poses[id] else { return }
        lastEvent[id] = now
        if reduceMotion { blink(pose); return }
        let hour = Calendar.current.component(.hour, from: now)
        let lateNight = hour >= 23 || hour < 5
        let roll = Double.random(in: 0..<1)
        if let target = nearestWorker(to: id), roll < 0.5 {
            notice(pose, below: target > (order.firstIndex(of: id) ?? 0))
        } else if roll < 0.38 {
            blink(pose)
        } else if roll < 0.62 {
            glance(pose)
        } else if roll < 0.86 {
            breathe(pose)
        } else if lateNight {
            doze(pose)
        } else {
            peek(pose)
        }
    }

    /// The index of the working bot closest to this row, in list order.
    private func nearestWorker(to id: String) -> Int? {
        guard !workers.isEmpty, let mine = order.firstIndex(of: id) else { return nil }
        return order.enumerated().filter { workers.contains($0.element) }
            .min { abs($0.offset - mine) < abs($1.offset - mine) }?.offset
    }

    func blink(_ pose: ListFacePose) {
        let open = pose.squash
        withAnimation(.easeIn(duration: 0.07)) { pose.squash = 0.12 }
        after(0.1) { withAnimation(.easeOut(duration: 0.13)) { pose.squash = open } }
    }

    private func glance(_ pose: ListFacePose) {
        let side: CGFloat = Bool.random() ? 1 : -1
        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
            pose.gaze = CGSize(width: 0.07 * side, height: CGFloat.random(in: -0.04...0.02))
        }
        after(Double.random(in: 0.9...1.6)) {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.75)) { pose.gaze = .zero }
        }
    }

    /// Eyes open wide toward the bot that's working, then back to resting.
    private func notice(_ pose: ListFacePose, below: Bool) {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.65)) {
            pose.left = "ring"; pose.right = "ring"
            pose.gaze = CGSize(width: 0.02, height: below ? 0.06 : -0.07)
        }
        after(1.4) {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.8)) {
                pose.left = nil; pose.right = nil; pose.gaze = .zero
            }
        }
    }

    private func breathe(_ pose: ListFacePose) { pose.nod += 1 }

    /// A curious look around: eyes open, a little hop, settle.
    private func peek(_ pose: ListFacePose) {
        pose.left = "ring"; pose.right = "ring"
        hop(pose, height: 0.45)
        after(0.8) { pose.left = nil; pose.right = nil }
    }

    /// After midnight a face nods off for a moment.
    private func doze(_ pose: ListFacePose) {
        withAnimation(.easeInOut(duration: 0.8)) { pose.squash = 0.35; pose.gaze = CGSize(width: 0, height: 0.04) }
        after(2.2) { withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) { pose.squash = 1; pose.gaze = .zero } }
    }

    private func hop(_ pose: ListFacePose, height: CGFloat) {
        pose.hopHeight = height
        pose.hop += 1
    }

    // MARK: - Events

    /// A bot's message landed: its face hops once and the phone taps that
    /// bot's own pattern. Off screen there is nothing to see, so only the tap.
    func arrived(_ id: String, botID: String) {
        guard sceneActive else { return }
        if let pose = poses[id], onScreen.contains(id) {
            lastEvent[id] = Date()
            if reduceMotion { blink(pose) } else {
                hop(pose, height: 1)
                pose.left = "ring"; pose.right = "ring"
                after(0.9) { pose.left = nil; pose.right = nil }
            }
        }
        let now = Date()
        guard now.timeIntervalSince(lastHaptic) > 1.2 else { return }
        lastHaptic = now
        BotHaptics.shared.play(botID: botID)
    }

    /// The row is about to fold away as done: happy shut eyes and a wave.
    func farewell(_ id: String) {
        let pose = pose(id)
        lastEvent[id] = Date().addingTimeInterval(5)
        withAnimation(.spring(response: 0.25, dampingFraction: 0.7)) {
            pose.left = "caret"; pose.right = "caret"; pose.gaze = .zero
        }
        if !reduceMotion { pose.wave += 1 }
        after(1.3) {
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { pose.left = nil; pose.right = nil }
        }
    }

    // MARK: - Greeting

    private func sleep(_ pose: ListFacePose) {
        pose.asleep = true
        pose.left = "dash"; pose.right = "dash"
        pose.squash = 0.55
        pose.gaze = CGSize(width: 0, height: 0.05)
    }

    private func scheduleGreeting() {
        greeting?.cancel()
        greeting = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled, let self else { return }
            self.greet()
        }
    }

    /// Faces wake one after another, top to bottom. Morning yawns, late
    /// night only half wakes, otherwise a small hop and eyes wide.
    private func greet() {
        greetingPending = false
        greeting = nil
        let hour = Calendar.current.component(.hour, from: Date())
        let morning = (5..<11).contains(hour)
        let lateNight = hour >= 23 || hour < 5
        let ids = onScreen.sorted { (order.firstIndex(of: $0) ?? .max) < (order.firstIndex(of: $1) ?? .max) }
        // anything built but not on screen just wakes quietly
        for (id, pose) in poses where !onScreen.contains(id) && pose.asleep { wakeQuietly(pose) }
        for (index, id) in ids.enumerated() {
            guard let pose = poses[id] else { continue }
            lastEvent[id] = Date().addingTimeInterval(2)
            after(Double(index) * 0.13) { [weak self] in
                guard let self else { return }
                if self.reduceMotion { withAnimation(.easeOut(duration: 0.4)) { self.wakeQuietly(pose) }; return }
                if morning {
                    pose.stretch += 1
                    self.after(0.7) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.6)) {
                            pose.asleep = false; pose.left = "ring"; pose.right = "ring"; pose.squash = 1; pose.gaze = .zero
                        }
                        self.after(0.6) { withAnimation(.easeOut(duration: 0.25)) { pose.left = nil; pose.right = nil } }
                    }
                } else if lateNight {
                    withAnimation(.easeInOut(duration: 0.7)) {
                        pose.asleep = false; pose.left = "ring"; pose.right = "ring"; pose.squash = 0.5
                    }
                    self.after(1.1) {
                        withAnimation(.easeInOut(duration: 0.6)) {
                            pose.left = nil; pose.right = nil; pose.squash = 0.7; pose.gaze = CGSize(width: 0, height: 0.03)
                        }
                    }
                } else {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.55)) {
                        pose.asleep = false; pose.left = "ring"; pose.right = "ring"; pose.squash = 1; pose.gaze = .zero
                    }
                    self.hop(pose, height: 0.7)
                    self.after(0.55) { withAnimation(.easeOut(duration: 0.25)) { pose.left = nil; pose.right = nil } }
                }
            }
        }
    }

    private func wakeQuietly(_ pose: ListFacePose) {
        pose.asleep = false; pose.left = nil; pose.right = nil; pose.squash = 1; pose.gaze = .zero
    }

    private func after(_ seconds: Double, _ work: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            work()
        }
    }
}

private struct ListFaceDirectorKey: EnvironmentKey {
    static var defaultValue: ListFaceDirector? { nil }
}

extension EnvironmentValues {
    var listFaces: ListFaceDirector? {
        get { self[ListFaceDirectorKey.self] }
        set { self[ListFaceDirectorKey.self] = newValue }
    }
}

// MARK: - The face

/// An idle bot's face in the list, posed by the director. Only a bot that
/// draws as its mascot gets eyes that move; a photo just moves as a whole.
struct ListFace: View {
    let bot: Bot
    let size: CGFloat
    var state: MausState = .idle
    let pose: ListFacePose
    var proud = false

    @EnvironmentObject private var session: Session
    @Environment(\.colorScheme) private var scheme
    @State private var finishing = false

    static func drawsMascot(_ bot: Bot) -> Bool {
        (bot.avatarCrop ?? .mascot) == .mascot || bot.avatarUrl == nil
    }

    private var completedTurnID: String? { session.mascotCompletionIDs[bot.threadId] }

    var body: some View {
        var look = pose.look
        // a turn that just finished plays its finish beat, like everywhere else
        if finishing, look.left == nil { look = GlyphLook(left: "gt", right: "lt", accent: "spark", anchor: .split, eyeShift: look.eyeShift, eyeSquash: look.eyeSquash) }
        else if proud, look.left == nil { look = GlyphLook(left: "gt", right: "lt", accent: "spark", anchor: .topRight, eyeShift: look.eyeShift, eyeSquash: look.eyeSquash) }
        return PosedGlyphFace(color: bot.color, bodyId: bot.mascotBody, eyeStyle: MascotEyeStyle(stored: bot.mascotEyes),
                              state: state.glyphState, look: look, scheme: scheme, size: size,
                              gazeX: look.eyeShift.width, gazeY: look.eyeShift.height, squash: look.eyeSquash)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
            .task(id: completedTurnID) {
                guard completedTurnID != nil else { return }
                finishing = true
                try? await Task.sleep(for: .seconds(2.4))
                if !Task.isCancelled { finishing = false }
            }
    }
}

/// The still glyph face with its glance and blink as animatable numbers, so
/// a spring between two poses draws only the frames it needs.
private struct PosedGlyphFace: View, Animatable {
    let color: String
    let bodyId: String?
    let eyeStyle: MascotEyeStyle
    let state: GlyphFaceState
    let look: GlyphLook
    let scheme: ColorScheme
    let size: CGFloat
    var gazeX: CGFloat
    var gazeY: CGFloat
    var squash: CGFloat

    var animatableData: AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(gazeX, AnimatablePair(gazeY, squash)) }
        set { gazeX = newValue.first; gazeY = newValue.second.first; squash = newValue.second.second }
    }

    var body: some View {
        var look = look
        look.eyeShift = CGSize(width: gazeX, height: gazeY)
        look.eyeSquash = max(0.08, squash)
        let color = color, bodyId = bodyId, state = state, scheme = scheme, eyeStyle = eyeStyle
        let gx = gazeX, gy = gazeY, open = squash
        return Canvas { context, canvas in
            let slot = CGRect(x: canvas.width / 4, y: canvas.height / 4, width: canvas.width / 2, height: canvas.height / 2)
            if eyeStyle == .glyph {
                GlyphMark.draw(in: &context, slot: slot, color: color, bodyId: bodyId, state: state,
                               scheme: scheme, look: look)
            } else {
                // the classic eye shapes: the same body, eyes that open and look
                let body = FlatMascotBodies.body(bodyId)
                context.translateBy(x: slot.minX, y: slot.minY)
                context.scaleBy(x: slot.width / 100, y: slot.height / 100)
                context.fill(Path(FlatMascotBodies.outline(bodyId)), with: .color(MausPalette.color(color)))
                context.translateBy(x: body.faceX * 0.5 + gx * 100, y: body.faceY + gy * 100)
                let closed = look.left == "caret" || look.left == "gt"
                for path in eyeStyle.paths(openness: Double(closed ? 0.3 : open)) {
                    context.fill(Path(path), with: .color(Color(hex: "#151515")))
                }
            }
        }
        .frame(width: size * 2, height: size * 2)
        .frame(width: size, height: size)
    }
}

/// The whole-body motions any row avatar can wear: the hop, the breath, the
/// morning stretch, the farewell wave and the slump while asleep.
struct ListFaceMotion: ViewModifier {
    let pose: ListFacePose?

    func body(content: Content) -> some View {
        if let pose { content.modifier(Posed(pose: pose)) } else { content }
    }

    private struct Posed: ViewModifier {
        let pose: ListFacePose
        func body(content: Content) -> some View {
            let height = pose.hopHeight
            content
                .scaleEffect(x: pose.asleep ? 1.04 : 1, y: pose.asleep ? 0.93 : 1, anchor: .bottom)
                .animation(.spring(response: 0.4, dampingFraction: 0.6), value: pose.asleep)
                .keyframeAnimator(initialValue: Bounce(), trigger: pose.hop) { view, b in
                    view.scaleEffect(x: b.sx, y: b.sy, anchor: .bottom).offset(y: b.y)
                } keyframes: { _ in
                    KeyframeTrack(\.y) {
                        CubicKeyframe(0, duration: 0.08)
                        SpringKeyframe(-9 * height, duration: 0.18, spring: .snappy)
                        CubicKeyframe(0, duration: 0.16)
                        SpringKeyframe(0, duration: 0.3, spring: .bouncy)
                    }
                    KeyframeTrack(\.sy) {
                        CubicKeyframe(1 - 0.12 * height, duration: 0.08)
                        CubicKeyframe(1 + 0.08 * height, duration: 0.18)
                        CubicKeyframe(1, duration: 0.12)
                        CubicKeyframe(1 - 0.1 * height, duration: 0.06)
                        SpringKeyframe(1, duration: 0.3, spring: .bouncy)
                    }
                    KeyframeTrack(\.sx) {
                        CubicKeyframe(1 + 0.1 * height, duration: 0.08)
                        CubicKeyframe(1 - 0.05 * height, duration: 0.18)
                        CubicKeyframe(1, duration: 0.12)
                        CubicKeyframe(1 + 0.08 * height, duration: 0.06)
                        SpringKeyframe(1, duration: 0.3, spring: .bouncy)
                    }
                }
                .keyframeAnimator(initialValue: Bounce(), trigger: pose.nod) { view, b in
                    view.scaleEffect(x: b.sx, y: b.sy, anchor: .bottom)
                } keyframes: { _ in
                    KeyframeTrack(\.sy) {
                        CubicKeyframe(1.045, duration: 0.9)
                        CubicKeyframe(1, duration: 1.1)
                    }
                    KeyframeTrack(\.sx) {
                        CubicKeyframe(0.98, duration: 0.9)
                        CubicKeyframe(1, duration: 1.1)
                    }
                }
                .keyframeAnimator(initialValue: Bounce(), trigger: pose.stretch) { view, b in
                    view.scaleEffect(x: b.sx, y: b.sy, anchor: .bottom).rotationEffect(.degrees(b.tilt), anchor: .bottom)
                } keyframes: { _ in
                    KeyframeTrack(\.sy) {
                        CubicKeyframe(1.2, duration: 0.45)
                        CubicKeyframe(1.18, duration: 0.25)
                        SpringKeyframe(1, duration: 0.45, spring: .bouncy)
                    }
                    KeyframeTrack(\.sx) {
                        CubicKeyframe(0.88, duration: 0.45)
                        CubicKeyframe(0.9, duration: 0.25)
                        SpringKeyframe(1, duration: 0.45, spring: .bouncy)
                    }
                    KeyframeTrack(\.tilt) {
                        CubicKeyframe(-5, duration: 0.35)
                        CubicKeyframe(4, duration: 0.35)
                        SpringKeyframe(0, duration: 0.45)
                    }
                }
                .keyframeAnimator(initialValue: Bounce(), trigger: pose.wave) { view, b in
                    view.rotationEffect(.degrees(b.tilt), anchor: .bottom).scaleEffect(b.sy).opacity(b.fade)
                } keyframes: { _ in
                    KeyframeTrack(\.tilt) {
                        CubicKeyframe(-14, duration: 0.12)
                        CubicKeyframe(12, duration: 0.14)
                        CubicKeyframe(-9, duration: 0.13)
                        CubicKeyframe(6, duration: 0.12)
                        CubicKeyframe(0, duration: 0.12)
                    }
                    KeyframeTrack(\.sy) {
                        CubicKeyframe(1.06, duration: 0.3)
                        CubicKeyframe(1, duration: 0.33)
                        CubicKeyframe(0.7, duration: 0.22)
                        SpringKeyframe(1, duration: 0.45, spring: .bouncy)
                    }
                    KeyframeTrack(\.fade) {
                        LinearKeyframe(1, duration: 0.63)
                        LinearKeyframe(0.35, duration: 0.22)
                        LinearKeyframe(1, duration: 0.35)
                    }
                }
        }
    }

    private struct Bounce {
        var y: CGFloat = 0
        var sx: CGFloat = 1
        var sy: CGFloat = 1
        var tilt: Double = 0
        var fade: Double = 1
    }
}

/// A roster avatar the director can pose: an idle mascot gets the moving
/// face, anything else (a photo, a room, a bot at work with its own live
/// face) keeps its usual avatar and only moves as a whole.
struct LiveChatAvatar: View {
    let chat: Chat
    let size: CGFloat
    var state: MausState = .idle
    var animated = false
    /// The row's last activity, for the proud look.
    var at: Double = 0
    @Environment(\.listFaces) private var director

    var body: some View {
        if let director, case let .bot(bot) = chat {
            let pose = director.pose(chat.id)
            Group {
                if !state.showsActivity && ListFace.drawsMascot(bot) {
                    ListFace(bot: bot, size: size, state: state, pose: pose,
                             proud: director.isProud(chat, lastActivity: at))
                } else {
                    ChatAvatarView(chat: chat, size: size, state: state, animated: animated)
                }
            }
            .modifier(ListFaceMotion(pose: pose))
            .onAppear { director.appear(chat.id) }
            .onDisappear { director.disappear(chat.id) }
        } else {
            ChatAvatarView(chat: chat, size: size, state: state, animated: animated)
        }
    }
}

// MARK: - Haptics

/// Every bot taps its own pattern when its message lands, derived from its
/// id so it is the same on every launch and every phone: how many taps, how
/// far apart, how hard and how crisp. Falls back to one soft tap where Core
/// Haptics is not available.
@MainActor final class BotHaptics {
    static let shared = BotHaptics()
    private var engine: CHHapticEngine?

    struct Signature: Equatable {
        let taps: Int
        let gap: Double
        let intensity: Float
        let sharpness: Float
        let rising: Bool
    }

    /// FNV-1a, stable across launches (Swift's own hash is not).
    static func signature(for botID: String) -> Signature {
        var h: UInt64 = 0xcbf29ce484222325
        for byte in botID.utf8 { h = (h ^ UInt64(byte)) &* 0x100000001b3 }
        return Signature(taps: 1 + Int(h % 3), gap: 0.07 + Double((h >> 8) % 5) * 0.025,
                         intensity: 0.4 + Float((h >> 16) % 4) * 0.1, sharpness: 0.15 + Float((h >> 24) % 5) * 0.15,
                         rising: (h >> 32) % 2 == 0)
    }

    func play(botID: String) {
        let sig = Self.signature(for: botID)
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            Haptics.impact(.soft)
            return
        }
        do {
            if engine == nil {
                let made = try CHHapticEngine()
                made.isAutoShutdownEnabled = true
                made.resetHandler = { [weak self] in Task { @MainActor in self?.engine = nil } }
                engine = made
            }
            guard let engine else { return }
            try engine.start()
            let events = (0..<sig.taps).map { i -> CHHapticEvent in
                let step = sig.taps > 1 ? Float(i) / Float(sig.taps - 1) : 0
                let level = sig.rising ? sig.intensity * (0.7 + 0.3 * step) : sig.intensity * (1 - 0.3 * step)
                return CHHapticEvent(eventType: .hapticTransient, parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: level),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: sig.sharpness),
                ], relativeTime: Double(i) * sig.gap)
            }
            let player = try engine.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            Haptics.impact(.soft)
        }
    }
}
