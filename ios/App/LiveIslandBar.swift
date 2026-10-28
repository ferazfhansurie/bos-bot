// The 3.0 live island: while a bot works in the open thread, a glass
// capsule the bot itself stands in sits on top of the composer.
//
// The bot's real mascot with its live face, one shimmering line saying what
// it is doing, how long it has been at it, and stop. When it needs you it
// comes forward with the waiting face, points up at the card and says the
// question; a tap takes you there. When the turn ends it hops once with the
// happy > < face, then settles back into the header.
//
// What it says and which beat it is on are decided in CompanionCore
// (LiveIsland.swift); this file only draws. Nothing here runs unless
// `CompanionState.v3` is on.
import CompanionCore
import SwiftUI

/// The springs the 3.0 motion uses, from shared/motion.json.
enum V3Motion {
    static let snap = Animation.spring(response: 0.25, dampingFraction: 0.7)
    static let pop = Animation.spring(response: 0.3, dampingFraction: 0.75)
    static let glide = Animation.spring(response: 0.42, dampingFraction: 0.74)
    static let bounce = Animation.spring(response: 0.45, dampingFraction: 0.62)
    static let travel = Animation.spring(response: 0.9, dampingFraction: 0.9)
    /// Reduce motion: places swap with a fade instead of travelling.
    static let fade = Animation.easeInOut(duration: 0.22)

    static func travel(reduceMotion: Bool) -> Animation { reduceMotion ? fade : travel }
}

/// The id the mascot carries between the header and the island.
enum IslandMascotID { static let face = "v3.island.mascot" }

struct LiveIslandBar: View {
    let bot: Bot
    let phase: LiveIslandState.Phase
    /// The current activity, from `LiveActivityLine`.
    let line: String
    /// The pending card's question, while the bot needs you.
    let ask: String?
    /// The feed's face while it works.
    let face: MausState
    let startedAt: Date?
    /// Whether the mascot stands in the island now. False while it is
    /// elsewhere (the empty thread's mascot still playing, or on its way):
    /// its spot holds a quiet ring until it arrives.
    let holdsMascot: Bool
    /// Shared with the header face; nil under reduce motion, where the
    /// mascot fades between places instead of travelling.
    let namespace: Namespace.ID?
    let onOpen: () -> Void
    let onAsk: () -> Void
    let onStop: (() -> Void)?
    let stopping: Bool
    /// Words just folded into the running turn: the line reads "got it".
    var gotIt: Bool = false
    /// Drawn as the chat header's name pill (name over what it is doing),
    /// with no button, glass or stop of its own: the header's menu is the tap.
    var inHeader: Bool = false
    /// The name's colour in the header, as the idle pill draws it.
    var nameColor: Color? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var hop: CGFloat = 0
    @State private var squash: CGFloat = 1
    @State private var burst = 0
    @State private var nudge = false

    private var color: Color { MausPalette.color(bot.color) }
    /// The bot's own colour can be near white or near black; the label
    /// keeps the accent only where it reads.
    private var accent: Color { GlyphMark.colors(bot.color, scheme: scheme).accent }

    private var ink: Color { scheme == .dark ? Color(white: 0.96) : Color(white: 0.11) }
    private var paper: Color { scheme == .dark ? Color(white: 0.08) : Color.white }

    private var mascotState: MausState {
        switch phase {
        case .needsYou: return .listening
        case .done: return .celebrate
        case .working, .off: return face
        }
    }

    var body: some View {
        if inHeader { headerPill } else { island }
    }

    /// The header's name pill while the bot works: one pill on top, never
    /// a second one over the composer.
    private var headerPill: some View {
        HStack(spacing: 8) {
            mascot
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: bot.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(nameColor ?? Color.primary)
                HStack(spacing: 6) {
                    headerLine
                    if phase == .working || phase == .needsYou, let startedAt {
                        TimelineView(.periodic(from: startedAt, by: 1)) { context in
                            Text(elapsedLabel(Int(context.date.timeIntervalSince(startedAt))))
                                .font(.system(size: 12).monospacedDigit())
                                .foregroundStyle(Color.secondary.opacity(0.75))
                        }
                    }
                }
                .font(.system(size: 12))
            }
            .lineLimit(1)
        }
        .frame(maxWidth: 230, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier("v3-island")
        .animation(V3Motion.glide, value: phase)
        .animation(reduceMotion ? V3Motion.fade : V3Motion.snap, value: gotIt)
        .onChange(of: phase, initial: true) { _, next in
            if next == .done { playDone() }
            nudge = false
            if next == .needsYou, !reduceMotion {
                withAnimation(.easeInOut(duration: 0.45).repeatForever(autoreverses: true)) { nudge = true }
            }
        }
    }

