// 3.0 thread worker: while a turn runs the bot stands at the end of the
// thread, where the person is already looking, instead of a status line up
// in the header. It wears the face of what it is doing, says the step it is
// on with a timer and a step count, shows the last few finished steps with
// ticks in its own colour, perks up with a "!" when words arrive mid-turn,
// winks once it has read them, digs in on a long quiet job (with a stop),
// and hops once before it walks home.
//
// A port of the desktop's src/components/v3/ThreadWorker.tsx. Which line,
// face and beat it shows is decided in CompanionCore (ThreadWorker.swift);
// this file only draws. Nothing here runs unless `CompanionState.v3` is on.
//
// Motion is transform/opacity only and stops under reduce motion.
import CompanionCore
import SwiftUI

struct ThreadWorkerRow: View {
    let bot: Bot
    /// working, needsYou or done (the done beat is the celebration).
    let phase: LiveIslandState.Phase
    /// What it is doing now, from `LiveActivityLine`.
    let label: String
    /// The pending card's question, while it needs you.
    let ask: String?
    /// The face its tool gives it; a reaction or a beat can override it.
    let face: MausState
    /// When the turn began, ms.
    let since: Double?
    /// The running turn's tool steps.
    let steps: [Message]
    /// Stable per turn: seeds which line and face it picks.
    let turnKey: String
    /// The newest mid-turn send and whether it has been read.
    let steerId: String?
    let steerRead: SteerRead?
    /// When anything last happened in the turn, ms.
    let lastNews: Double?
    /// False while the mascot is elsewhere (the empty thread's mascot on its
    /// way up): its seat holds a dashed ring until it arrives.
    let holdsMascot: Bool
    let onAsk: () -> Void
    let onStop: (() -> Void)?
    let stopping: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var reactions: ThreadWorker.Reactions
    @State private var reaction: ThreadWorker.Reaction?
    @State private var now = Date()
    /// The newest finished step when the row appeared: only a later one pops.
    @State private var firstDone: String?
    @State private var hop: CGFloat = 0
    @State private var squash: CGFloat = 1
    @State private var burst = 0
    @State private var bob = false

    init(bot: Bot, phase: LiveIslandState.Phase, label: String, ask: String?, face: MausState,
         since: Double?, steps: [Message], turnKey: String, steerId: String?, steerRead: SteerRead?,
         lastNews: Double?, holdsMascot: Bool, onAsk: @escaping () -> Void,
         onStop: (() -> Void)?, stopping: Bool) {
        self.bot = bot; self.phase = phase; self.label = label; self.ask = ask; self.face = face
        self.since = since; self.steps = steps; self.turnKey = turnKey
        self.steerId = steerId; self.steerRead = steerRead; self.lastNews = lastNews
        self.holdsMascot = holdsMascot; self.onAsk = onAsk; self.onStop = onStop; self.stopping = stopping
        // whatever was already sent when the row appeared is old news
        _reactions = State(initialValue: ThreadWorker.Reactions(oldNews: steerId))
        _firstDone = State(initialValue: ThreadWorker.doneTrail(steps).last?.id)
    }

    private var finishing: Bool { phase == .done }
    private var needsYou: Bool { phase == .needsYou }
    private var working: Bool { !finishing && !needsYou }
    private var slow: Bool {
        ThreadWorker.isSlow(now: now.timeIntervalSince1970 * 1000, lastNews: lastNews,
                            finishing: finishing, needsYou: needsYou)
    }

    /// Fills: the bot's own colour.
    private var color: Color { MausPalette.color(bot.color) }
    /// Lines and ticks: the bot's colour where it reads on this background.
    private var accent: Color { GlyphMark.colors(bot.color, scheme: scheme).accent }

