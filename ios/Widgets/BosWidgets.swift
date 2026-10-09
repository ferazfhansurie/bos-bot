// The widget extension: the bot's Live Activity, in the Dynamic Island and
// on the lock screen, plus the Control Center controls that call a bot.
//
// The face is the mascot engine's resting face for the state — the system
// renders a snapshot, so it cannot move here, but it changes with every
// update. What does move is what iOS animates on its own: the timer text and
// the timer-driven progress ring, which is the working indicator.
//
// Colour is meaningful, not decorative: the bot's own colour marks the bot,
// a needs-you state wears it, everything else is white on dark glass.
import ActivityKit
import AppIntents
import CompanionCore
import SwiftUI
import WidgetKit

@main
struct BosWidgets: WidgetBundle {
    var body: some Widget {
        BotActivityWidget()
        if #available(iOS 18.0, *) {
            CallBosControl()
            CallOracleControl()
        }
    }
}

private extension ActivityViewContext where Attributes == BotActivityAttributes {
    /// Every bot wears its own colour.
    var accent: Color { MausPalette.color(attributes.color) }

    var link: URL? { BotActivityLink.thread(botId: attributes.botId, threadId: state.threadId) }

    var status: String {
        if state.isDone { return "done" }
        if state.needsYou { return "needs you" }
        return "working"
    }

    var elapsed: ClosedRange<Date> { state.since...state.since.addingTimeInterval(86_400) }

    var finishedIn: String {
        let end = state.endedAt ?? Date()
        return elapsedLabel(Int(end.timeIntervalSince(state.since)))
    }
}

struct BotActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotActivityAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.42))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(context.link)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RingedFace(context: context, size: 46)
                        .padding(.leading, 4)
                        .padding(.top, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Clock(context: context)
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .padding(.trailing, 4)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 1) {
                        StatusLine(context: context)
                        if let title = context.state.threadTitle {
                            Text(title)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        StepLine(context: context, lines: 2)
                        Actions(context: context)
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
                }
            } compactLeading: {
                ActivityBotFace(context: context, size: 22)
                    .padding(.leading, 2)
            } compactTrailing: {
                CompactTrailing(context: context)
            } minimal: {
                RingedFace(context: context, size: 18)
            }
            .widgetURL(context.link)
            .keylineTint(context.accent)
        }
    }
}

private struct CompactTrailing: View {
    let context: ActivityViewContext<BotActivityAttributes>

    var body: some View {
        if context.state.needsYou {
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(context.accent)
        } else if context.state.isDone {
            Image(systemName: "checkmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(context.accent)
        } else {
            // the ticking clock is the island's working indicator
            Text(timerInterval: context.elapsed, countsDown: false)
                .font(.system(size: 13, weight: .semibold).monospacedDigit())
                .foregroundStyle(context.accent)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 44, alignment: .trailing)
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<BotActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                RingedFace(context: context, size: 50)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        StatusLine(context: context)
                        Spacer(minLength: 8)
                        Clock(context: context)
                            .font(.system(size: 13, weight: .medium).monospacedDigit())
                    }
                    if let title = context.state.threadTitle {
                        Text(title)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                    }
                    StepLine(context: context, lines: context.state.isDone ? 2 : 1)
                }
            }
            Actions(context: context)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// "bos · working" — the bot's name, then its state in the state's colour.
private struct StatusLine: View {
    let context: ActivityViewContext<BotActivityAttributes>

    var body: some View {
        HStack(spacing: 5) {
            Text(context.attributes.name)
                .foregroundStyle(.white.opacity(0.9))
            Text("·").foregroundStyle(.white.opacity(0.35))
            Text(context.status)
                .foregroundStyle(context.state.isWorking ? .white.opacity(0.55) : context.accent)
            if let more = context.state.otherThreads, more > 0 {
                Text("+\(more) \(more == 1 ? "thread" : "threads")")
                    .foregroundStyle(.white.opacity(0.4))
            }
        }
        .font(.system(size: 13, weight: .semibold))
        .lineLimit(1)
    }
}

/// What it is doing now, or the reply's first line once it is done.
private struct StepLine: View {
    let context: ActivityViewContext<BotActivityAttributes>
    let lines: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: context.state.symbol ?? (context.state.needsYou ? "hand.raised.fill" : "ellipsis"))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(context.state.isWorking ? .white.opacity(0.55) : context.accent)
                .frame(width: 14)
            Text(context.state.line)
                .font(.system(size: 14))
                .foregroundStyle(.white.opacity(context.state.isDone ? 0.85 : 0.7))
                .lineLimit(lines)
        }
    }
}

