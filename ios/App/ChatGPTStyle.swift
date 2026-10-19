// The conversation view, drawn the way ChatGPT draws one.
//
// Measurements come from the desktop app's own stylesheet (see
// outputs/2026-10-16-chatgpt-chat-1to1/spec.md), adapted to a phone: the
// prose uses the specified 14pt base, with Dynamic Type scaling. The code here is ours; only
// the numbers and the shapes are copied.
//
// What is BOS's own: each bot reply leads with that bot's face and name, so
// a room still says who answered.
import AVFoundation
import SwiftUI
import UIKit
import CompanionCore

// MARK: - Palette

enum GPT {
    static func dynamic(dark: UIColor, light: UIColor) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }

    static func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }

    /// The person's bubble: rgb(50 50 50 / 85%) on dark, rgb(233 233 233 / 50%) on light.
    static let userBubble = dynamic(dark: rgb(0x323232, 0.85), light: rgb(0xE9E9E9, 0.5))
    static let userText = dynamic(dark: .white, light: rgb(0x0D0D0D))
    /// Someone else in a room: the text colour at 10%.
    static let otherBubble = dynamic(dark: UIColor(white: 1, alpha: 0.10), light: UIColor(white: 0, alpha: 0.06))

    static let secondaryText = Color.primary.opacity(0.62)
    static let tertiaryText = Color.primary.opacity(0.45)
    /// Activity labels sit at 40% of the text colour, their icons at 60%.
    static let activityText = Color.primary.opacity(0.4)
    static let activityIcon = Color.primary.opacity(0.6)
    static let hairline = Color.primary.opacity(0.1)
    static let strongBorder = Color.primary.opacity(0.16)
    static let subtleBorder = Color.primary.opacity(0.08)

    static let added = dynamic(dark: rgb(0x40C977), light: rgb(0x00A240))
    static let removed = dynamic(dark: rgb(0xFA423E), light: rgb(0xBA2623))

    /// Resource cards: elevated secondary at 50% behind a half-point stroke.
    static let card = dynamic(dark: UIColor(white: 1, alpha: 0.045), light: UIColor(white: 0, alpha: 0.018))
    static let cardRow = dynamic(dark: UIColor(white: 0, alpha: 0.18), light: UIColor(white: 1, alpha: 0.7))
    static let iconTile = dynamic(dark: UIColor(white: 0, alpha: 0.45), light: UIColor(white: 0, alpha: 0.05))
    static let softFill = dynamic(dark: UIColor(white: 1, alpha: 0.08), light: UIColor(white: 0, alpha: 0.05))
    /// The image placeholder: the description colour at 12% (dark) / 8% (light).
    static let placeholder = dynamic(dark: UIColor(white: 1, alpha: 0.10), light: UIColor(white: 0, alpha: 0.06))

    // Code blocks and the CODEX syntax theme.
    static let codeBackground = dynamic(dark: rgb(0x171717), light: rgb(0xF9F9F9))
    static let codeText = dynamic(dark: rgb(0xFCFCFC), light: rgb(0x0D0D0D))
    static let codeComment = dynamic(dark: rgb(0x999999), light: rgb(0x666666))
    static let codeString = dynamic(dark: rgb(0x85DF7B), light: rgb(0x008809))
    static let codeNumber = dynamic(dark: rgb(0x6DCBF4), light: rgb(0x0071EA))
    static let codeVariable = dynamic(dark: rgb(0xFA994C), light: rgb(0xBD5800))
    static let codeKeyword = dynamic(dark: rgb(0xF67576), light: rgb(0xD53538))
    static let codeFunction = dynamic(dark: rgb(0xB06DFF), light: rgb(0x751ED9))
    static let inlineCode = dynamic(dark: UIColor(white: 1, alpha: 0.10), light: UIColor(white: 0, alpha: 0.06))

    /// The full-screen viewer: black, white controls on a 35% white wash.
    static let mediaControl = Color.white.opacity(0.18)
}