    var body: some View {
        let trail = ThreadWorker.doneTrail(steps)
        let slow = self.slow
        let glyph = ThreadWorker.face(finishing: finishing, stepCount: steps.count, turnKey: turnKey,
                                      reaction: reaction, needsYou: needsYou, slow: slow)
        let say = ThreadWorker.say(finishing: finishing, turnKey: turnKey, reaction: reaction)
        HStack(alignment: .top, spacing: 12) {
            seat(glyph: glyph, slow: slow)
            VStack(alignment: .leading, spacing: 5) {
                headline(say: say)
                if !finishing, !trail.isEmpty { trailRow(trail) }
                if slow { slowNote }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 4).padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("v3-thread-worker")
        .animation(reduceMotion ? V3Motion.fade : V3Motion.snap, value: reaction)
        .animation(V3Motion.glide, value: phase)
        .animation(V3Motion.glide, value: slow)
        .animation(V3Motion.glide, value: trail.map(\.id))
        .onChange(of: SteerKey(id: steerId, read: steerRead), initial: true) { _, next in
            guard let fresh = reactions.note(id: next.id, read: next.read) else { return }
            reaction = fresh
            if fresh.kind == .noticed { Haptics.selection() }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(fresh.holdSeconds))
                if reaction == fresh { reaction = nil }
            }
        }
        .onChange(of: phase, initial: true) { _, next in
            if next == .done { playDone() }
        }
        // a quiet clock for "still on it": coarse, not every frame
        .task(id: finishing) {
            guard !finishing else { return }
            while !Task.isCancelled {
                now = Date()
                try? await Task.sleep(for: .seconds(ThreadWorker.clockSeconds))
            }
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { bob = true }
        }
    }

    // MARK: - The bot

    private func seat(glyph: GlyphFaceState?, slow: Bool) -> some View {
        ZStack {
            if holdsMascot {
                WorkerHalo(color: color, period: slow ? 4.2 : 2.6, still: reduceMotion)
                if working, !reduceMotion {
                    WorkerOrbit(color: color, period: slow ? 5.5 : 2.8)
                        .id(slow)
                        .transition(.opacity)
                }
                BotAvatarView(bot: bot, size: 40, state: finishing ? .celebrate : face, animated: true, glyph: glyph)
                    .scaleEffect(x: 2 - squash, y: squash, anchor: .bottom)
                    .scaleEffect(reaction?.kind == .noticed && !reduceMotion ? 1.08 : 1, anchor: .bottom)
                    .rotationEffect(.degrees(reaction?.kind == .read && !reduceMotion ? -5 : 0), anchor: .bottom)
                    .offset(y: hop + (working && reaction == nil && bob ? -2 : 0)
                            + (reaction?.kind == .noticed && !reduceMotion ? -3 : 0))
                    .background {
                        if burst > 0 {
                            DoneBurst(color: color, level: 0)
                                .frame(width: 92, height: 92)
                                .id(burst)
                        }
                    }
                    .transition(.opacity)
                if reaction?.kind == .noticed {
                    Text(verbatim: "!")
                        .font(.system(size: 16, weight: .black, design: .rounded))
                        .foregroundStyle(accent)
                        .offset(x: 20, y: -18)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.3, anchor: .bottom).combined(with: .opacity))
                }
            } else {
                // its seat, while it is out
                Circle()
                    .strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .frame(width: 28, height: 28)
                    .transition(.opacity)
            }
        }
        .frame(width: 48, height: 48)
        .accessibilityHidden(true)
    }

    // MARK: - What it says

    @ViewBuilder private func headline(say: String?) -> some View {
        HStack(spacing: 8) {
            Group {
                if needsYou {
                    Button(action: onAsk) {
                        HStack(spacing: 6) {
                            Text("needs you").font(.system(size: 14, weight: .semibold)).foregroundStyle(accent)
                            if let ask {
                                Text(verbatim: ask).font(.system(size: 13)).foregroundStyle(Color.secondary)
                            }
                        }
                        .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Shows the question"))
                } else if let say {
                    Text(verbatim: say)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Capsule().fill(color.opacity(0.16)))
                        .overlay(Capsule().strokeBorder(color.opacity(0.4), lineWidth: 1))
                        .id(say)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.85, anchor: .leading).combined(with: .opacity))
                        .accessibilityIdentifier("v3-worker-say")
                } else {
                    GPTShimmer(text: label, size: 14)
                        .lineLimit(1)
                        .id(label)
                        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 3)), removal: .opacity))
                }
            }
            Spacer(minLength: 4)
            if !finishing {
                HStack(spacing: 6) {
                    if let since {
                        let start = Date(timeIntervalSince1970: since / 1000)
                        TimelineView(.periodic(from: start, by: 1)) { context in
                            Text(elapsedLabel(max(0, Int(context.date.timeIntervalSince(start)))))
                                .font(.system(size: 12).monospacedDigit())
                                .foregroundStyle(Color.secondary.opacity(0.75))
                        }
                    }
                    if !steps.isEmpty {
                        Text(verbatim: ThreadWorker.stepCount(steps.count))
                            .font(.system(size: 11.5, weight: .medium).monospacedDigit())
                            .foregroundStyle(accent)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Capsule().fill(color.opacity(0.14)))
                            .id(steps.count)
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.8).combined(with: .opacity))
                            .accessibilityIdentifier("v3-worker-steps")
                    }
                }
                .fixedSize()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func trailRow(_ trail: [Message]) -> some View {
        let newest = trail.last?.id
        let fresh = newest != nil && newest != firstDone
        return VStack(alignment: .leading, spacing: 3) {
            ForEach(trail, id: \.id) { step in
                HStack(spacing: 5) {
                    WorkerTick(color: accent, pops: fresh && step.id == newest, still: reduceMotion)
                        .opacity(step.tool?.ok == false ? 0.5 : 1)
                    Text(verbatim: LiveActivityLine.stepLabel(for: step))
                        .font(.system(size: 12.5))
                        .foregroundStyle(Color.secondary.opacity(0.8))
                        .lineLimit(1)
                }
                .transition(.opacity.combined(with: .offset(y: 3)))
            }
        }
        .accessibilityIdentifier("v3-worker-trail")
    }

    private var slowNote: some View {
        HStack(spacing: 8) {
            Text(verbatim: ThreadWorker.slowLine(turnKey: turnKey))
                .font(.system(size: 13))
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
            if let onStop {
                Button(action: onStop) {
                    HStack(spacing: 4) {
                        if stopping {
                            ProgressView().controlSize(.mini)
                        } else {
                            RoundedRectangle(cornerRadius: 1.5, style: .continuous).frame(width: 8, height: 8)
                        }
                        Text(stopping ? "Stopping" : "Stop")
                    }
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(Capsule().fill(Color.secondary.opacity(0.12)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(stopping)
                .accessibilityIdentifier("v3-worker-stop")
            }
        }
        .padding(.leading, 12).padding(.trailing, onStop == nil ? 12 : 4).padding(.vertical, 4)
        .overlay(Capsule().strokeBorder(color.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .padding(.top, 2)
        .transition(.opacity.combined(with: .offset(y: 4)))
        .accessibilityIdentifier("v3-worker-slow")
    }

    // MARK: - Beats

    /// One hop: up, a squash on landing, the burst and one tap as it lands.
    /// Reduce motion keeps the face and the tap and drops the movement.
    private func playDone() {
        guard !reduceMotion else {
            DoneHaptics.shared.land(level: 0)
            return
        }
        withAnimation(.easeOut(duration: 0.16)) { hop = -12; squash = 1.06 }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(DoneMoments.landsAt - 0.08))
            withAnimation(V3Motion.snap) { hop = 0; squash = 0.86 }
            burst += 1
            DoneHaptics.shared.land(level: 0)
            try? await Task.sleep(for: .seconds(0.12))
            withAnimation(V3Motion.bounce) { squash = 1 }
        }
    }

    private struct SteerKey: Equatable {
        var id: String?
        var read: SteerRead?
    }
}

/// A soft disc of the bot's colour that breathes behind it.
private struct WorkerHalo: View {
    let color: Color
    let period: Double
    let still: Bool
    @State private var out = false

    var body: some View {
        Circle()
            .fill(color.opacity(0.18))
            .frame(width: 46, height: 46)
            .blur(radius: 6)
            .scaleEffect(out ? 1.08 : 0.9)
            .opacity(out ? 0.55 : 0.9)
            .id(period)
            .onAppear {
                guard !still else { return }
                withAnimation(.easeInOut(duration: period / 2).repeatForever(autoreverses: true)) { out = true }
            }
    }
}

/// One dot of the bot's colour circling it while it works.
private struct WorkerOrbit: View {
    let color: Color
    let period: Double
    @State private var turn = 0.0

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 5, height: 5)
            .offset(y: -23)
            .rotationEffect(.degrees(turn))
            .frame(width: 48, height: 48)
            .onAppear {
                withAnimation(.linear(duration: period).repeatForever(autoreverses: false)) { turn = 360 }
            }
    }
}