    @ViewBuilder private var headerLine: some View {
        switch phase {
        case .needsYou:
            Text(verbatim: ask ?? String(localized: "needs you")).foregroundStyle(accent)
        case .done:
            Text("done").foregroundStyle(Color.secondary)
        case .working, .off:
            if gotIt { Text("got it").foregroundStyle(Color.primary) } else { IslandShimmer(text: line) }
        }
    }

    private var island: some View {
        HStack(spacing: 6) {
            Button(action: phase == .needsYou ? onAsk : onOpen) {
                HStack(spacing: 10) {
                    mascot
                    label
                    Spacer(minLength: 4)
                    if phase == .working || phase == .needsYou, let startedAt {
                        TimelineView(.periodic(from: startedAt, by: 1)) { context in
                            Text(elapsedLabel(Int(context.date.timeIntervalSince(startedAt))))
                                .font(.system(size: 12).monospacedDigit())
                                .foregroundStyle(Color.secondary.opacity(0.75))
                        }
                        .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityHint(phase == .needsYou ? Text("Shows the question") : Text("Opens the composer"))
            .accessibilityIdentifier("v3-island")

            if let onStop, phase == .working || phase == .needsYou {
                Button { onStop() } label: {
                    ZStack {
                        // ink on glass; fixed, so the glass's own vibrancy
                        // cannot wash it out
                        Circle().fill(ink)
                        if stopping {
                            ProgressView().controlSize(.mini).tint(paper)
                        } else {
                            RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                                .fill(paper)
                                .frame(width: 11, height: 11)
                        }
                    }
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
                }
                .buttonStyle(BosPressStyle())
                .disabled(stopping)
                .accessibilityLabel(stopping ? "Stopping" : "Stop")
                .accessibilityIdentifier("v3-island-stop")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
        }
        // the waiting face raises a mark beside its head: room for it
        .padding(.leading, phase == .needsYou ? 16 : 6).padding(.trailing, 7)
        .frame(height: 46)
        .frame(maxWidth: 340)
        .glassCapsule(interactive: true)
        .overlay {
            if phase == .needsYou {
                Capsule().strokeBorder(accent.opacity(0.6), lineWidth: 1)
                    .allowsHitTesting(false)
            }
        }
        .animation(V3Motion.glide, value: phase)
        .animation(reduceMotion ? V3Motion.fade : V3Motion.snap, value: gotIt)
        .onChange(of: phase, initial: true) { _, next in
            if next == .done { playDone() }
            nudge = false
            if next == .needsYou, !reduceMotion {
                withAnimation(.easeInOut(duration: 0.45).repeatForever(autoreverses: true)) { nudge = true }
            }
        }
    }

    // MARK: - Parts

    @ViewBuilder private var mascot: some View {
        ZStack {
            if holdsMascot {
                BotAvatarView(bot: bot, size: 34, state: mascotState, animated: phase != .off)
                    // asking: it leans up toward the card it points at
                    .rotationEffect(.degrees(phase == .needsYou && !reduceMotion ? -6 : 0), anchor: .bottom)
                    .scaleEffect(x: 2 - squash, y: squash, anchor: .bottom)
                    .offset(y: hop)
                    .background {
                        if burst > 0 {
                            DoneBurst(color: color, level: 0)
                                .frame(width: 84, height: 84)
                                .id(burst)
                        }
                    }
                    .modifier(MatchedMascot(namespace: namespace))
                    .transition(.opacity)
                    // a poke: a small hop, and the island's tap still opens
                    .simultaneousGesture(TapGesture().onEnded { pokeHop() })
            } else {
                // its place, while it is out
                Circle()
                    .strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .frame(width: 24, height: 24)
                    .transition(.opacity)
            }
            if phase == .needsYou {
                Image(systemName: "chevron.up")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(accent)
                    .offset(x: 17, y: -14 + (nudge ? -3 : 0))
                    .accessibilityHidden(true)
                    .transition(.opacity)
            }
        }
        .frame(width: 36, height: 36)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var label: some View {
        switch phase {
        case .needsYou:
            VStack(alignment: .leading, spacing: 1) {
                Text("needs you")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(accent)
                if let ask {
                    Text(verbatim: ask)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
            }
            .lineLimit(1)
            .transition(.opacity)
        case .done:
            Text("done")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.secondary)
                .transition(.opacity)
        case .working, .off:
            if gotIt {
                Text("got it")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .transition(reduceMotion ? .opacity : .asymmetric(insertion: .opacity.combined(with: .offset(y: 3)), removal: .opacity))
            } else {
                IslandShimmer(text: line)
            }
        }
    }

    private var accessibilityText: Text {
        switch phase {
        case .needsYou: return Text("\(bot.name) needs you. \(ask ?? "")")
        case .done: return Text("\(bot.name) is done")
        case .working, .off: return gotIt ? Text("\(bot.name) got it") : Text("\(bot.name): \(line)")
        }
    }

    /// Tapped: a small hop with no burst. Still under reduce motion.
    private func pokeHop() {
        guard !reduceMotion, hop == 0 else { return }
        withAnimation(.easeOut(duration: 0.12)) { hop = -5 }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(0.13))
            withAnimation(V3Motion.bounce) { hop = 0 }
        }
    }

    /// One hop: up, a squash on landing, the burst and one tap as it lands.
    /// Reduce motion keeps the face and the tap and drops the movement.
    private func playDone() {
        guard !reduceMotion else {
            DoneHaptics.shared.land(level: 0)
            return
        }
        withAnimation(.easeOut(duration: 0.16)) { hop = -10; squash = 1.06 }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(DoneMoments.landsAt - 0.08))
            withAnimation(V3Motion.snap) { hop = 0; squash = 0.86 }
            burst += 1
            DoneHaptics.shared.land(level: 0)
            try? await Task.sleep(for: .seconds(0.12))
            withAnimation(V3Motion.bounce) { squash = 1 }
        }
    }
}

/// The mascot's identity across the header and the island. Off under
/// reduce motion, so the two places fade instead of the face travelling.
struct MatchedMascot: ViewModifier {
    let namespace: Namespace.ID?

