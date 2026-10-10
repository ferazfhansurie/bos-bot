// The moment a thread is marked done.
//
// Every done action plays the same beat, wherever it starts: the chat list
// swipe and menu, the thread's own menu, the thread manager swipe and menu.
//
// - A swipe builds tension: a ring in the bot's colour fills as the row
//   follows the finger, and at the point where letting go marks it done the
//   ring snaps into a solid disc with one firm tick. Back off and it lets go.
// - On release the check pops on with a squash and draws itself, a ring and
//   a few sparks burst out of it in the bot's colour, the bot squints happily
//   and hops, and the phone taps once, timed to the check landing.
// - Several in a row climb a little: a bigger burst, a higher hop, one more
//   rising tap. The streak resets after a few quiet seconds.
// - A small glass pill offers undo for the last one.
//
// All of it is a few springs and keyframes on one row; nothing ticks per
// frame unless it is playing. Reduce motion keeps the taps, the check and
// plain fades.
import CompanionCore
import CoreHaptics
import SwiftUI
import UIKit

/// The done beat, shared so the thread screen can mark done, go back, and the
/// list plays it on the bot's row.
@MainActor @Observable final class DoneMoments {
    static let shared = DoneMoments()

    /// Chat ids whose row shows the check right now, with the streak level
    /// it plays at.
    private(set) var showing: [String: Int] = [:]
    /// The last thread marked done, while it can still be taken back.
    private(set) var undo: Undo?

    struct Undo: Identifiable {
        let id = UUID()
        let title: String
        let color: Color
        let restore: @MainActor () async -> Void
    }

    @ObservationIgnored private var lastDoneAt = Date.distantPast
    @ObservationIgnored private var streak = 0
    @ObservationIgnored private var undoExpiry: Task<Void, Never>?

    /// Seconds from the check appearing to it landing: the burst, the hop
    /// and the success tap all wait for this.
    static let landsAt = 0.26
    /// How long a row shows its check before it settles or folds away.
    static let holds = 0.95

    /// Counts this done into the streak and returns its level, 0 ... 3.
    func nextLevel() -> Int {
        let now = Date()
        streak = now.timeIntervalSince(lastDoneAt) < 4 ? min(streak + 1, 3) : 0
        lastDoneAt = now
        return streak
    }

    /// The tap for a done, timed to land with the check `delay` from now.
    func tap(level: Int, after delay: Double) {
        Task { @MainActor in
            DoneHaptics.shared.prepare()
            try? await Task.sleep(for: .seconds(delay + Self.landsAt))
            DoneHaptics.shared.land(level: level)
        }
    }

    /// A done marked from anywhere: the tap, and the bot's row in the list
    /// checks off after `delay`, so a closing menu or a pop back to the list
    /// doesn't hide it.
    func done(_ chatID: String, after delay: Double = 0) {
        let level = nextLevel()
        tap(level: level, after: delay)
        celebrate(chatID, level: level, after: delay)
    }

    func celebrate(_ id: String, level: Int, after delay: Double = 0) {
        Task { @MainActor in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            withAnimation(.spring(response: 0.28, dampingFraction: 0.7)) { showing[id] = level }
            try? await Task.sleep(for: .seconds(Self.holds + 0.25))
            withAnimation(.easeOut(duration: 0.3)) { _ = showing.removeValue(forKey: id) }
        }
    }

    /// Offers the last done back for a few seconds. A newer done replaces it.
    func offerUndo(title: String, color: Color, restore: @escaping @MainActor () async -> Void) {
        let entry = Undo(title: title, color: color, restore: restore)
        withAnimation(.spring(response: 0.38, dampingFraction: 0.8)) { undo = entry }
        undoExpiry?.cancel()
        undoExpiry = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4.5))
            guard !Task.isCancelled, let self, self.undo?.id == entry.id else { return }
            withAnimation(.smooth(duration: 0.3)) { self.undo = nil }
        }
    }

    func takeBack() {
        guard let entry = undo else { return }
        undoExpiry?.cancel()
        Haptics.impact(.soft)
        streak = 0
        lastDoneAt = .distantPast
        withAnimation(.smooth(duration: 0.3)) { undo = nil }
        Task { await entry.restore() }
    }

    func dismissUndo() {
        undoExpiry?.cancel()
        withAnimation(.smooth(duration: 0.25)) { undo = nil }
    }
}

// MARK: - Haptics

/// The done taps: a tick when a swipe arms, a soft release when it backs
/// off, and the landing — one crisp tap with a soft echo, plus a rising tap
/// per streak level. Core Haptics so the landing is one sharp event rather
/// than the system success buzz; the system feedback where it isn't there.
@MainActor final class DoneHaptics {
    static let shared = DoneHaptics()
    private var engine: CHHapticEngine?
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private var supported: Bool { CHHapticEngine.capabilitiesForHardware().supportsHaptics }

