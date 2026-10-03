import SwiftUI
import CompanionCore

/// The room header's roster: working bots first, overlapped, with a ring and a
/// pulsing dot, then +N for the rest. Tapping it opens the members.
struct ChannelRosterChip: View {
    let roster: ChannelRoster
    let notifications: String?
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 8) {
                HStack(spacing: -8) {
                    ForEach(Array(roster.shown.enumerated()), id: \.element.id) { index, bot in
                        let working = roster.working.contains(bot.id)
                        BotAvatarView(bot: bot, size: 26)
                            .padding(2)
                            .background(Circle().fill(Color(uiColor: .systemBackground)))
                            .overlay(Circle().strokeBorder(working ? Color.green : .clear, lineWidth: 1.5))
                            .overlay(alignment: .bottomTrailing) { if working { WorkingDot(size: 8) } }
                            .zIndex(Double(roster.shown.count - index))
                    }
                }
                if roster.overflow > 0 {
                    Text("+\(roster.overflow)").font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 7).frame(minHeight: 22)
                        .background(Capsule().fill(Color.secondary.opacity(0.22)))
                }
                if !roster.working.isEmpty {
                    Text("\(roster.working.count) working").font(.caption).foregroundStyle(.secondary)
                }
                if notifications == "muted" { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary) }
                else if notifications == "mentions" { Image(systemName: "at").font(.caption).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 10).frame(height: 36).contentShape(Capsule())
        }
        .buttonStyle(.plain).glassCapsule()
        .accessibilityLabel("\(roster.shown.count + roster.overflow) members, \(roster.working.count) working. Show members")
        .accessibilityIdentifier("room-roster")
    }
}

/// The green dot a working bot wears. Breathes unless motion is reduced.
struct WorkingDot: View {
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        Circle().fill(Color.green).frame(width: size, height: size)
            .overlay(Circle().strokeBorder(Color(uiColor: .systemBackground), lineWidth: 1.5))
            .scaleEffect(pulse ? 1.25 : 1)
            .opacity(pulse ? 0.7 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
            }
    }
}

/// What typing @ opens above the composer: every bot in the room, filtered
/// as you type, and you can tick several before going back to the message.
struct ChannelMentionDrawer: View {
    let bots: [Bot]
    let working: Set<String>
    let picked: [Bot]
    let onToggle: (Bot) -> Void
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(picked.isEmpty ? "Mention" : "\(picked.count) selected")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Button("Done", action: onDone).font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("mention-done")
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(bots) { bot in
                        let isPicked = picked.contains { $0.id == bot.id }
                        Button { onToggle(bot) } label: {
                            HStack(spacing: 12) {
                                BotAvatarView(bot: bot, size: 36)
                                    .overlay(alignment: .bottomTrailing) {
                                        if working.contains(bot.id) { WorkingDot(size: 10) }
                                    }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(bot.name).font(.system(size: 16, weight: .medium)).foregroundStyle(Color.primary)
                                    if !bot.title.isEmpty {
                                        Text(bot.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                                Spacer(minLength: 8)
                                Image(systemName: isPicked ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 22))
                                    .foregroundStyle(isPicked ? Color.accentColor : Color.secondary.opacity(0.5))
                                    .contentTransition(.symbolEffect(.replace))
                            }
                            .padding(.horizontal, 16).padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Mention \(bot.name)")
                        .accessibilityAddTraits(isPicked ? .isSelected : [])
                    }
                }
            }
            .frame(maxHeight: min(CGFloat(bots.count) * 54, 270))
            .scrollBounceBehavior(.basedOnSize)
        }
        .padding(.bottom, 6)
        .glassSheet(cornerRadius: 22)
        .accessibilityIdentifier("mention-drawer")
    }
}

/// The bots picked in the drawer, waiting above the message. Tap one to drop it.
struct ChannelMentionChips: View {
    let picked: [Bot]
    let onRemove: (Bot) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(picked) { bot in
                    Button { onRemove(bot) } label: {
                        HStack(spacing: 5) {
                            BotAvatarView(bot: bot, size: 20)
                            Text("@" + bot.name).font(.subheadline.weight(.medium))
                            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                        }
                        .padding(.leading, 4).padding(.trailing, 10).frame(height: 30)
                        .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove mention \(bot.name)")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollClipDisabled()
        .accessibilityIdentifier("mention-chips")
    }
}
