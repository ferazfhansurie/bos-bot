// A bot ringing its owner (`ring_owner`), while the app is open: a full-screen
// incoming call that rings until it is answered, declined or 30 s pass.
// Accept starts the realtime call, opening with why the bot called. With the
// app in the background the same ring is CallKit (or, without a VoIP token,
// a time-sensitive notification with Accept).
//
// Calm at rest, wild when touched. The bot's own mascot hops on every ring
// with its colour rippling out behind it; slide the thumb and it watches it
// come, wide-eyed; fling the mascot and it flies off, declining the call.
// Answering never shows two of it: this mascot glides into the call screen's
// avatar slot and the call screen takes over underneath it, pixel for pixel.
import AudioToolbox
import CompanionCore
import SwiftUI

struct IncomingVoiceRing: Identifiable {
    let ring: VoiceRing
    let bot: Bot
    let session: Session
    /// The ring's clock: the chime, the buzz and the mascot's hops all count
    /// from here, so they land together.
    var startedAt = Date()
    var id: String { ring.ringId }
}

/// The ring itself: the bos chime and a crouch-and-land buzz, once a ring.
@MainActor
final class VoiceRinger {
    private var timer: Timer?
    private static let chime: SystemSoundID = {
        var id: SystemSoundID = 1151
        if let url = Bundle.main.url(forResource: "bos-ring", withExtension: "caf") {
            AudioServicesCreateSystemSoundID(url as CFURL, &id)
        }
        return id
    }()