    /// Warms everything up when a swipe starts, so the tick is on time.
    func prepare() {
        rigid.prepare()
        soft.prepare()
        guard supported else { return }
        if engine == nil, let made = try? CHHapticEngine() {
            made.isAutoShutdownEnabled = true
            made.resetHandler = { [weak self] in Task { @MainActor in self?.engine = nil } }
            engine = made
        }
        try? engine?.start()
    }

    func armed() { rigid.impactOccurred(intensity: 0.85) }
    func disarmed() { soft.impactOccurred(intensity: 0.45) }

    func land(level: Int) {
        guard supported else {
            Haptics.success()
            return
        }
        do {
            prepare()
            guard let engine else { throw CocoaError(.featureUnsupported) }
            var events = [
                tap(0, intensity: min(1, 0.78 + 0.07 * Float(level)), sharpness: 0.7),
                tap(0.085, intensity: 0.35, sharpness: 0.25),
            ]
            for step in 0..<level {
                events.append(tap(0.17 + Double(step) * 0.06, intensity: 0.45 + 0.12 * Float(step), sharpness: 0.55 + 0.12 * Float(step)))
            }
            let player = try engine.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            Haptics.success()
        }
    }

    private func tap(_ time: Double, intensity: Float, sharpness: Float) -> CHHapticEvent {
        CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
        ], relativeTime: time)
    }
}

// MARK: - The check

/// A disc in the bot's colour that pops on, draws its check, and bursts as
/// it lands.
struct DoneCheck: View {
    var color: Color
    var size: CGFloat = 22
    /// Streak level, 0 ... 3: a bigger pop and burst each step.
    var level = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn = false
    @State private var landed = 0
    @State private var burst = false

    var body: some View {
        ZStack {
            Circle().fill(color)
            CheckStroke()
                .trim(from: 0, to: drawn ? 1 : 0)
                .stroke(.white, style: StrokeStyle(lineWidth: max(2, size * 0.13), lineCap: .round, lineJoin: .round))
                .padding(size * 0.28)
        }
        .frame(width: size, height: size)
        .keyframeAnimator(initialValue: Squash(), trigger: landed) { view, s in
            view.scaleEffect(x: s.sx, y: s.sy)
        } keyframes: { _ in
            let pop = 1.16 + 0.05 * CGFloat(level)
            KeyframeTrack(\.sx) {
                CubicKeyframe(0.3, duration: 0.01)
                SpringKeyframe(pop, duration: 0.15, spring: .snappy)
                CubicKeyframe(0.92, duration: 0.1)
                CubicKeyframe(1.08, duration: 0.08)
                SpringKeyframe(1, duration: 0.3, spring: .bouncy)
            }
            KeyframeTrack(\.sy) {
                CubicKeyframe(0.3, duration: 0.01)
                SpringKeyframe(2 - pop, duration: 0.15, spring: .snappy)
                CubicKeyframe(1.1, duration: 0.1)
                CubicKeyframe(0.94, duration: 0.08)
                SpringKeyframe(1, duration: 0.3, spring: .bouncy)
            }
        }
        .background {
            if burst {
                DoneBurst(color: color, level: level)
                    .frame(width: size * 3.2, height: size * 3.2)
            }
        }
        .onAppear {
            if reduceMotion {
                withAnimation(.easeOut(duration: 0.2)) { drawn = true }
                return
            }
            landed += 1
            withAnimation(.spring(response: 0.22, dampingFraction: 0.86).delay(0.08)) { drawn = true }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(DoneMoments.landsAt - 0.02))
                burst = true
            }
        }
        .accessibilityHidden(true)
    }

    private struct Squash { var sx: CGFloat = 1; var sy: CGFloat = 1 }
}

/// A checkmark drawn from its short arm to its long one, so `trim` writes it.
struct CheckStroke: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY + rect.height * 0.04))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY - rect.height * 0.08))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.1))
        return path
    }
}

/// A ring and a handful of sparks thrown out of the check, in the bot's
/// colour. One animatable number drives the whole Canvas, so it draws only
/// while it plays and then stays clear.
struct DoneBurst: View {
    let color: Color
    var level = 0
    @State private var t: CGFloat = 0

    var body: some View {
        BurstFrame(color: color, level: level, t: t)
            .allowsHitTesting(false)
            .onAppear { withAnimation(.timingCurve(0.15, 0.8, 0.3, 1, duration: 0.62)) { t = 1 } }
    }

