// A bot's working-out, as steps.
//
// Modelled on the AIOS app's activity rows, which got this right: a run of
// tool calls is ONE quiet line — "read 3 files", a status, a chevron — and
// the detail is a tap away rather than four purple receipts stacked in the
// middle of a conversation. The line is legible at a glance while the turn
// is still running (the status reads "live"), and the sheet behind it has
// the input and the output of every step.
//
// `ActivityRunChip` is the folded run; `ToolStepRow` is one step, used both
// for an unfolded single chip in the transcript and for the rows inside the
// sheet.
import SwiftUI
import CompanionCore

struct ActivityRunChip: View {
    let items: [Message]
    /// Where an "Opened thread" chip inside the run goes once unfolded.
    var openThread: ((ThreadRef) -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingDetail = false

    private var steps: [ToolStep] { items.map(toolStep(from:)) }
    private var status: ToolStep.Status { activityStatus(steps) }
    private var summary: String { activitySummary(steps) }

    var body: some View {
        Button {
            Haptics.selection()
            showingDetail = true
        } label: {
            ActivityDisclosureRow(
                symbol: steps.first?.symbol ?? "wrench.and.screwdriver",
                label: summary,
                status: status,
                count: steps.count
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary)
        .accessibilityHint("Shows what ran")
        .sheet(isPresented: $showingDetail) {
            ActivityDetailSheet(title: summary, items: items, openThread: openThread)
        }
    }
}

/// The 44-point line itself: glyph, what happened, how it went.
struct ActivityDisclosureRow: View {
    let symbol: String
    let label: String
    let status: ToolStep.Status
    var count: Int = 1
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let isDark = colorScheme == .dark
        HStack(spacing: 9) {
            Image(systemName: symbol)
                .font(.system(size: 11.5))
                .foregroundStyle(Color.secondary)
                .frame(width: 14)

            Text(label)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(isDark ? Color(hex: "#B8B8B8") : Color(hex: "#5A5A5A"))
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 6)

            StepStatusBadge(status: status)

            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Color.secondary.opacity(0.6))
        }
        .padding(.horizontal, 11)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// working / done / didn't work. A step that did not work mid-turn is
/// normal — the bot reads the error and tries another way — so it is drawn
/// in the same quiet gray as everything else, never in alarm red.
struct StepStatusBadge: View {
    let status: ToolStep.Status
    var showsLabel = true

    static func color(_ status: ToolStep.Status) -> Color {
        switch status {
        case .failed: Color.secondary.opacity(0.75)
        case .running: Color(hex: "#FF8A3D")
        case .ok: Color(hex: "#49C785")
        }
    }

    static func word(_ status: ToolStep.Status) -> String {
        switch status {
        case .running: "working"
        case .ok: "done"
        case .failed: "didn't work"
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            Group {
                switch status {
                case .running:
                    WorkingDots(color: Self.color(status))
                case .ok:
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Self.color(status))
                case .failed:
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(Self.color(status))
                }
            }
            // the desktop's settle: a landed step's mark springs in where
            // the dots were, rather than snapping
            .transition(.scale(scale: 0.4).combined(with: .opacity))
            .id(status)
            if showsLabel {
                Text(Self.word(status))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Self.color(status))
                    .contentTransition(.opacity)
            }
        }
        .animation(.spring(response: 0.32, dampingFraction: 0.62), value: status)
    }
}

/// The desktop's WorkingDots: three dots stepping through opacity holds,
/// 200ms apart. Driven by a timeline rather than a repeatForever animation,
/// which a transcript redraw silently cancels — the "static orange dot".
struct WorkingDots: View {
    var color: Color = Color(hex: "#FF8A3D")
    var size: CGFloat = 4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            dots { _ in 0.6 }
        } else {
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                dots { index in
                    // status-pulse: 1.6s cycle, bright at 30%, dim otherwise
                    let phase = ((t - Double(index) * 0.2).truncatingRemainder(dividingBy: 1.6) + 1.6)
                        .truncatingRemainder(dividingBy: 1.6) / 1.6
                    return phase < 0.3 ? 0.25 + 0.75 * (phase / 0.3)
                        : phase < 0.6 ? 1 - 0.75 * ((phase - 0.3) / 0.3) : 0.25
                }
            }
        }
    }

    private func dots(_ opacity: @escaping (Int) -> Double) -> some View {
        HStack(spacing: size * 0.75) {
            ForEach(0..<3, id: \.self) { index in
                Circle().fill(color).frame(width: size, height: size).opacity(opacity(index))
            }
        }
        .accessibilityHidden(true)
    }
}

