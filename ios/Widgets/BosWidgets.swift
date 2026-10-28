// The widget extension: the bot's Live Activity, in the Dynamic Island and
// on the lock screen, plus the Control Center controls that call a bot.
//
// The drawing lives in Shared/LiveCard.swift so the app can render the same
// views for snapshots; this file only places them in each family.
//
// The face is the mascot engine's resting face for the state: the system
// renders a snapshot, so it cannot move here, but it changes with every
// update. What does move is what iOS animates on its own: the job's clock and
// the current step's sweep inside the plan ring.
//
// CarPlay and the watch's Smart Stack draw the small family: the job's title
// and step, nothing to tap. The island and the lock screen carry the buttons.
import ActivityKit
import AppIntents
import CompanionCore
import SwiftUI
import WidgetKit

@main
struct BosWidgets: WidgetBundle {
    var body: some Widget {
        BotActivityWidget()
        BotsWidget()
        if #available(iOS 18.0, *) {
            CallBosControl()
            CallOracleControl()
        }
    }
}

private extension ActivityViewContext where Attributes == BotActivityAttributes {
    var card: LiveCard { LiveCard(attributes: attributes, state: state) }
}

struct BotActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotActivityAttributes.self) { context in
            FamilyView(card: context.card)
                .activityBackgroundTint(Color.black.opacity(0.42))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(context.card.link)
        } dynamicIsland: { context in
            let card = context.card
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    LiveCardFace(card: card, size: 44)
                        .padding(.leading, 4)
                        .padding(.top, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    LiveCardClock(card: card)
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .padding(.trailing, 4)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 1) {
                        LiveCardStatus(card: card, showsClock: false, showsOthers: true, compact: true)
                        Text(card.title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    LiveIslandBottom(card: card)
                        .padding(.horizontal, 4)
                        .padding(.top, 2)
                }
            } compactLeading: {
                CompactLeading(card: card)
            } compactTrailing: {
                CompactTrailing(card: card)
            } minimal: {
                LiveCardFace(card: card, size: 17)
            }
            .widgetURL(card.link)
            .keylineTint(card.accent)
        }
        .carPlaySmall()
    }
}

private extension WidgetConfiguration {
    /// Opt into the small family (CarPlay, the watch's Smart Stack) where
    /// iOS has it; without it CarPlay falls back to the compact island.
    func carPlaySmall() -> some WidgetConfiguration {
        if #available(iOS 18.0, *) {
            return supplementalActivityFamilies([.small])
        } else {
            return self
        }
    }
}

/// The lock screen (the medium family), or the car view for the small one.
private struct FamilyView: View {
    let card: LiveCard

    var body: some View {
        if #available(iOS 18.0, *) {
            FamilySwitch(card: card)
        } else {
            LiveLockCard(card: card)
        }
    }
}

@available(iOS 18.0, *)
private struct FamilySwitch: View {
    let card: LiveCard
    @Environment(\.activityFamily) private var family

    var body: some View {
        switch family {
        case .small: LiveCarCard(card: card)
        default: LiveLockCard(card: card)
        }
    }
}

/// The compact island's left: the face, and "3/5" with a plan.
private struct CompactLeading: View {
    let card: LiveCard

    var body: some View {
        HStack(spacing: 5) {
            LiveCardFace(card: card, size: 20)
            if let fraction = card.fraction, card.state.isWorking {
                Text(fraction)
                    .font(.system(size: 12, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.75))
                    .contentTransition(.numericText())
            }
        }
        .padding(.leading, 2)
    }
}

/// The compact island's right: the job's clock while it works, a hand when
/// it needs you, a check once done.
private struct CompactTrailing: View {
    let card: LiveCard

    var body: some View {
        if card.state.needsYou {
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(card.accent)
        } else if card.state.isDone {
            Image(systemName: "checkmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(LiveCardColor.green)
                .transition(.scale(scale: 0.3).combined(with: .opacity))
        } else {
            Text(timerInterval: card.clock, countsDown: false)
                .font(.system(size: 13, weight: .semibold).monospacedDigit())
                .foregroundStyle(card.botColor)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 44, alignment: .trailing)
        }
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