    func start() {
        Self.pulseOnce()
        let timer = Timer(timeInterval: RingMascotMotion.period, repeats: true) { _ in
            MainActor.assumeIsolated { VoiceRinger.pulseOnce() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private static func pulseOnce() {
        AudioServicesPlaySystemSound(chime)
        // the crouch, then the landing a beat later, felt in the hand
        Haptics.impact(.soft)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.44) { Haptics.impact(.medium) }
    }

    deinit { timer?.invalidate() }
}

/// The ringing mascot's motion, kept across frames.
@MainActor
final class RingMotionBox {
    var motion = RingMascotMotion()
}

struct IncomingVoiceCallView: View {
    let incoming: IncomingVoiceRing
    @ObservedObject var center: VoiceCallCenter

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var box = RingMotionBox()
    @State private var appeared = false
    /// The answer thumb's travel, 0 ... `travel`.
    @State private var thumb: CGFloat = 0
    @State private var thumbHeld = false
    @State private var lastTick = 0
    /// The mascot held and flung.
    @State private var fling: CGSize = .zero
    @State private var flown = false
    @State private var spin: Double = 0
    /// Answered: everything but the mascot and its name gets out of the way
    /// while they glide into the call screen's header.
    @State private var handoff = false

    private static let mascotSize: CGFloat = 140
    private static let thumbSize: CGFloat = 64
    private static let trackHeight: CGFloat = 76
    /// The call screen's header (VoiceCallFullScreen): avatar 96 with 8 + 6
    /// on top, then the 17pt name 6 below it.
    private static let headerAvatar: CGFloat = 96
    private static let headerAvatarY: CGFloat = 8 + 6 + 48
    private static let headerNameY: CGFloat = 8 + 6 + 96 + 6 + 6 + 11

    private var dark: Bool { scheme == .dark }
    private var paint: (body: Color, ink: Color, accent: Color) { GlyphMark.colors(incoming.bot.color, scheme: scheme) }
    private var wearsMascot: Bool { (incoming.bot.avatarCrop ?? .mascot) == .mascot || incoming.bot.avatarUrl == nil }

    var body: some View {
        GeometryReader { proxy in
            let top = proxy.safeAreaInsets.top
            let size = CGSize(width: proxy.size.width, height: proxy.size.height + top + proxy.safeAreaInsets.bottom)
            let mascotCentre = CGPoint(x: size.width / 2, y: size.height * 0.40)
            let headerCentre = CGPoint(x: size.width / 2, y: top + Self.headerAvatarY)
            let trackWidth = min(size.width - 48, 360)
            let travel = trackWidth - Self.thumbSize - 12
            let trackY = size.height - proxy.safeAreaInsets.bottom - 40 - Self.trackHeight / 2

            ZStack {
                (dark ? Color.black : Color.white)

                glow
                    .position(handoff ? headerCentre : mascotCentre)
                    .scaleEffect(handoff ? 0.7 : 1)
                    .opacity(handoff ? 0 : (appeared ? 1 : 0))

                Text("incoming call")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .position(x: size.width / 2, y: top + 44)
                    .opacity(handoff || !appeared ? 0 : 1)

                mascot
                    .scaleEffect(handoff ? Self.headerAvatar / Self.mascotSize : (appeared ? 1 : 0.4))
                    .rotationEffect(.degrees(spin))
                    .offset(handoff ? .zero : fling)
                    .position(handoff ? headerCentre : mascotCentre)
                    .opacity(flown ? 0 : 1)
                    .gesture(flingGesture)
                    .onTapGesture { poke() }

                VStack(spacing: 8) {
                    Text(incoming.bot.name)
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(dark ? .white : .black)
                        .lineLimit(1)
                        .scaleEffect(handoff ? 17 / 30 : 1)
                    Text(reason)
                        .font(.system(size: 17))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 32)
                        .opacity(handoff ? 0 : 1)
                }
                .frame(width: size.width)
                .position(x: size.width / 2,
                          y: handoff ? top + Self.headerNameY + 14 : mascotCentre.y + Self.mascotSize / 2 + 54)
                .opacity(appeared ? 1 : 0)

                decline
                    .position(x: size.width / 2, y: trackY - Self.trackHeight / 2 - 58)
                    .opacity(handoff || !appeared ? 0 : 1)

                slider(width: trackWidth, travel: travel)
                    .position(x: size.width / 2, y: trackY)
                    .opacity(handoff || !appeared ? 0 : 1)
                    .offset(y: appeared ? 0 : 40)
            }
            .frame(width: size.width, height: size.height)
            .ignoresSafeArea()
            .onAppear {
                box.motion.start = incoming.startedAt.timeIntervalSinceReferenceDate
                withAnimation(.spring(response: 0.55, dampingFraction: 0.62)) { appeared = true }
            }
            .onChange(of: thumb) { _, value in
                box.motion.pull = travel > 0 ? value / travel : 0
                let thumbX = size.width / 2 - trackWidth / 2 + 6 + Self.thumbSize / 2 + value
                box.motion.thumb = thumbHeld
                    ? CGPoint(x: (thumbX - mascotCentre.x) / Self.mascotSize, y: (trackY - mascotCentre.y) / Self.mascotSize)
                    : nil
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(incoming.bot.name) is calling")
        .accessibilityAction(named: "Answer") { answer() }
        .accessibilityAction(named: "Decline") { center.decline() }
    }

    private var reason: String {
        let line = incoming.ring.reason.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return line.isEmpty ? "wants to talk" : line.lowercased()
    }

    // MARK: Mascot

    @ViewBuilder private var mascot: some View {
        if wearsMascot {
            LiveMascot(color: incoming.bot.color, bodyId: incoming.bot.mascotBody,
                       eyeStyle: MascotEyeStyle(stored: incoming.bot.mascotEyes),
                       face: handoff ? .idle : .happy, accent: false, size: Self.mascotSize, fps: 120) { [box, reduceMotion] date in
                // Reduce Motion: no hops; the eyes and blink stay.
                if reduceMotion { box.motion.settled = true }
                return box.motion.step(at: date.timeIntervalSinceReferenceDate)
            }
            .accessibilityHidden(true)
        } else {
            BotAvatarView(bot: incoming.bot, size: Self.mascotSize, state: .happy, animated: true)
                .accessibilityHidden(true)
        }
    }

    /// The bot's colour, rippling out once a ring and breathing between.
    private var glow: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion || handoff)) { timeline in
            let since = max(0, timeline.date.timeIntervalSince(incoming.startedAt))
            let accent = paint.accent
            Canvas { context, canvas in
                let centre = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
                let base = Self.mascotSize * 0.62
                // the halo the mascot stands in
                let breathe = reduceMotion ? 1 : 1 + 0.04 * sin(since * 2 * .pi / 1.7)
                let halo = base * 1.9 * breathe
                context.fill(Path(ellipseIn: CGRect(x: centre.x - halo, y: centre.y - halo, width: halo * 2, height: halo * 2)),
                             with: .radialGradient(Gradient(colors: [accent.opacity(dark ? 0.34 : 0.22), accent.opacity(0)]),
                                                   center: centre, startRadius: 0, endRadius: halo))
                guard !reduceMotion else { return }
                // three rings leave on each hop's landing and fade as they go
                for wave in 0..<3 {
                    let age = (since - 0.44 - Double(wave) * 0.22).truncatingRemainder(dividingBy: RingMascotMotion.period)
                    guard since - 0.44 - Double(wave) * 0.22 >= 0, age >= 0, age < 1.8 else { continue }
                    let k = age / 1.8
                    let eased = 1 - pow(1 - k, 3)
                    let r = base * (0.9 + 1.7 * eased)
                    context.stroke(Path(ellipseIn: CGRect(x: centre.x - r, y: centre.y - r, width: r * 2, height: r * 2)),
                                   with: .color(accent.opacity(0.42 * (1 - k))),
                                   lineWidth: 2.5 * (1 - k) + 0.5)
                }
            }
        }
        .frame(width: Self.mascotSize * 4.4, height: Self.mascotSize * 4.4)
        .allowsHitTesting(false)
    }

