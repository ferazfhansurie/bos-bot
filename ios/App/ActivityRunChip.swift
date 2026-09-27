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

            if count > 1 {
                Text("\(count)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.secondary.opacity(0.7))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.12), in: Capsule())
            }

            Spacer(minLength: 6)

            StepStatusBadge(status: status)

            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Color.secondary.opacity(0.6))
        }
        .padding(.horizontal, 11)
        .frame(height: 40)
        .background(isDark ? Color.white.opacity(0.05) : Color.black.opacity(0.035),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(Rectangle())
    }
}

/// live / done / failed, in the AIOS colours.
struct StepStatusBadge: View {
    let status: ToolStep.Status
    var showsLabel = true

    static func color(_ status: ToolStep.Status) -> Color {
        switch status {
        case .failed: Color(hex: "#FF5F57")
        case .running: Color(hex: "#FF8A3D")
        case .ok: Color(hex: "#49C785")
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            switch status {
            case .running:
                PulsingDot(color: Self.color(status))
            case .ok:
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Self.color(status))
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Self.color(status))
            }
            if showsLabel {
                Text(status == .running ? "live" : (status == .ok ? "done" : "failed"))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Self.color(status))
            }
        }
    }
}

struct PulsingDot: View {
    let color: Color
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 6, height: 6)
            .opacity(on ? 1 : 0.35)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
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

                    Text(step.isTool ? step.label : step.name)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(labelColor)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

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
                    if let input = step.input, !input.isEmpty {
                        StepDetailBlock(title: "INPUT", text: input, tint: Color(hex: "#8B5CF6"))
                    }
                    if let output = step.output, !output.isEmpty {
                        StepDetailBlock(title: "OUTPUT", text: output, tint: Color(hex: "#10B981"))
                    }
                }
                .padding(.leading, 22)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .opacity(dimmed ? 0.45 : 1)
    }

    private var labelColor: Color {
        if step.status == .failed { return StepStatusBadge.color(.failed) }
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
        let word = status == .running ? "running" : (status == .failed ? "failed" : "done")
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

/// What a turn shows while it is still working: how long it has been going,
/// the last few steps that landed, and the one that is running now.
struct WorkingSteps: View {
    /// The turn's activity so far, oldest first.
    let items: [Message]
    let startedAt: Date
    @State private var now = Date()
    @Environment(\.colorScheme) private var colorScheme

    private static let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var steps: [ToolStep] { items.map(toolStep(from:)) }
    private var live: ToolStep? { steps.last(where: { $0.status == .running }) }
    private var finished: [ToolStep] { steps.filter { $0.status != .running }.suffix(3) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(finished) { step in
                ToolStepRow(step: step, dimmed: true)
            }

            HStack(spacing: 8) {
                PulsingDot(color: StepStatusBadge.color(.running))
                Text(live.map { $0.isTool ? $0.label : $0.name } ?? "Working")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(colorScheme == .dark ? Color(hex: "#D4D4D4") : Color(hex: "#3A3A3A"))
                    .lineLimit(1)
                Text(elapsedLabel(Int(now.timeIntervalSince(startedAt))))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(Color.secondary)
                if steps.count > 1 {
                    Text("· \(steps.count) steps")
                        .font(.system(size: 10.5))
                        .foregroundStyle(Color.secondary.opacity(0.8))
                }
            }
        }
        .padding(.vertical, 6)
        .onReceive(Self.tick) { now = $0 }
    }
}