/// A finished step's tick; the one that just finished pops once.
private struct WorkerTick: View {
    let color: Color
    let pops: Bool
    let still: Bool
    @State private var scale: CGFloat = 1

    var body: some View {
        Image(systemName: "checkmark")
            .font(.system(size: 10, weight: .heavy))
            .foregroundStyle(color)
            .scaleEffect(scale)
            .frame(width: 12)
            .onAppear(perform: pop)
            .onChange(of: pops) { _, _ in pop() }
    }

    private func pop() {
        guard pops, !still else { return }
        scale = 0.3
        withAnimation(V3Motion.bounce) { scale = 1 }
    }
}

/// The line under a send made while the bot works: waiting for it, then read.
struct SteerReadLabel: View {
    let read: SteerRead
    let name: String
    let color: String
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch read {
            case .read:
                HStack(spacing: 4) {
                    WorkerTick(color: GlyphMark.colors(color, scheme: scheme).accent, pops: true, still: reduceMotion)
                    Text("\(name) read this")
                }
                .accessibilityIdentifier("v3-steer-read")
            case .waiting:
                HStack(spacing: 5) {
                    SteerSpinner(color: MausPalette.color(color), still: reduceMotion)
                    Text("waiting for \(name)")
                }
                .accessibilityIdentifier("v3-steer-waiting")
                .accessibilityHint(Text("\(name) sees this after the step it's on"))
            }
        }
        .font(.caption)
        .foregroundStyle(Color.secondary)
        .id(read)
        .transition(.opacity)
    }
}