/// Kept for the callers that want one dot; it now breathes off a timeline
/// so a redraw cannot freeze it.
struct PulsingDot: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            Circle().fill(color).frame(width: 6, height: 6).opacity(0.7)
        } else {
            TimelineView(.periodic(from: .now, by: 0.05)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                    .opacity(0.35 + 0.65 * (0.5 + 0.5 * sin(t * .pi / 0.7)))
            }
        }
    }
}

/// The desktop's thinking shimmer: the working line's text in the quiet
/// gray, with a brighter band sweeping across it every two seconds. Keyed
/// by its text so a new step slides up and crossfades in (status-swap)
/// instead of the words snapping.
struct ShimmerLabel: View {
    let text: String
    var size: CGFloat = 12.5
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var base: Color { colorScheme == .dark ? Color(hex: "#8A8A8A") : Color(hex: "#7A7A7A") }
    private var bright: Color { colorScheme == .dark ? Color(hex: "#F2F2F2") : Color(hex: "#1A1A1A") }

    var body: some View {
        Group {
            if reduceMotion {
                label.foregroundStyle(base)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    let p = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) / 2
                    // the band runs from just off the left edge to just off the right
                    let x = -0.6 + p * 2.2
                    label.foregroundStyle(
                        LinearGradient(
                            stops: [
                                .init(color: base, location: 0),
                                .init(color: base, location: max(0, x - 0.18)),
                                .init(color: bright, location: min(1, max(0, x))),
                                .init(color: base, location: min(1, x + 0.18)),
                                .init(color: base, location: 1),
                            ].sorted { $0.location < $1.location },
                            startPoint: .leading, endPoint: .trailing
                        )
                    )
                }
            }
        }
        .id(text)
        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 3)), removal: .opacity))
    }

    private var label: Text {
        Text(text).font(.system(size: size, weight: .medium))
    }
}

/// One step: the verb, what it acted on, and — on a tap — its input and
/// whatever the harness captured of its result.
struct ToolStepRow: View {
    let step: ToolStep
    /// The thread this step opened, when it opened one.
    var threadRef: ThreadRef? = nil
    var openThread: ((ThreadRef) -> Void)? = nil
    var dimmed = false
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = false

    private var hasDetail: Bool {
        !(step.input ?? "").isEmpty || !(step.output ?? "").isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                if let threadRef, let openThread {
                    Haptics.selection()
                    openThread(threadRef)
                    return
                }
                guard hasDetail else { return }
                withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) { expanded.toggle() }
                Haptics.selection()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: threadRef == nil ? step.symbol : "arrow.up.right.square")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.secondary)
                        .frame(width: 14)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(step.isTool ? step.label : step.name)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(labelColor)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if step.status == .failed {
                            Text("didn't work, so it tried another way")
                                .font(.system(size: 10.5))
                                .foregroundStyle(Color.secondary.opacity(0.8))
                        }
                    }

                    Spacer(minLength: 6)

                    StepStatusBadge(status: step.status, showsLabel: false)

                    if hasDetail && threadRef == nil {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundStyle(Color.secondary.opacity(0.6))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasDetail && threadRef == nil)

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if let summary = step.summary, !summary.isEmpty, summary != step.input {
                        StepDetailBlock(title: step.verb == "Ran" ? "COMMAND" : "WHAT", text: summary, tint: Color.secondary)
                    }
                    if let input = step.input, !input.isEmpty {
                        StepDetailBlock(title: "INPUT", text: input, tint: Color(hex: "#8B5CF6"))
                    }
                    if let output = step.output, !output.isEmpty {
                        StepDetailBlock(title: step.status == .failed ? "WHAT CAME BACK" : "OUTPUT", text: output, tint: step.status == .failed ? Color.secondary : Color(hex: "#10B981"))
                    }
                }
                .padding(.leading, 22)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .opacity(dimmed ? 0.45 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityValue(StepStatusBadge.word(step.status))
    }

    private var labelColor: Color {
        // a step that did not work reads quieter, not louder
        if step.status == .failed { return Color.secondary }
        return colorScheme == .dark ? Color(hex: "#D4D4D4") : Color(hex: "#3A3A3A")
    }
}