/// The specified 14pt prose base, scaled with Dynamic Type.
struct GPTMetrics: DynamicProperty {
    @ScaledMetric(relativeTo: .body) var body: CGFloat = 14
    /// The desktop sets line height at 1.625 × the font.
    var lineSpacing: CGFloat { body * 0.42 }
}

// MARK: - Layout helpers

/// A bubble that may grow to `fraction` of the row and no wider, pinned to
/// the trailing edge: ChatGPT's 70% user bubble.
struct TrailingFraction: Layout {
    var fraction: CGFloat = 0.7

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let width = proposal.width ?? 390
        let size = child.sizeThatFits(ProposedViewSize(width: width * fraction, height: nil))
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let size = child.sizeThatFits(ProposedViewSize(width: bounds.width * fraction, height: nil))
        child.place(
            at: CGPoint(x: bounds.maxX, y: bounds.minY), anchor: .topTrailing,
            proposal: ProposedViewSize(width: size.width, height: size.height)
        )
    }
}

// MARK: - Lead line

/// BOS's one change to ChatGPT: the bot's face and name at the start of
/// each reply. A room reply carries the member who said it.
struct AssistantLeadLine: View {
    let chat: Chat
    /// The member who replied, in a room; nil in a 1:1.
    var botId: String? = nil
    var fallbackName: String? = nil
    var state: MausState = .idle
    var animated = false
    @Environment(\.sessionActions) private var sessionActions

    var body: some View {
        HStack(spacing: 8) {
            avatar.frame(width: 22, height: 22)
            Text(name)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.primary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(name)
        .padding(.bottom, 2)
    }

    private var member: Bot? {
        guard let botId else { return nil }
        return sessionActions?.state.bot(botId)
    }

    private var name: String {
        if let member { return member.name }
        if let fallbackName, !fallbackName.isEmpty { return fallbackName }
        return chat.name
    }

    @ViewBuilder
    private var avatar: some View {
        if let member {
            BotAvatarView(bot: member, size: 22, state: state, animated: animated)
        } else {
            ChatAvatarView(chat: chat, size: 22, state: state, animated: animated)
        }
    }
}

// MARK: - Worked for

/// "Worked for 10m 56s ›" over a hairline. Closed, the answer reads on its
/// own below; open, the narration and the steps that led to it.
struct WorkedTurnRow: View {
    let turn: WorkedTurn
    let chat: Chat
    var selfID: String? = nil
    let openLink: (URL, Message) -> OpenURLAction.Result
    var openThread: ((ThreadRef) -> Void)? = nil
    @State private var expanded = ProcessInfo.processInfo.arguments.contains("-expand-worked")
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let metrics = GPTMetrics()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.selection()
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(turn.title)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .font(.system(size: metrics.body))
                .foregroundStyle(GPT.secondaryText)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(turn.title)
            .accessibilityValue(turn.summary)
            .accessibilityHint(expanded ? "Hides the work" : "Shows the work")
            .accessibilityIdentifier("worked-" + turn.answerId)
            .padding(.bottom, 9)

            Rectangle().fill(GPT.hairline).frame(height: 1)

            if expanded {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(turn.rows, id: \.id) { row in
                        switch row {
                        case let .message(message):
                            if message.kind == .text {
                                TextBubble(message: message, chat: chat, selfID: selfID, openLink: openLink)
                            } else {
                                ActivityChip(message: message, threadRef: message.threadRef, openThread: openThread)
                            }
                        case let .activityRun(items):
                            // ChatGPT lists every step of a settled turn on
                            // its own line; no second fold inside the first.
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(items) { item in
                                    ActivityChip(message: item, threadRef: item.threadRef, openThread: openThread)
                                }
                            }
                        case .worked:
                            EmptyView()
                        }
                    }
                }
                .padding(.top, 16)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The running turn's line: the current step, shimmering. A one-second
/// sweep in 48 steps every four seconds, first after 600ms.
struct GPTShimmer: View {
    let text: String
    var size: CGFloat = 14
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()

