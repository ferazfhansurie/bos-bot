// The live card's drawing, shared by the widget extension (the lock screen,
// the island, CarPlay) and the app (DEBUG snapshots of every state).
//
// Calm liquid glass: dark glass, one accent per state, the bot's own face.
// The bot's colour marks the bot and its working ring; amber is "needs you";
// a closed ring and a green "Call me" is done.
//
// The ring is the job: one segment per plan step, filled as steps finish,
// with the current step's arc sweeping on its own between updates (a
// timer-driven ProgressView, the one motion iOS keeps animating). Without a
// plan it is the sweep alone.
import AppIntents
import CompanionCore
import SwiftUI

/// What a card draws: the bot and its current state.
struct LiveCard {
    let attributes: BotActivityAttributes
    let state: BotActivityContent

    var botColor: Color { MausPalette.color(attributes.color) }

    /// The state's colour: amber when it needs you, else the bot's.
    var accent: Color { state.needsYou ? LiveCardColor.amber : botColor }

    var link: URL? { BotActivityLink.thread(botId: attributes.botId, threadId: state.threadId) }

    var isCall: Bool { state.kind == "call" }
    var isLive: Bool { state.isWorking || isCall }

    var status: String {
        if isCall { return "on a call" }
        if state.isDone { return "done" }
        if state.needsYou { return "needs you" }
        return "working"
    }

    /// One clock for the whole job.
    var clock: ClosedRange<Date> { state.clockStart...state.clockStart.addingTimeInterval(86_400) }

    var finishedIn: String {
        elapsedLabel(Int((state.endedAt ?? Date()).timeIntervalSince(state.clockStart)))
    }

    /// "3/5", for the compact island and the car.
    var fraction: String? { state.plan.map { "\($0.index)/\($0.count)" } }

    /// The job's name, or the bot's when it has none.
    var title: String { state.threadTitle ?? "\(attributes.name)'s job" }

    /// The line under the title: the ask, the step, or the result.
    var line: String { state.isDone ? (state.result ?? state.line) : state.line }

    var symbol: String {
        if state.isDone { return "checkmark" }
        if state.needsYou { return "hand.raised.fill" }
        return state.symbol ?? "gearshape"
    }
}

enum LiveCardColor {
    static let amber = Color(red: 1.0, green: 0.76, blue: 0.29)
    static let green = Color(red: 0.33, green: 0.86, blue: 0.52)
    static let stop = Color(red: 1.0, green: 0.42, blue: 0.40)
}

/// The face inside its job ring.
struct LiveCardFace: View {
    let card: LiveCard
    let size: CGFloat

    var body: some View {
        let ring = max(2, size * 0.065)
        ZStack {
            JobRing(card: card, lineWidth: ring)
            MausFaceStill(
                color: card.attributes.color,
                state: MausState(rawValue: card.state.face) ?? .idle,
                size: size * 0.62,
                bodyId: card.attributes.mascotBody,
                eyeStyle: MascotEyeStyle(stored: card.attributes.mascotEyes),
                comets: card.isLive && size > 30,
                at: Date()
            )
            .frame(width: size * 0.62, height: size * 0.62)
            // a new face pops in on a spring each time the state changes
            .id(card.state.face)
            .transition(.scale(scale: 0.7).combined(with: .opacity))
            .animation(.spring(duration: 0.5, bounce: 0.45), value: card.state.face)
            .accessibilityLabel("\(card.attributes.name) avatar")
        }
        .frame(width: size + ring * 2, height: size + ring * 2)
    }
}

/// Plan segments around the face, and the current step's sweep inside them.
struct JobRing: View {
    let card: LiveCard
    let lineWidth: CGFloat
    @Environment(\.liveCardSnapshot) private var snapshot

    /// How long the sweep takes to go round once; a long step holds full.
    private static let sweep: TimeInterval = 60