    private var flingGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard !handoff, !flown else { return }
                // held: it follows the finger with a little give
                let t = value.translation
                fling = CGSize(width: rubber(t.width), height: rubber(t.height))
                box.motion.drag = fling
            }
            .onEnded { value in
                guard !handoff, !flown else { return }
                let thrown = CGSize(width: value.predictedEndTranslation.width - value.translation.width,
                                    height: value.predictedEndTranslation.height - value.translation.height)
                let speed = hypot(thrown.width, thrown.height)
                box.motion.drag = .zero
                if speed > 260 || hypot(value.translation.width, value.translation.height) > 170 {
                    // flung: off it goes, and the call with it
                    let direction = CGSize(width: value.predictedEndTranslation.width, height: value.predictedEndTranslation.height)
                    let length = max(hypot(direction.width, direction.height), 1)
                    Haptics.impact(.rigid)
                    center.silenceRing()
                    withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 1)) {
                        if reduceMotion { flown = true } else {
                            fling = CGSize(width: direction.width / length * 900, height: direction.height / length * 900)
                            spin = direction.width >= 0 ? 38 : -38
                        }
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) { center.decline(animated: true) }
                } else {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.5)) { fling = .zero }
                    box.motion.poke(at: Date().timeIntervalSinceReferenceDate)
                    Haptics.impact(.light)
                }
            }
    }

    private func rubber(_ x: CGFloat) -> CGFloat {
        let limit: CGFloat = 220
        return limit * (1 - exp(-abs(x) / limit)) * (x < 0 ? -1 : 1)
    }

    private func poke() {
        box.motion.poke(at: Date().timeIntervalSinceReferenceDate)
        Haptics.impact(.light)
    }

    // MARK: Controls

    private var decline: some View {
        Button {
            center.decline()
        } label: {
            Image(systemName: "phone.down.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Circle().fill(Color(hex: "#ff453a")))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Decline")
    }

    private func slider(width: CGFloat, travel: CGFloat) -> some View {
        let progress = travel > 0 ? thumb / travel : 0
        return ZStack(alignment: .leading) {
            Capsule()
                .fill(Color.clear)
                .frame(width: width, height: Self.trackHeight)
                .glassCapsule(interactive: false)
            // the track fills green behind the thumb as it goes
            Capsule()
                .fill(Color(hex: "#30d158").opacity(0.22))
                .frame(width: Self.thumbSize + 12 + thumb, height: Self.trackHeight)
            SlideShimmerLabel(text: "slide to answer", dark: dark, still: reduceMotion)
                .frame(width: width - Self.thumbSize - 12)
                .offset(x: Self.thumbSize + 6)
                .opacity(1 - min(progress * 2.2, 1))
            Image(systemName: "phone.fill")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white)
                .rotationEffect(.degrees(Double(progress) * -135))
                .frame(width: Self.thumbSize, height: Self.thumbSize)
                .background(Circle().fill(Color(hex: "#30d158")))
                .scaleEffect(thumbHeld ? 1.06 : 1)
                .offset(x: 6 + thumb)
                .gesture(thumbGesture(travel: travel))
        }
        .frame(width: width, height: Self.trackHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Slide to answer")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { answer() }
    }

    private func thumbGesture(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard !handoff else { return }
                if !thumbHeld {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.7)) { thumbHeld = true }
                    Haptics.selection()
                }
                thumb = min(max(value.translation.width, 0), travel)
                // a tick at each quarter, like a detent
                let tick = Int(thumb / max(travel, 1) * 4)
                if tick != lastTick { lastTick = tick; Haptics.selection() }
            }
            .onEnded { value in
                guard !handoff else { return }
                let landed = min(max(value.predictedEndTranslation.width, 0), travel)
                withAnimation(.spring(response: 0.25, dampingFraction: 0.7)) { thumbHeld = false }
                if thumb > travel * 0.82 || landed >= travel {
                    withAnimation(.spring(response: 0.22, dampingFraction: 0.9)) { thumb = travel }
                    answer()
                } else {
                    lastTick = 0
                    withAnimation(.spring(response: 0.45, dampingFraction: 0.55)) { thumb = 0 }
                    Haptics.impact(.light)
                }
            }
    }

    private func answer() {
        guard !handoff else { return }
        Haptics.success()
        center.silenceRing()
        box.motion.settled = true
        box.motion.thumb = nil
        withAnimation(reduceMotion ? .easeInOut(duration: 0.3) : .spring(response: 0.5, dampingFraction: 0.86)) {
            handoff = true
            fling = .zero
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0.3 : 0.46)) { center.accept(handoff: true) }
    }
}

/// "slide to answer" with the system's light sweeping across it.
private struct SlideShimmerLabel: View {
    let text: String
    let dark: Bool
    let still: Bool

    var body: some View {
        let label = Text(text).font(.system(size: 19, weight: .regular))
        label
            .foregroundStyle((dark ? Color.white : Color.black).opacity(0.38))
            .overlay {
                if !still {
                    TimelineView(.animation(minimumInterval: 1.0 / 60)) { timeline in
                        let t = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                        GeometryReader { geo in
                            LinearGradient(colors: [.clear, (dark ? Color.white : Color.black).opacity(0.85), .clear],
                                           startPoint: .leading, endPoint: .trailing)
                                .frame(width: geo.size.width * 0.45)
                                .offset(x: (geo.size.width * 1.45) * t - geo.size.width * 0.45)
                        }
                        .mask(label)
                    }
                }
            }
            .lineLimit(1)
            .allowsHitTesting(false)
    }
}