    var body: some View {
        Group {
            if reduceMotion {
                label.foregroundStyle(GPT.activityText)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 48)) { context in
                    let t = context.date.timeIntervalSince(start) - 0.6
                    let phase = t < 0 ? -1 : t.truncatingRemainder(dividingBy: 4)
                    let p = phase < 0 || phase > 1 ? -1 : (phase * 48).rounded(.down) / 48
                    let x = p < 0 ? -1 : -0.3 + p * 1.6
                    label.foregroundStyle(
                        LinearGradient(
                            stops: [
                                .init(color: GPT.activityText, location: 0),
                                .init(color: GPT.activityText, location: min(1, max(0, x - 0.2))),
                                .init(color: Color.primary.opacity(0.92), location: min(1, max(0, x))),
                                .init(color: GPT.activityText, location: min(1, max(0, x + 0.2))),
                                .init(color: GPT.activityText, location: 1),
                            ],
                            startPoint: .leading, endPoint: .trailing
                        )
                    )
                }
            }
        }
        .id(text)
        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 3)), removal: .opacity))
    }

    private var label: Text { Text(text).font(.system(size: size)) }
}

// MARK: - Edited files

/// "Edited 3 files +192 −1 · View changes", then the files, three at most
/// before "Show # more files".
struct FileChangeCard: View {
    let changes: [FileChange]
    /// The edit and write steps behind the card, for View changes.
    let steps: [Message]
    @State private var showAll = false
    @State private var showingChanges = false
    private let metrics = GPTMetrics()
    private static let cap = 3

    private var added: Int? {
        let known = changes.compactMap(\.added)
        return known.isEmpty ? nil : known.reduce(0, +)
    }

    private var removed: Int? {
        let known = changes.compactMap(\.removed)
        return known.isEmpty ? nil : known.reduce(0, +)
    }

    private var title: String {
        changes.count == 1 ? "Edited \(changes[0].name)" : "Edited \(changes.count) files"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "plusminus")
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(GPT.secondaryText)
                    .frame(width: 40, height: 40)
                    .background(GPT.iconTile, in: RoundedRectangle(cornerRadius: 12.5, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: metrics.body - 1, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    DiffCounts(added: added, removed: removed, size: 13)
                }
                Spacer(minLength: 8)
                Button("View changes") { showingChanges = true }
                    .font(.system(size: 14))
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .overlay(Capsule().strokeBorder(GPT.strongBorder))
                    .buttonStyle(.plain)
            }
            .padding(12)

            if changes.count > 1 {
                Rectangle().fill(GPT.hairline).frame(height: 1)
                let shown = showAll ? changes : Array(changes.prefix(Self.cap))
                ForEach(shown) { change in
                    FileChangeRow(change: change, size: metrics.body - 2)
                }
                if changes.count > Self.cap {
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { showAll.toggle() }
                    } label: {
                        HStack(spacing: 4) {
                            Text(showAll ? "Collapse files" : "Show \(changes.count - Self.cap) more files")
                            Image(systemName: "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .rotationEffect(.degrees(showAll ? 180 : 0))
                        }
                        .font(.system(size: metrics.body - 2))
                        .foregroundStyle(GPT.secondaryText)
                        .frame(maxWidth: .infinity, minHeight: 36)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .background(GPT.card, in: RoundedRectangle(cornerRadius: 12.5, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12.5, style: .continuous).strokeBorder(GPT.strongBorder, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 12.5, style: .continuous))
        .transition(.opacity)
        .sheet(isPresented: $showingChanges) {
            ActivityDetailSheet(title: title, items: steps)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("file-change-card")
    }
}

private struct FileChangeRow: View {
    let change: FileChange
    let size: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            (Text(change.directory).foregroundStyle(GPT.tertiaryText) + Text(change.name).foregroundStyle(Color.primary))
                .font(.system(size: size))
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 8)
            DiffCounts(added: change.added, removed: change.removed, size: size)
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(GPT.cardRow)
    }
}

/// "+192 −1" in the diff colours, tabular so columns line up.
struct DiffCounts: View {
    let added: Int?
    let removed: Int?
    var size: CGFloat = 13