/// Elapsed time that ticks without pushes, or the fixed time a done turn took.
private struct Clock: View {
    let context: ActivityViewContext<BotActivityAttributes>

    var body: some View {
        if context.state.isDone {
            Text(context.finishedIn)
                .foregroundStyle(.white.opacity(0.5))
        } else {
            Text(timerInterval: context.elapsed, countsDown: false)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 64, alignment: .trailing)
                .foregroundStyle(context.state.needsYou ? context.accent : .white.opacity(0.6))
        }
    }
}

/// Answer buttons when the bot asked, a stop button while it works.
private struct Actions: View {
    let context: ActivityViewContext<BotActivityAttributes>

    var body: some View {
        if let threadId = context.state.approvalThreadId, let requestId = context.state.requestId {
            AnswerButtons(context: context, threadId: threadId, requestId: requestId)
        } else if context.state.isWorking, let threadId = context.state.threadId, !threadId.isEmpty {
            HStack(spacing: 8) {
                Link(destination: context.link ?? URL(string: "bosbot://")!) {
                    GlassPill(title: "Open", systemImage: "arrow.up.right")
                }
                Button(intent: StopBotIntent(botId: context.attributes.botId, threadId: threadId)) {
                    GlassPill(title: "Stop", systemImage: "stop.fill")
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct GlassPill: View {
    let title: String
    let systemImage: String

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white.opacity(0.9))
            .frame(maxWidth: .infinity)
            .frame(height: 32)
            .background(Capsule().fill(.white.opacity(0.14)))
            .overlay(Capsule().strokeBorder(.white.opacity(0.12), lineWidth: 0.5))
    }
}

/// The card's options, as pills — exactly the options the card offered.
private struct AnswerButtons: View {
    let context: ActivityViewContext<BotActivityAttributes>
    let threadId: String
    let requestId: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(context.state.options, id: \.self) { option in
                let quiet = option.caseInsensitiveCompare("Deny") == .orderedSame
                Button(intent: AnswerApprovalIntent(
                    threadId: threadId,
                    requestId: requestId,
                    choice: option,
                    isPermission: context.state.isPermission
                )) {
                    Text(option)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(quiet ? .white : .black)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .background(
                            Capsule().fill(
                                quiet ? Color.white.opacity(0.14) : context.accent
                            )
                        )
                        .overlay(Capsule().strokeBorder(.white.opacity(quiet ? 0.12 : 0), lineWidth: 0.5))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// The face inside a ring. While the bot works the ring is a timer-driven
/// `ProgressView`, the one kind of motion iOS keeps animating in a Live
/// Activity on its own; needing you or done, it is a solid ring.
private struct RingedFace: View {
    let context: ActivityViewContext<BotActivityAttributes>
    let size: CGFloat

    var body: some View {
        let ring = max(2, size * 0.06)
        ZStack {
            Circle().stroke(.white.opacity(0.12), lineWidth: ring)
            if context.state.isWorking {
                ProgressView(timerInterval: context.state.since...context.state.since.addingTimeInterval(60), countsDown: false) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(context.accent)
            } else {
                Circle().stroke(context.accent.opacity(context.state.isDone ? 0.6 : 1), lineWidth: ring)
            }
            ActivityBotFace(context: context, size: size * 0.74, comets: context.state.isWorking && size > 30)
        }
        .frame(width: size + ring * 2, height: size + ring * 2)
    }
}

private struct ActivityBotFace: View {
    let context: ActivityViewContext<BotActivityAttributes>
    let size: CGFloat
    var comets = false

    var body: some View {
        MausFaceStill(
            color: context.attributes.color,
            state: MausState(rawValue: context.state.face) ?? .idle,
            size: size,
            bodyId: context.attributes.mascotBody,
            eyeStyle: MascotEyeStyle(stored: context.attributes.mascotEyes),
            comets: comets,
            at: Date()
        )
        .frame(width: size, height: size)
        .accessibilityLabel("\(context.attributes.name) avatar")
    }
}

/// "Call bos" in Control Center, on the lock screen, or on the action button.
@available(iOS 18.0, *)
struct CallBosControl: ControlWidget {
    var body: some ControlWidgetConfiguration { callControl("bos") }
}

@available(iOS 18.0, *)
struct CallOracleControl: ControlWidget {
    var body: some ControlWidgetConfiguration { callControl("oracle") }
}

@available(iOS 18.0, *)
private func callControl(_ bot: String) -> some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "com.aihlete.aios.call-\(bot)") {
        ControlWidgetButton(action: OpenBotCallIntent(bot: bot)) {
            Label("Call \(bot)", systemImage: "phone.fill")
        }
    }
    .displayName("Call \(bot)")
    .description("Start a live voice call with \(bot).")
}