private struct StepDetailBlock: View {
    let title: String
    let text: String
    let tint: Color
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(tint)
            Text(text)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(colorScheme == .dark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(colorScheme == .dark ? Color.black.opacity(0.3) : Color.black.opacity(0.04),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// The run, opened: every step in order, with its detail.
struct ActivityDetailSheet: View {
    let title: String
    let items: [Message]
    var openThread: ((ThreadRef) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    private var steps: [ToolStep] { items.map(toolStep(from:)) }

    private var subtitle: String {
        let status = activityStatus(steps)
        let misses = steps.filter { $0.status == .failed }.count
        let word = status == .running ? "working" : (misses > 0 ? "\(misses) didn't work" : "done")
        guard let first = steps.first, let last = steps.last, steps.count > 1 else {
            return "\(steps.count) step · \(word)"
        }
        let seconds = Int(max(0, last.at - first.at) / 1000)
        return "\(steps.count) steps · \(word) · \(elapsedLabel(seconds))"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, message in
                        ToolStepRow(
                            step: steps[index],
                            threadRef: message.threadRef,
                            openThread: openThread.map { open in
                                { ref in dismiss(); open(ref) }
                            }
                        )
                    }
                }
                .padding(16)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(title)
                            .font(.system(size: 14, weight: .semibold))
                            .lineLimit(1)
                        Text(subtitle)
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// What a turn shows while it is still working — the desktop's
/// TurnPresence: the bot's own mascot moving, the current step as a
/// shimmering line that crossfades when the step changes, the elapsed time,
/// and the last few steps that landed settling in above it.
struct WorkingSteps: View {
    /// The turn's activity so far, oldest first.
    let items: [Message]
    let startedAt: Date
    /// The bot's face, when the row above does not already show it (1:1).
    var avatar: AnyView? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let steps = items.map(toolStep(from:))
        let live = steps.last(where: { $0.status == .running })
        let finished = steps.filter { $0.status != .running }.suffix(3)
        let line = live.map { $0.isTool ? $0.label : $0.name } ?? "Thinking"
        VStack(alignment: .leading, spacing: 6) {
            ForEach(finished) { step in
                ToolStepRow(step: step, dimmed: true)
                    .transition(.opacity.combined(with: .offset(y: 4)))
            }

            HStack(spacing: 8) {
                if let avatar {
                    avatar.transition(.scale(scale: 0.6).combined(with: .opacity))
                } else {
                    WorkingDots()
                }
                ShimmerLabel(text: line)
                    .lineLimit(1)
                WorkingElapsedTime(startedAt: startedAt)
                if steps.count > 1 {
                    Text("· \(steps.count) steps")
                        .font(.system(size: 10.5))
                        .foregroundStyle(Color.secondary.opacity(0.8))
                }
            }
            .animation(reduceMotion ? nil : .spring(response: 0.2, dampingFraction: 0.9), value: line)
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: finished.map(\.id))
        .padding(.vertical, 6)
    }
}

/// Only the clock ticks; it must not reparse every tool output each second.
private struct WorkingElapsedTime: View {
    let startedAt: Date
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(elapsedLabel(max(0, Int(context.date.timeIntervalSince(startedAt)))))
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .monospacedDigit()
        }
    }
}
