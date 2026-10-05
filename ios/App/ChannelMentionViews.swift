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

/// What typing @ opens above the composer: who can be tagged here, best
/// match first with the matched letters marked, and you can tick several
/// before going back to the message.
struct ChannelMentionDrawer: View {
    let matches: [MentionMatch]
    let working: Set<String>
    let picked: [MentionTarget]
    /// A room says "everyone in this room"; a bot's chat has no @everyone.
    let inRoom: Bool
    /// The room the chat can spare above the keyboard; nil before it is
    /// measured.
    var maxListHeight: CGFloat? = nil
    let onToggle: (MentionTarget) -> Void
    let onDone: () -> Void

    /// Grows with Dynamic Type, so a capped list still shows whole rows.
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 54

    private var listHeight: CGFloat {
        let natural = min(CGFloat(matches.count), 4.5) * rowHeight
        guard let maxListHeight else { return natural }
        let fitting = max(floor(maxListHeight / rowHeight - 0.5) + 0.5, 1.5) * rowHeight
        return min(natural, max(fitting, min(natural, 1.5 * rowHeight)))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(picked.isEmpty ? (inRoom ? "Mention someone in this room" : "Ask another bot") : "\(picked.count) selected")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Button("Done", action: onDone).font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("mention-done")
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(matches) { match in
                            MentionRow(match: match, working: working.contains(match.id),
                                       picked: picked.contains { $0.id == match.id }, inRoom: inRoom,
                                       height: rowHeight) { onToggle(match.target) }
                                .id(match.id)
                        }
                    }
                }
                // A fixed height, not a max: as a flexible sibling of the
                // transcript the list was squeezed to one row with the
                // keyboard up. Up to four and a half rows (a half row hints
                // that it scrolls), fewer where the keyboard leaves less room,
                // never under two.
                .frame(height: listHeight)
                .scrollBounceBehavior(.basedOnSize)
                // Typing narrows the list; start it back at the best match.
                .onChange(of: matches.first?.id) { _, first in
                    if let first { proxy.scrollTo(first, anchor: .top) }
                }
            }
        }
        .padding(.bottom, 6)
        .glassSheet(cornerRadius: 22)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Mention")
        .accessibilityIdentifier("mention-drawer")
    }
}

private struct MentionRow: View {
    let match: MentionMatch
    let working: Bool
    let picked: Bool
    let inRoom: Bool
    let height: CGFloat
    let onTap: () -> Void

    var body: some View {
        let target = match.target
        Button(action: onTap) {
            HStack(spacing: 12) {
                if let bot = target.bot {
                    BotAvatarView(bot: bot, size: 36)
                        .overlay(alignment: .bottomTrailing) { if working { WorkingDot(size: 10) } }
                } else {
                    Image(systemName: "person.3.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Color.accentColor.opacity(0.16)))
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(MentionHighlight.attributed("@" + target.name, ranges: match.nameHighlights.map { ($0.lowerBound + 1)..<($0.upperBound + 1) }))
                        .font(.body.weight(.medium)).foregroundStyle(Color.primary).lineLimit(1)
                    let subtitle = target.isEveryone ? String(localized: inRoom ? "Everyone in this room" : "Everyone") : target.subtitle
                    if !subtitle.isEmpty || working {
                        HStack(spacing: 4) {
                            if working {
                                Text("Working").foregroundStyle(Color.green)
                                if !subtitle.isEmpty { Text(verbatim: "·") }
                            }
                            if !subtitle.isEmpty {
                                Text(MentionHighlight.attributed(subtitle, ranges: match.subtitleHighlight.map { [$0] } ?? []))
                            }
                        }
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(picked ? Color.accentColor : Color.secondary.opacity(0.5))
                    .contentTransition(.symbolEffect(.replace))
            }
            .padding(.horizontal, 16)
            .frame(minHeight: height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(target.isEveryone ? String(localized: "Mention everyone") : String(localized: "Mention \(target.name)"))
        .accessibilityValue([target.subtitle, working ? String(localized: "Working") : ""].filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("mention-\(target.id)")
    }
}

/// The matched letters of a name, bold and in the accent colour.
enum MentionHighlight {
    static func attributed(_ text: String, ranges: [Range<Int>]) -> AttributedString {
        var out = AttributedString(text)
        let count = out.characters.count
        for range in ranges where range.lowerBound >= 0 && range.upperBound <= count && !range.isEmpty {
            let lower = out.characters.index(out.startIndex, offsetBy: range.lowerBound)
            let upper = out.characters.index(out.startIndex, offsetBy: range.upperBound)
            out[lower..<upper].foregroundColor = .accentColor
            out[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        }
        return out
    }
}

/// The names picked in the drawer, waiting above the message as tokens in
/// each bot's colour. Tap one to drop it.
struct ChannelMentionChips: View {
    let picked: [MentionTarget]
    let onRemove: (MentionTarget) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(picked) { target in
                    let tint = target.bot.map { MausPalette.color($0.color) } ?? Color.accentColor
                    Button { onRemove(target) } label: {
                        HStack(spacing: 5) {
                            if let bot = target.bot {
                                BotAvatarView(bot: bot, size: 20)
                            } else {
                                Image(systemName: "person.3.fill").font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(tint).frame(width: 20, height: 20)
                            }
                            Text(verbatim: "@" + target.name).font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.primary).lineLimit(1)
                            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                        }
                        .padding(.leading, 4).padding(.trailing, 10).frame(minHeight: 30)
                        .background(Capsule().fill(tint.opacity(0.18)))
                        .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(target.isEveryone ? String(localized: "Remove mention everyone") : String(localized: "Remove mention \(target.name)"))
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollClipDisabled()
        .accessibilityIdentifier("mention-chips")
    }
}