    var body: some View {
        let state = card.state
        ZStack {
            if let plan = state.plan {
                PlanSegments(index: plan.index, count: plan.count, color: card.accent, lineWidth: lineWidth,
                             done: state.isDone, current: state.needsYou ? 1 : 0.45)
            } else {
                Circle().stroke(state.isDone || state.needsYou ? card.accent.opacity(state.isDone ? 0.7 : 1) : .white.opacity(0.12),
                                lineWidth: lineWidth)
            }
            if card.isLive && snapshot {
                // ImageRenderer cannot draw the system's timer ring
                let start = state.stepSince ?? state.clockStart
                Circle()
                    .trim(from: 0, to: min(1, max(0.04, Date().timeIntervalSince(start) / Self.sweep)))
                    .stroke(card.accent.opacity(0.9), style: StrokeStyle(lineWidth: lineWidth * 0.8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(state.plan == nil ? 0 : lineWidth * 1.9)
            } else if card.isLive {
                let start = state.stepSince ?? state.clockStart
                ProgressView(timerInterval: start...start.addingTimeInterval(Self.sweep), countsDown: false) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(card.accent.opacity(0.9))
                .padding(state.plan == nil ? 0 : lineWidth * 1.6)
            }
        }
    }

}

/// "cash · working · step 3 of 5", and the job's clock at the end.
struct LiveCardStatus: View {
    let card: LiveCard
    var showsClock = true
    var showsOthers = false
    /// The island's narrow centre: "3/5" instead of "step 3 of 5".
    var compact = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(card.attributes.name)
                .foregroundStyle(.white.opacity(0.92))
            Text("·").foregroundStyle(.white.opacity(0.32))
            Text(card.status)
                .foregroundStyle(card.state.isWorking ? .white.opacity(0.6) : card.accent)
            // the plan only while it works; asking or done, the line says it
            if let plan = card.state.isWorking ? (compact ? card.fraction : card.state.planLabel) : nil {
                Text("·").foregroundStyle(.white.opacity(0.32))
                Text(plan)
                    .foregroundStyle(.white.opacity(0.6))
                    .contentTransition(.numericText())
            }
            if showsOthers, let more = card.state.otherThreads, more > 0 {
                Text("+\(more)").foregroundStyle(.white.opacity(0.4))
            }
            if showsClock {
                Spacer(minLength: 6)
                LiveCardClock(card: card)
            }
        }
        .font(.system(size: 13, weight: .semibold))
        .lineLimit(1)
    }
}

/// The whole job's time, ticking by itself; fixed once done.
struct LiveCardClock: View {
    let card: LiveCard

    var body: some View {
        if card.state.isDone {
            Text(card.finishedIn)
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.5))
        } else {
            Text(timerInterval: card.clock, countsDown: false)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 58, alignment: .trailing)
                .foregroundStyle(card.state.needsYou ? card.accent : .white.opacity(0.62))
        }
    }
}

/// What it is doing now, the ask, or the result; a new step slides in.
struct LiveCardStep: View {
    let card: LiveCard
    var lines = 1
    var size: CGFloat = 14

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: card.symbol)
                .font(.system(size: size - 3, weight: .semibold))
                .foregroundStyle(card.state.isWorking ? .white.opacity(0.55) : card.accent)
                .frame(width: size)
            Text(card.line)
                .font(.system(size: size, weight: card.state.needsYou ? .medium : .regular))
                .foregroundStyle(.white.opacity(card.state.isWorking ? 0.72 : 0.88))
                .lineLimit(lines)
        }
        .id(card.line)
        .transition(.push(from: .bottom))
    }
}

/// Peek: the plan step in progress and the last few steps, for a moment.
struct LiveCardPeek: View {
    let card: LiveCard

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let step = card.state.planStep {
                Text("now: \(step)")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(card.accent)
                    .lineLimit(1)
            }
            ForEach(Array((card.state.recent ?? []).suffix(3).enumerated()), id: \.offset) { _, line in
                HStack(spacing: 6) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white.opacity(0.45))
                    Text(line)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white.opacity(0.1), lineWidth: 0.5))
    }
}

/// The card's buttons for its state (`BotActivityContent.buttons`).
struct LiveCardButtons: View {
    let card: LiveCard
    var expanded = false

    var body: some View {
        let buttons = card.state.buttons(expanded: expanded)
        HStack(spacing: 8) {
            ForEach(buttons, id: \.self) { button in
                self.button(button)
            }
        }
    }

    @ViewBuilder
    private func button(_ kind: LiveCardButton) -> some View {
        let state = card.state
        let open = card.link ?? URL(string: "bosbot://")!
        switch kind {
        case .peek:
            Button(intent: PeekBotIntent(botId: card.attributes.botId)) {
                LiveGlassPill(title: "Peek", systemImage: "eye")
            }
            .buttonStyle(.plain)
        case .open:
            Link(destination: open) { LiveGlassPill(title: "Open", systemImage: "arrow.up.right") }
        case .stop:
            Button(intent: StopBotIntent(botId: card.attributes.botId, threadId: state.threadId ?? "")) {
                LiveGlassPill(title: "Stop", systemImage: "stop.fill", ink: LiveCardColor.stop)
            }
            .buttonStyle(.plain)
        case let .approve(choice):
            if let threadId = state.approvalThreadId, let requestId = state.requestId {
                Button(intent: AnswerApprovalIntent(threadId: threadId, requestId: requestId, choice: choice,
                                                    isPermission: state.isPermission)) {
                    LiveGlassPill(title: Self.approveLabel(choice), systemImage: "checkmark", fill: LiveCardColor.amber)
                }
                .buttonStyle(.plain)
            }
        case .openApproval:
            Link(destination: open) {
                LiveGlassPill(title: "Approve", systemImage: "arrow.up.right", fill: LiveCardColor.amber)
            }
        case .reply:
            Link(destination: open) { LiveGlassPill(title: "Reply", systemImage: "arrowshape.turn.up.left") }
        case .callMe:
            Link(destination: BotActivityLink.callBack(botId: card.attributes.botId, threadId: state.threadId,
                                                       result: card.line) ?? open) {
                LiveGlassPill(title: "Call me", systemImage: "phone.fill", fill: LiveCardColor.green)
            }
        }
    }