/// A small ring with a gap in the bot's colour, turning while it waits.
private struct SteerSpinner: View {
    let color: Color
    let still: Bool
    @State private var turn = 0.0

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.72)
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: 10, height: 10)
            .rotationEffect(.degrees(turn))
            .onAppear {
                guard !still else { return }
                withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turn = 360 }
            }
    }
}

/// 3.0 header pill while the worker shows: the bot's name, and a breathing
/// dot in its colour while it works, or "needs you". The face is at the end
/// of the thread now, so the header carries none.
struct ThreadWorkerHeaderPill: View {
    let bot: Bot
    let needsYou: Bool
    let nameColor: Color?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var breathe = false

    var body: some View {
        HStack(spacing: 7) {
            Text(verbatim: bot.name)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(nameColor ?? Color.primary)
                .lineLimit(1)
            if needsYou {
                Text("needs you")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(GlyphMark.colors(bot.color, scheme: scheme).accent)
                    .lineLimit(1)
                    .transition(.opacity)
            } else {
                Circle()
                    .fill(MausPalette.color(bot.color))
                    .frame(width: 7, height: 7)
                    .scaleEffect(breathe ? 1 : 0.7)
                    .opacity(breathe ? 1 : 0.55)
                    .transition(.opacity)
                    .onAppear {
                        guard !reduceMotion else { return }
                        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { breathe = true }
                    }
            }
        }
        .frame(maxWidth: 230)
        .animation(V3Motion.glide, value: needsYou)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(needsYou ? Text("\(bot.name) needs you") : Text("\(bot.name) is working"))
        .accessibilityIdentifier("v3-pill")
    }
}