    var body: some View {
        if added != nil || removed != nil {
            HStack(spacing: 4) {
                Text("+\(added ?? 0)").foregroundStyle(GPT.added)
                Text("-\(removed ?? 0)").foregroundStyle(GPT.removed)
            }
            .font(.system(size: size).monospacedDigit())
            .tracking(-0.2)
        }
    }
}

// MARK: - Action row

/// Under the latest reply: copy, read aloud, good, bad, share, more. Ghost
/// icons at 18pt with 2pt gaps, nudged left so the first glyph lines up
/// with the text above it.
struct ReplyActionRow: View {
    let chat: Chat
    let message: Message
    var onReply: ((Message) -> Void)? = nil
    @Environment(\.sessionActions) private var sessionActions
    @ObservedObject private var reader = ReadAloud.shared
    @State private var copied = false
    @State private var selecting: SelectableText?

    private var text: String { message.displayedContent.text }
    private var reading: Bool { reader.messageId == message.id }

    private func mine(_ emoji: String) -> Bool {
        message.reactions?.contains { $0.emoji == emoji && $0.by == "user" } == true
    }

    var body: some View {
        HStack(spacing: 2) {
            icon(copied ? "checkmark" : "doc.on.doc", label: "Copy response") {
                PlatformBridge.copyToPasteboard(text)
                Haptics.success()
                withAnimation(.snappy) { copied = true }
                Task { try? await Task.sleep(for: .seconds(1.5)); withAnimation(.snappy) { copied = false } }
            }
            icon(reading ? "stop.circle" : "speaker.wave.2", label: reading ? "Stop reading aloud" : "Read aloud") {
                reader.toggle(text, id: message.id)
            }
            icon(mine("👍") ? "hand.thumbsup.fill" : "hand.thumbsup",
                 label: mine("👍") ? "Remove good response feedback" : "Good response") { react("👍") }
            icon(mine("👎") ? "hand.thumbsdown.fill" : "hand.thumbsdown",
                 label: mine("👎") ? "Remove bad response feedback" : "Bad response") { react("👎") }
            ShareLink(item: text) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 18, weight: .regular))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Share")
            Menu {
                if message.at > 0 {
                    Text(Date(timeIntervalSince1970: message.at / 1000).formatted(date: .abbreviated, time: .shortened))
                }
                if let onReply {
                    Button("Reply", systemImage: "arrowshape.turn.up.left") { onReply(message) }
                }
                Button("Select Text", systemImage: "selection.pin.in.out") {
                    selecting = SelectableText(text: text)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 18, weight: .regular))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("More actions")
        }
        .foregroundStyle(GPT.tertiaryText)
        .padding(.leading, -7)
        .padding(.top, 2)
        .sheet(item: $selecting) { SelectableTextSheet(text: $0.text) }
        .accessibilityIdentifier("reply-actions-" + message.id)
    }

    private func icon(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .regular))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func react(_ emoji: String) {
        guard let session = sessionActions else { return }
        Haptics.selection()
        Task { await session.react(to: message, in: chat.threadId, emoji: emoji) }
    }
}

/// Read aloud, on the phone's own voice. One reply at a time.
@MainActor
final class ReadAloud: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = ReadAloud()
    @Published private(set) var messageId: String?
    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func toggle(_ text: String, id: String) {
        if messageId == id {
            synthesizer.stopSpeaking(at: .immediate)
            messageId = nil
            return
        }
        synthesizer.stopSpeaking(at: .immediate)
        let plain = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            .map { String($0.characters) } ?? text
        messageId = id
        synthesizer.speak(AVSpeechUtterance(string: plain))
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.messageId = nil }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in if !self.synthesizer.isSpeaking { self.messageId = nil } }
    }
}