    private static func approveLabel(_ choice: String) -> String {
        ["allow", "allow once", "approve", "yes", "ok"].contains(choice.lowercased()) ? "Approve" : choice
    }
}

/// A glass pill; filled with a state colour for the one button that matters.
struct LiveGlassPill: View {
    let title: String
    let systemImage: String
    var fill: Color? = nil
    var ink: Color? = nil

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.system(size: 13, weight: .semibold))
            .labelStyle(.titleAndIcon)
            .foregroundStyle(fill == nil ? (ink ?? .white.opacity(0.92)) : .black.opacity(0.85))
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .frame(height: 34)
            .background(
                Capsule().fill(fill.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.white.opacity(0.13)))
            )
            .overlay(
                Capsule().strokeBorder(
                    LinearGradient(colors: [.white.opacity(fill == nil ? 0.28 : 0.4), .white.opacity(0.04)],
                                   startPoint: .top, endPoint: .bottom),
                    lineWidth: 0.6
                )
            )
    }
}

/// The soft glow of the state's colour behind the glass.
struct LiveCardGlow: View {
    let card: LiveCard

    var body: some View {
        ZStack {
            RadialGradient(colors: [card.accent.opacity(card.state.needsYou ? 0.30 : 0.20), .clear],
                           center: .topLeading, startRadius: 0, endRadius: 220)
            RadialGradient(colors: [card.botColor.opacity(0.10), .clear],
                           center: .bottomTrailing, startRadius: 0, endRadius: 200)
        }
    }
}

/// The lock screen card (and StandBy, which shows it full size).
struct LiveLockCard: View {
    let card: LiveCard

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .center, spacing: 12) {
                LiveCardFace(card: card, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    LiveCardStatus(card: card)
                    Text(card.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    LiveCardStep(card: card, lines: card.state.isDone || card.state.needsYou ? 2 : 1)
                }
            }
            if card.state.isPeeking() { LiveCardPeek(card: card) }
            LiveCardButtons(card: card)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(LiveCardGlow(card: card))
    }
}

/// CarPlay and the watch: the job's title and its step, nothing to tap.
/// The bot's name and clock on top; a live call's phase replaces the title.
struct LiveCarCard: View {
    let card: LiveCard

    var body: some View {
        let state = card.state
        let onCall = state.call != nil
        HStack(alignment: .center, spacing: 10) {
            LiveCardFace(card: card, size: 48)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(card.attributes.name)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                    if let fraction = card.fraction, !state.isDone, !onCall {
                        Text(fraction)
                            .font(.system(size: 13, weight: .semibold).monospacedDigit())
                            .foregroundStyle(.white.opacity(0.55))
                    }
                    Spacer(minLength: 4)
                    LiveCarClock(card: card)
                        .font(.system(size: 13, weight: .semibold).monospacedDigit())
                }
                Text(onCall ? CarGlance.stateWord(state) : card.title)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(state.needsYou || onCall ? card.accent : .white)
                    .contentTransition(.opacity)
                Text(onCall ? (CarGlance.shortTitle(state.threadTitle) ?? card.line) : card.line)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.78))
                if let summary = state.summary {
                    Text(summary)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.55))
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
}

/// The car's clock: the call's while one is live, else the job's; fixed
/// once done.
struct LiveCarClock: View {
    let card: LiveCard

    var body: some View {
        let state = card.state
        if state.isDone && state.call == nil {
            Text(card.finishedIn).foregroundStyle(.white.opacity(0.6))
        } else {
            let since = CarGlance.since(state)
            Text(timerInterval: since...since.addingTimeInterval(86_400), countsDown: false)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 60, alignment: .trailing)
                .foregroundStyle(state.needsYou ? card.accent : .white.opacity(0.7))
        }
    }
}

/// The expanded island's bottom: the step, the peek, the buttons (with Stop).
struct LiveIslandBottom: View {
    let card: LiveCard

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            LiveCardStep(card: card, lines: 2)
            if card.state.isPeeking() { LiveCardPeek(card: card) }
            LiveCardButtons(card: card, expanded: true)
        }
    }
}

extension EnvironmentValues {
    /// Drawing for a DEBUG snapshot, not the system: no timer views.
    @Entry var liveCardSnapshot = false
}

/// The plan as ring segments: finished steps solid, the current one half,
/// the rest faint. Shared by the live card and the home widgets.
struct PlanSegments: View {
    let index: Int
    let count: Int
    let color: Color
    let lineWidth: CGFloat
    var done = false
    var current: Double = 0.45

    var body: some View {
        let gap = count > 8 ? 0.012 : 0.028
        ZStack {
            ForEach(0..<count, id: \.self) { step in
                Circle()
                    .trim(from: Double(step) / Double(count) + gap / 2, to: Double(step + 1) / Double(count) - gap / 2)
                    .stroke(done || step < index - 1 ? color : step == index - 1 ? color.opacity(current) : .white.opacity(0.14),
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
        }
    }
}
