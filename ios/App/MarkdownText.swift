// Bot replies, rendered.
//
// `Markdown.blocks` does the splitting; this draws each block and hands the
// inline run to Foundation, which knows emphasis, code spans, strikethrough
// and links. SwiftUI makes the links tappable on its own, which is most of
// why this is worth doing at all — a reply full of sources was previously a
// wall of bracketed URLs.
//
// Only bot messages get this. The desktop makes the same split: what you
// typed is shown as you typed it, because markdown you did not intend is
// worse than markdown you did.
import SwiftUI
import CompanionCore

struct MarkdownText: View {
    let source: String
    /// Draws a caret after the last block. The streaming bubble sets this so
    /// the live reply and the settled one are the same view with the same
    /// layout — a caret bolted on outside would put it on its own line the
    /// moment the reply ends in a list item.
    var caret: Bool = false
    var openLink: ((URL) -> OpenURLAction.Result)?

    init(
        source: String,
        caret: Bool = false,
        openLink: ((URL) -> OpenURLAction.Result)? = nil
    ) {
        self.source = source
        self.caret = caret
        self.openLink = openLink
    }

    @Environment(\.mentionContext) private var mentions

    var body: some View {
        // A settled reply's blocks never change; a lazy transcript rebuilds
        // its rows every time they scroll back on screen, so keep the split.
        // The streaming bubble's source changes with every token: never cache.
        let blocks = caret ? Markdown.blocks(source) : MarkdownCache.blocks(source)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { item in
                // Equatable, so while a reply streams only the block being
                // typed re-parses; the finished ones above it are skipped.
                MarkdownBlockView(block: item.element, tail: caret && item.offset == blocks.count - 1, mentions: mentions)
                    .equatable()
                    .padding(.top, blockSpacing(blocks, at: item.offset))
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            openLink?(url) ?? .systemAction(url)
        })
    }
    private func blockSpacing(_ blocks: [MarkdownBlock], at index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        switch (blocks[index - 1], blocks[index]) {
        case (.bullet, .bullet), (.ordered, .ordered), (.bullet, .ordered), (.ordered, .bullet):
            return 4
        case (_, .heading): return 14
        default: return 10
        }
    }

}

/// One block of a reply. Separate from MarkdownText so SwiftUI can compare
/// it and leave it alone when the text it holds has not changed.
private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlock
    let tail: Bool
    let mentions: MentionContext

    /// Body text follows Dynamic Type from the chat's 18pt base.
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 18
    @ScaledMetric(relativeTo: .body) private var codeSize: CGFloat = 14
    @ScaledMetric(relativeTo: .title3) private var h1Size: CGFloat = 21
    @ScaledMetric(relativeTo: .headline) private var h2Size: CGFloat = 19
    @ScaledMetric(relativeTo: .headline) private var h3Size: CGFloat = 17
    @State private var copied = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block == rhs.block && lhs.tail == rhs.tail && lhs.mentions == rhs.mentions
    }

    var body: some View { view(for: block, tail: tail) }

    @ViewBuilder
    private func view(for block: MarkdownBlock, tail: Bool) -> some View {
        switch block {
        case let .paragraph(text):
            inline(text, tail: tail)
                .font(.system(size: bodySize))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

        case let .heading(level, text):
            // Three sizes, not six. A chat bubble is not a document, and an
            // h4 that looks exactly like body text is a heading that failed.
            inline(text, tail: tail)
                .font(.system(size: level <= 1 ? h1Size : level == 2 ? h2Size : h3Size, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)

        case let .bullet(indent, text):
            marker("•", indent: indent, text: text, tail: tail)

        case let .ordered(indent, number, text):
            marker("\(number).", indent: indent, text: text, tail: tail)

        case let .quote(text):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                inline(text, tail: tail)
                    .font(.system(size: bodySize))
                    .foregroundStyle(Color.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .code(language, text):
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(language?.isEmpty == false ? language! : "code")
                        .font(.system(.caption2, design: .monospaced).weight(.medium))
                        .foregroundStyle(Color.secondary)
                    Spacer(minLength: 8)
                    // Copy the snippet alone, not the whole reply around it.
                    // Hidden while it streams: half a command is a bad paste.
                    if !tail {
                        Button {
                            PlatformBridge.copyToPasteboard(text)
                            Haptics.success()
                            withAnimation(.snappy) { copied = true }
                            Task { try? await Task.sleep(for: .seconds(1.5)); withAnimation(.snappy) { copied = false } }
                        } label: {
                            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(copied ? Color.green : Color.secondary)
                                .contentTransition(.symbolEffect(.replace))
                                .padding(.vertical, 4).padding(.horizontal, 6)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(copied ? "Copied" : "Copy code")
                    }
                }
                // Horizontal scroll rather than wrapping: wrapped code is
                // harder to read than code you have to push sideways, and
                // indentation is most of what a snippet is saying.
                ScrollView(.horizontal, showsIndicators: false) {
                    (Text(text) + caretText(tail))
                        .font(.system(size: codeSize, design: .monospaced))
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.secondary.opacity(0.14))
            )

        case .rule:
            Divider().padding(.vertical, 2)
        }
    }

    private func marker(_ symbol: String, indent: Int, text: String, tail: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(symbol)
                .font(.system(size: bodySize))
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 16, alignment: .trailing)
            inline(text, tail: tail).font(.system(size: bodySize)).lineSpacing(3)
        }
        .padding(.leading, CGFloat(indent) * 14)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Inline markdown via Foundation. `.inlineOnlyPreservingWhitespace`
    /// because the blocks are already split — asking for `.full` here would
    /// have it re-interpret list markers this has already consumed.
    ///
    /// Falling back to the raw string on a parse failure is the point: a
    /// half-typed link mid-stream should show as the characters the model has
    /// sent so far, not vanish until it closes the bracket.
    private func inline(_ text: String, tail: Bool = false) -> Text {
        let rendered: Text
        if var attributed = MarkdownCache.inline(text, cache: !tail) {
            attributed.styleMentions(mentions, mine: false)
            rendered = Text(attributed)
        } else {
            var plain = AttributedString(text)
            plain.styleMentions(mentions, mine: false)
            rendered = Text(plain)
        }
        return rendered + caretText(tail)
    }

    /// A figure space then a block, so the caret sits off the last glyph
    /// rather than touching it. Empty when not streaming — an empty `Text`
    /// concatenated in costs nothing and keeps the callers branch-free.
    private func caretText(_ tail: Bool) -> Text {
        tail ? Text("\u{2007}▍").foregroundStyle(Color.secondary) : Text("")
    }
}