    private struct BurstFrame: View, Animatable {
        let color: Color
        let level: Int
        var t: CGFloat
        var animatableData: CGFloat {
            get { t }
            set { t = newValue }
        }

        var body: some View {
            Canvas { context, canvas in
                guard t > 0, t < 1 else { return }
                let center = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
                let reach = canvas.width / 2 * (0.86 + 0.07 * CGFloat(level))
                let core = canvas.width / 2 / 3.2

                // the ring: out from the disc's edge, thinning as it goes
                let ring = core + (reach - core) * min(1, t * 1.25)
                let width = max(0.5, core * 0.32 * (1 - t))
                context.stroke(Path(ellipseIn: CGRect(x: center.x - ring, y: center.y - ring, width: ring * 2, height: ring * 2)),
                               with: .color(color.opacity(Double(1 - t) * 0.7)), lineWidth: width)

                // sparks: short dashes that fly out and shrink to nothing
                let count = 7 + 2 * level
                for i in 0..<count {
                    let angle = (Double(i) / Double(count)) * 2 * .pi - .pi / 2 + (i.isMultiple(of: 2) ? 0 : 0.18)
                    let far = i.isMultiple(of: 2) ? 1.0 : 0.78
                    let out = core * 1.05 + (reach - core * 1.05) * t * far
                    let length = core * 0.55 * (1 - t) * far
                    let dir = CGPoint(x: cos(angle), y: sin(angle))
                    var dash = Path()
                    dash.move(to: CGPoint(x: center.x + dir.x * out, y: center.y + dir.y * out))
                    dash.addLine(to: CGPoint(x: center.x + dir.x * (out + length), y: center.y + dir.y * (out + length)))
                    context.stroke(dash, with: .color(color.opacity(Double(1 - t * t))),
                                   style: StrokeStyle(lineWidth: max(0.8, core * 0.26 * (1 - t * 0.6)), lineCap: .round))
                }
            }
        }
    }
}

// MARK: - The swipe

extension View {
    /// Swipe right to mark done: the row follows the finger and a ring in
    /// `color` fills behind it, arming with a tick at the threshold. Letting
    /// go armed (or flicking) calls `onDone` while the row springs home.
    /// iOS 18; on 17 the menus still mark done.
    func doneSwipe(color: Color, enabled: Bool, onDone: @escaping () -> Void) -> some View {
        modifier(DoneSwipe(color: color, enabled: enabled, onDone: onDone))
    }
}

private struct DoneSwipe: ViewModifier {
    let color: Color
    let enabled: Bool
    let onDone: () -> Void
    @State private var offset: CGFloat = 0
    @State private var armed = false

    /// Points of travel that arm the swipe.
    static let threshold: CGFloat = 104

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .offset(x: offset)
                .background(alignment: .leading) {
                    DoneSwipeTrack(color: color, offset: offset, armed: armed, threshold: Self.threshold)
                }
                .gesture(DonePan(enabled: enabled, onMove: move, onRelease: release, onCancel: cancel))
        } else {
            content
        }
    }

    /// 1:1 up to the threshold, then a rubber band.
    private func move(_ x: CGFloat) {
        let travel = max(0, x)
        let shown = travel <= Self.threshold ? travel : Self.threshold + (travel - Self.threshold) * 0.32
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { offset = shown }
        let nowArmed = travel >= Self.threshold
        if nowArmed != armed {
            withAnimation(.spring(response: 0.24, dampingFraction: 0.6)) { armed = nowArmed }
            if nowArmed { DoneHaptics.shared.armed() } else { DoneHaptics.shared.disarmed() }
        }
    }

    private func release(_ x: CGFloat, velocity: CGFloat) {
        let flicked = velocity > 900 && x > Self.threshold * 0.45
        let commit = armed || flicked
        withAnimation(.spring(response: commit ? 0.42 : 0.34, dampingFraction: commit ? 0.74 : 0.82)) {
            offset = 0
            armed = false
        }
        if commit { onDone() }
    }

    private func cancel() {
        withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
            offset = 0
            armed = false
        }
    }
}

/// What a swipe reveals: a wash of the bot's colour and a ring that fills
/// with the travel, then snaps into a solid disc with its check once armed.
private struct DoneSwipeTrack: View {
    let color: Color
    let offset: CGFloat
    let armed: Bool
    let threshold: CGFloat