    func body(content: Content) -> some View {
        if let namespace {
            content.matchedGeometryEffect(id: IslandMascotID.face, in: namespace)
        } else {
            content
        }
    }
}

/// The activity line with a light sweeping across it. A soft solid band,
/// blurred, masks a brighter copy of the text: no gradient. Still under
/// reduce motion.
struct IslandShimmer: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width: CGFloat = 0
    @State private var sweep: CGFloat = 0

    var body: some View {
        base
            .foregroundStyle(Color.secondary)
            .overlay(alignment: .leading) {
                if !reduceMotion, width > 0 {
                    base
                        .foregroundStyle(Color.primary)
                        .mask(alignment: .leading) {
                            Rectangle()
                                .frame(width: 34)
                                .blur(radius: 9)
                                .offset(x: -50 + sweep * (width + 100))
                        }
                        .allowsHitTesting(false)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .id(text)
            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 3)), removal: .opacity))
            .onAppear(perform: start)
            .onChange(of: reduceMotion) { _, _ in start() }
    }

    private var base: some View {
        Text(verbatim: text)
            .font(.system(size: 13, weight: .medium))
            .lineLimit(1)
    }

    private func start() {
        var reset = Transaction()
        reset.disablesAnimations = true
        withTransaction(reset) { sweep = 0 }
        guard !reduceMotion else { return }
        withAnimation(.linear(duration: 1.5).delay(0.5).repeatForever(autoreverses: false)) { sweep = 1 }
    }
}