/// Parsed markdown, kept across renders. Foundation's markdown parser is the
/// most expensive thing a bubble does, and a lazy transcript asks for it
/// again every time a row scrolls back into view. Bounded; NSCache also
/// drops it under memory pressure. Main-thread only, like the views that
/// read it.
@MainActor
enum MarkdownCache {
    private final class Box<Value> {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    private static let blockCache: NSCache<NSString, Box<[MarkdownBlock]>> = {
        let cache = NSCache<NSString, Box<[MarkdownBlock]>>()
        cache.countLimit = 600
        return cache
    }()

    private static let inlineCache: NSCache<NSString, Box<AttributedString?>> = {
        let cache = NSCache<NSString, Box<AttributedString?>>()
        cache.countLimit = 3_000
        return cache
    }()

    static func blocks(_ source: String) -> [MarkdownBlock] {
        let key = source as NSString
        if let hit = blockCache.object(forKey: key) { return hit.value }
        let blocks = Markdown.blocks(source)
        blockCache.setObject(Box(blocks), forKey: key)
        return blocks
    }

    /// Inline markdown with code spans styled; nil when it does not parse.
    static func inline(_ text: String, cache: Bool = true) -> AttributedString? {
        let key = text as NSString
        if cache, let hit = inlineCache.object(forKey: key) { return hit.value }
        var parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )
        parsed?.styleInlineCode()
        if cache { inlineCache.setObject(Box(parsed), forKey: key) }
        return parsed
    }
}

/// The names a chat's messages can mention, handed down to every bubble so
/// `@name` draws as a token in the bot's colour, the way the desktop marks it.
struct MentionContext: Equatable {
    var peers: [MentionPeer] = []
    var everyone = false
    static let none = MentionContext()
}

private struct MentionContextKey: EnvironmentKey {
    static let defaultValue = MentionContext.none
}

extension EnvironmentValues {
    var mentionContext: MentionContext {
        get { self[MentionContextKey.self] }
        set { self[MentionContextKey.self] = newValue }
    }
}

extension AttributedString {
    /// Each known @mention as a token: bold, in the bot's colour on a light
    /// wash of it. On your own accent bubble it is white on a white wash.
    /// Links and code are left alone, as the desktop leaves them.
    mutating func styleMentions(_ context: MentionContext, mine: Bool) {
        guard !context.peers.isEmpty || context.everyone else { return }
        let plain = String(characters)
        let spans = MentionSpans.find(in: plain, peers: context.peers, everyone: context.everyone)
        guard !spans.isEmpty else { return }
        let count = characters.count
        for span in spans where span.range.upperBound <= count {
            let lower = characters.index(startIndex, offsetBy: span.range.lowerBound)
            let upper = characters.index(startIndex, offsetBy: span.range.upperBound)
            let run = self[lower..<upper]
            if run.runs.contains(where: { $0.link != nil || $0.inlinePresentationIntent?.contains(.code) == true }) { continue }
            let tint = span.peer?.color.map(MausPalette.color) ?? Color.accentColor
            self[lower..<upper].foregroundColor = mine ? BubbleColor.mineText : tint
            self[lower..<upper].backgroundColor = mine ? Color.white.opacity(0.22) : tint.opacity(0.16)
            var intent = self[lower..<upper].inlinePresentationIntent ?? []
            intent.insert(.stronglyEmphasized)
            self[lower..<upper].inlinePresentationIntent = intent
        }
    }

    /// `code` spans on a faint chip, so they read as code and not as prose
    /// in a different font.
    mutating func styleInlineCode() {
        for run in runs where run.inlinePresentationIntent?.contains(.code) == true {
            self[run.range].backgroundColor = Color.secondary.opacity(0.16)
        }
    }
}
