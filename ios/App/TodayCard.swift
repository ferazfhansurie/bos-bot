import SwiftUI
import CompanionCore

/// 3.0 today card on top of the home list: the chief's check-in items with
/// the same buttons as the desktop today screen. Go ahead starts the work on
/// the computer; sends, spend and deletes still ask there as usual.
struct TodayCard: View {
    @EnvironmentObject private var session: Session
    let snapshot: CheckinsSnapshot
    @State private var picked: String?

    private var expandedID: String? {
        if picked == "" { return nil }
        if let picked, snapshot.items.contains(where: { $0.id == picked }) { return picked }
        return snapshot.items.first?.id
    }

    private var headline: String {
        switch snapshot.items.count {
        case 0: return snapshot.setUp ? "All clear" : "Check-ins are off"
        case 1: return "One thing needs you"
        default: return "\(snapshot.items.count) things need you"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                TodayRingView(count: snapshot.items.count, share: snapshot.clearedShare)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Today").font(.headline)
                    Text(verbatim: headline).font(.subheadline).foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)

            if !snapshot.setUp && snapshot.chiefBotId == nil {
                Text("Pick a chief of staff on the computer to turn on check-ins.")
                    .font(.footnote).foregroundStyle(Color.secondary)
            } else if !snapshot.setUp {
                Button {
                    Haptics.selection()
                    Task { await session.setupCheckins() }
                } label: {
                    Text("Turn on check-ins · 9am, 2pm, 10pm")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
            }

            ForEach(snapshot.items) { item in
                row(item, expanded: item.id == expandedID)
            }

            let counts = snapshot.counts
            if counts.later + counts.done + counts.no > 0 {
                Text(verbatim: "Later · \(counts.later)   Done · \(counts.done)   Said no · \(counts.no)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Color.secondary)
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityIdentifier("today-card")
    }

    @ViewBuilder private func row(_ item: CheckinItem, expanded: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Haptics.selection()
                withAnimation(.snappy(duration: 0.25)) { picked = expanded ? "" : item.id }
            } label: {
                HStack(spacing: 10) {
                    Circle()
                        .strokeBorder(kindColor(item.kind), lineWidth: 2)
                        .frame(width: 16, height: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: item.title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.primary)
                            .lineLimit(expanded ? 3 : 1)
                        if !expanded, !item.why.isEmpty {
                            Text(verbatim: item.why).font(.caption).foregroundStyle(Color.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 4)
                    Text(verbatim: kindLabel(item.kind))
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(kindColor(item.kind).opacity(0.16), in: Capsule())
                        .foregroundStyle(kindColor(item.kind))
                    if let bot = session.state.bot(item.ownerBotId) {
                        BotAvatarView(bot: bot, size: 24, state: .happy, animated: false)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !item.why.isEmpty {
                        Text(verbatim: item.why).font(.footnote).foregroundStyle(Color.secondary)
                    }
                    if let plan = item.plan, !plan.isEmpty {
                        Text(verbatim: plan).font(.footnote)
                    }
                    if let draft = item.draft, !draft.isEmpty {
                        Text(verbatim: draft)
                            .font(.footnote)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    actions(item)
                }
                .padding(.leading, 26)
                .transition(.opacity)
            }
        }
        .accessibilityIdentifier("today-item-\(item.id)")
    }

    @ViewBuilder private func actions(_ item: CheckinItem) -> some View {
        let busy = session.checkinBusy.contains(item.id)
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { actionButtons(item, busy: busy) }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) { actionButtons(item, busy: busy, range: 0..<2) }
                HStack(spacing: 8) { actionButtons(item, busy: busy, range: 2..<item.actions.count) }
            }
        }
    }

    @ViewBuilder private func actionButtons(_ item: CheckinItem, busy: Bool, range: Range<Int>? = nil) -> some View {
        let all = Array(item.actions.enumerated())
        let shown = range.map { r in all.filter { r.contains($0.offset) } } ?? all
        ForEach(shown, id: \.offset) { index, entry in
            Button {
                Task { await session.actOnCheckin(item, action: entry.action) }
            } label: {
                Text(verbatim: entry.label)
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .foregroundStyle(index == 0 ? Color(uiColor: .systemBackground) : Color.primary)
                    .background(index == 0 ? Color.primary : Color(uiColor: .tertiarySystemFill), in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .opacity(busy ? 0.5 : 1)
            .accessibilityIdentifier("today-\(entry.action)-\(item.id)")
        }
    }

    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "did": return "Done"
        case "broke": return "Broke"
        case "tonight": return "Tonight"
        default: return "Decide"
        }
    }

    private func kindColor(_ kind: String) -> Color {
        switch kind {
        case "did": return .green
        case "broke": return .red
        case "tonight": return .accentColor
        default: return .orange
        }
    }
}

/// The count of open items inside a ring that fills as the day clears.
struct TodayRingView: View {
    let count: Int
    let share: Double
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 3)
            Circle()
                .trim(from: 0, to: min(1, max(0, share)))
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(verbatim: "\(count)")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(count > 0 ? Color.primary : Color.secondary)
        }
        .frame(width: size, height: size)
        .animation(.smooth(duration: 0.5), value: share)
    }
}
