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

extension EnvironmentValues {
    /// 3.0: the thread worker stands at the end of this transcript and says
    /// what the bot is doing, so runs and steps above it do not shimmer too.
    @Entry var threadWorkerShows = false
}

struct ActivityRunChip: View {
    let items: [Message]
    /// Where an "Opened thread" chip inside the run goes once unfolded.
    var openThread: ((ThreadRef) -> Void)? = nil
    @State private var expanded = false
    @State private var showingDetail = false
    @Environment(\.threadWorkerShows) private var workerShows

    /// Unfolding inline stops here; the sheet has every step.
    private static let inlineCap = 30

    var body: some View {
        // Built once per body: a long run is hundreds of steps, and the
        // label, status and list each read all of them.
        let steps = items.map(toolStep(from:))
        let label = runLabel(steps)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.selection()
                withAnimation(.snappy(duration: 0.22)) { expanded.toggle() }
            } label: {
                ActivityDisclosureRow(
                    symbol: steps.first?.symbol ?? "wrench.and.screwdriver",
                    label: label,
                    // 3.0: the bot at the end of the thread says what it is
                    // doing, so the run stays its quiet summary
                    status: !workerShows && steps.contains(where: { $0.status == .running }) ? .running : .ok,
                    count: steps.count,
                    expanded: expanded
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityHint(expanded ? "Hides the steps" : "Shows the steps")

            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(items.prefix(Self.inlineCap).enumerated()), id: \.element.id) { index, message in
                        ToolStepRow(step: steps[index], threadRef: message.threadRef, openThread: openThread)
                    }
                    if items.count > Self.inlineCap {
                        Button("Show all \(items.count) steps") { showingDetail = true }
                            .font(.system(size: 12.5, weight: .medium))
                            .padding(.vertical, 4)
                    }
                }
                .padding(.leading, 22)
                .padding(.top, 10)
                .transition(.opacity)
            }
        }
        .sheet(isPresented: $showingDetail) {
            ActivityDetailSheet(title: label, items: items, openThread: openThread)
        }
    }

    /// "read 3 files" when the run did one kind of thing; otherwise what a
    /// long turn actually was: "worked for 4m · 23 steps". Steps that didn't
    /// work are counted, not shouted; the bot usually tried another way.
    private func runLabel(_ steps: [ToolStep]) -> String {
        var label = activitySummary(steps)
        if label == "\(steps.count) steps", let first = steps.first, let last = steps.last {
            let seconds = Int(max(0, last.at - first.at) / 1000)
            if seconds > 0 { label = "worked for \(Self.compactDuration(seconds)) · \(steps.count) steps" }
        }
        let misses = steps.filter { $0.status == .failed }.count
        if misses > 0 { label += " · \(misses) didn't work" }
        return label
    }

    /// "40s", "4m", "1h 12m": a settled run's length, rounded the way a
    /// person would say it.
    static func compactDuration(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3_600 { return "\(seconds / 60)m" }
        let minutes = seconds % 3_600 / 60
        return minutes == 0 ? "\(seconds / 3_600)h" : "\(seconds / 3_600)h \(minutes)m"
    }
}

/// The 44-point line itself: glyph, what happened, how it went.
struct ActivityDisclosureRow: View {
    let symbol: String
    let label: String
    let status: ToolStep.Status
    var count: Int = 1
    /// Kept for callers; ChatGPT's rows carry no chevron.
    var expanded = false

    /// ChatGPT's activity row: a 16pt glyph at 60% ink, the line at 40%,
    /// 6pt apart, one line, truncated.
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(GPT.activityIcon)
                .frame(width: 16)
            if status == .running {
                GPTShimmer(text: label, size: 15).lineLimit(1)
            } else {
                Text(label)
                    .font(.system(size: 15))
                    .foregroundStyle(GPT.activityText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 24)
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
    @Environment(\.threadWorkerShows) private var workerShows
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
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: threadRef == nil ? step.symbol : "arrow.up.right.square")
                        .font(.system(size: 13))
                        .foregroundStyle(GPT.activityIcon)
                        .frame(width: 16)

                    VStack(alignment: .leading, spacing: 1) {
                        if step.status == .running && !workerShows {
                            GPTShimmer(text: step.isTool ? step.label : step.name, size: 15).lineLimit(1)
                        } else {
                            Text(step.isTool ? step.label : step.name)
                                .font(.system(size: 15))
                                .foregroundStyle(GPT.activityText)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .multilineTextAlignment(.leading)
                        }
                        if step.status == .failed {
                            Text("didn't work, so it tried another way")
                                .font(.system(size: 13))
                                .foregroundStyle(GPT.tertiaryText)
                        }
                    }

                    Spacer(minLength: 0)
                }
                .frame(minHeight: 24)
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
    /// Unused since the lead line above carries the bot's face; kept so
    /// callers that pass one still compile.
    var avatar: AnyView? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// ChatGPT's running turn: "Working for 12s" shimmering over the
    /// hairline, the last few steps quiet beneath it, the current one
    /// shimmering at the end.
    var body: some View {
        let steps = items.map(toolStep(from:))
        let live = steps.last(where: { $0.status == .running })
        let finished = steps.filter { $0.status != .running }.suffix(3)
        VStack(alignment: .leading, spacing: 0) {
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                GPTShimmer(text: workedTitle(seconds: max(0, Int(context.date.timeIntervalSince(startedAt))), running: true))
            }
            .padding(.bottom, 9)
            .accessibilityIdentifier("working-header")
            Rectangle().fill(GPT.hairline).frame(height: 1)
            if !finished.isEmpty || live != nil {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(finished) { step in
                        ToolStepRow(step: step, dimmed: true)
                            .transition(.opacity.combined(with: .offset(y: 4)))
                    }
                    if let live {
                        ToolStepRow(step: live)
                            .transition(.opacity.combined(with: .offset(y: 4)))
                    }
                }
                .padding(.top, 12)
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: steps.map(\.id))
        .padding(.vertical, 2)
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