    var body: some View {
        let progress = min(1, offset / threshold)
        let size: CGFloat = 30
        ZStack {
            Rectangle()
                .fill(color.opacity(armed ? 0.16 : 0.08 * Double(progress)))
            ZStack {
                Circle().stroke(color.opacity(0.25), lineWidth: 2.5)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Circle().fill(color).scaleEffect(armed ? 1 : 0.001)
                CheckStroke()
                    .trim(from: 0, to: armed ? 1 : 0)
                    .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    .padding(size * 0.28)
            }
            .frame(width: size, height: size)
            .scaleEffect((0.55 + 0.45 * progress) * (armed ? 1.12 : 1))
            .opacity(Double(min(1, progress * 2.2)))
        }
        // the ring rides in the middle of the gap the row leaves
        .frame(width: max(offset, 0))
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The swipe's finger. UIKit, so the row and the roster's scroll can share a
/// touch: it decides within a few points, giving up the moment the finger
/// goes up, down or left, and the scroll view waits only that long.
@available(iOS 18.0, *)
private struct DonePan: UIGestureRecognizerRepresentable {
    let enabled: Bool
    let onMove: (CGFloat) -> Void
    let onRelease: (CGFloat, CGFloat) -> Void
    let onCancel: () -> Void

    final class Recognizer: UIGestureRecognizer, UIGestureRecognizerDelegate {
        var allowed = true
        private(set) var travel: CGFloat = 0
        private var finger: UITouch?
        private var start: CGPoint = .zero
        private var samples: [(time: TimeInterval, x: CGFloat)] = []

        /// Points per second over the last few hundredths of a second.
        var velocity: CGFloat {
            guard let last = samples.last,
                  let first = samples.first(where: { last.time - $0.time <= 0.08 }),
                  last.time - first.time > 0.004 else { return 0 }
            return (last.x - first.x) / (last.time - first.time)
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            guard allowed, finger == nil, touches.count == 1, let touch = touches.first else {
                if state == .possible { state = .failed }
                return
            }
            finger = touch
            start = touch.location(in: nil)
            samples = [(touch.timestamp, start.x)]
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let finger, touches.contains(finger) else { return }
            let point = finger.location(in: nil)
            let dx = point.x - start.x, dy = point.y - start.y
            samples.append((finger.timestamp, point.x))
            if samples.count > 8 { samples.removeFirst(samples.count - 8) }
            switch state {
            case .possible:
                if abs(dy) > 5 && abs(dy) >= abs(dx) * 0.8 { state = .failed }
                else if dx < -5 { state = .failed }
                else if dx > 9 && dx > abs(dy) * 1.4 {
                    // start from here, so the row doesn't jump the slop
                    start.x = point.x - 1
                    travel = 1
                    state = .began
                }
            case .began, .changed:
                travel = point.x - start.x
                state = .changed
            default: break
            }
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let finger, touches.contains(finger) else { return }
            state = (state == .began || state == .changed) ? .ended : .failed
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let finger, touches.contains(finger) else { return }
            state = (state == .began || state == .changed) ? .cancelled : .failed
        }

        override func reset() {
            super.reset()
            finger = nil
            travel = 0
            samples = []
        }

        // the roster's scroll (and a list's own swipe actions) wait the few
        // points it takes this to decide, so a scroll is never half a swipe
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other.view is UIScrollView && other is UIPanGestureRecognizer
        }
    }

    func makeUIGestureRecognizer(context: Context) -> Recognizer {
        let recognizer = Recognizer()
        recognizer.delegate = recognizer
        recognizer.cancelsTouchesInView = true
        recognizer.delaysTouchesBegan = false
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: Recognizer, context: Context) {
        recognizer.allowed = enabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: Recognizer, context: Context) {
        switch recognizer.state {
        case .began:
            DoneHaptics.shared.prepare()
            onMove(recognizer.travel)
        case .changed:
            onMove(recognizer.travel)
        case .ended:
            onRelease(recognizer.travel, recognizer.velocity)
        case .cancelled, .failed:
            onCancel()
        default: break
        }
    }
}

// MARK: - Undo

/// "Done · Undo" for the last thread marked done, a small glass pill that
/// slides up for a few seconds.
struct DoneUndoPill: View {
    private var moments = DoneMoments.shared

    var body: some View {
        if let undo = moments.undo {
            HStack(spacing: 10) {
                DoneCheck(color: undo.color, size: 20)
                Text(verbatim: undo.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Button("Undo") { moments.takeBack() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(undo.color)
                    .accessibilityIdentifier("done-undo")
            }
            .padding(.leading, 12)
            .padding(.trailing, 18)
            .frame(height: 48)
            .glassCapsule()
            .padding(.horizontal, 24)
            .id(undo.id)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .gesture(DragGesture(minimumDistance: 12).onEnded { value in
                if value.translation.height > 10 { moments.dismissUndo() }
            })
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Marked done: \(undo.title)")
            .accessibilityAction(named: "Undo") { moments.takeBack() }
        }
    }
}
