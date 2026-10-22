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
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 14

    /// ChatGPT's rhythm, in quarters of the font size: paragraphs 4s apart,
    /// headings 4s above, code blocks 5s, rules 7s, list items close.
    private func blockSpacing(_ blocks: [MarkdownBlock], at index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        let s = bodySize / 4
        switch (blocks[index - 1], blocks[index]) {
        case (.bullet, .bullet), (.ordered, .ordered), (.bullet, .ordered), (.ordered, .bullet):
            return s
        case (.heading, .paragraph), (.heading, .bullet), (.heading, .ordered):
            return s
        case (.paragraph, .bullet), (.paragraph, .ordered):
            return s
        case (_, .heading): return 4 * s
        case (.code, _), (_, .code): return 5 * s
        case (.rule, _), (_, .rule): return 7 * s
        case (_, .table), (.table, _): return 4 * s
        default: return 4 * s
        }
    }

}

/// One block of a reply. Separate from MarkdownText so SwiftUI can compare
/// it and leave it alone when the text it holds has not changed.
private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlock
    let tail: Bool
    let mentions: MentionContext

    /// ChatGPT's specified 14pt prose, line height
    /// 1.625 × the font, headings at 1.5, 1.25 and 1.125.
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 14
    @ScaledMetric(relativeTo: .body) private var codeSize: CGFloat = 12
    @State private var copied = false
    @State private var wraps = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block == rhs.block && lhs.tail == rhs.tail && lhs.mentions == rhs.mentions
    }

    private var s: CGFloat { bodySize / 4 }
    private var lineSpacing: CGFloat { bodySize * 0.42 }

    var body: some View { view(for: block, tail: tail) }

    @ViewBuilder
    private func view(for block: MarkdownBlock, tail: Bool) -> some View {
        switch block {
        case let .paragraph(text):
            inline(text, tail: tail)
                .font(.system(size: bodySize))
                .lineSpacing(lineSpacing)
                .fixedSize(horizontal: false, vertical: true)

        case let .heading(level, text):
            inline(text, tail: tail)
                .font(.system(size: bodySize * (level <= 1 ? 1.5 : level == 2 ? 1.25 : level == 3 ? 1.125 : 1), weight: .semibold))
                .lineSpacing(s)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)

        case let .bullet(indent, text):
            marker(["•", "◦", "▪"][min(indent, 2)], indent: indent, text: text, tail: tail)

        case let .ordered(indent, number, text):
            marker("\(number).", indent: indent, text: text, tail: tail)

        case let .quote(text):
            inline(text, tail: tail)
                .font(.system(size: bodySize))
                .lineSpacing(lineSpacing)
                .padding(.vertical, 2 * s)
                .padding(.leading, 6 * s)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: s / 2)
                        .fill(GPT.strongBorder)
                        .frame(width: s)
                        .padding(.vertical, 2 * s)
                }
                .fixedSize(horizontal: false, vertical: true)

        case let .code(language, text):
            if let language, SmartUI.handles(language) {
                SmartUIBlock(language: language, code: text, streaming: tail) {
                    codeBlock(language: language, text: text, tail: tail)
                }
            } else {
                codeBlock(language: language, text: text, tail: tail)
            }

        case let .table(headers, rows):
            table(headers: headers, rows: rows)

        case .rule:
            Rectangle().fill(GPT.strongBorder).frame(height: 1)
        }
    }

    /// The CODEX code block: 20pt corners, a 48pt header with the language,
    /// Copy and word wrap, then the snippet in its syntax colours.
    private func codeBlock(language: String?, text: String, tail: Bool) -> some View {
        let code = (Text(CodeHighlighter.highlight(text, language: language)) + caretText(tail))
            .font(.system(size: codeSize, design: .monospaced))
            .lineSpacing(max(0, codeSize * 0.5))
            .textSelection(.enabled)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(GPT.secondaryText)
                Text(language?.isEmpty == false ? language! : "Code")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(GPT.secondaryText)
                    .lineLimit(1)
                Spacer(minLength: 8)
                // Hidden while it streams: half a command is a bad paste.
                if !tail {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { wraps.toggle() }
                    } label: {
                        Image(systemName: wraps ? "arrow.right.to.line" : "text.word.spacing")
                            .font(.system(size: 13, weight: .medium))
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(GPT.secondaryText)
                    .accessibilityLabel(wraps ? "Disable word wrap" : "Enable word wrap")
                    Button {
                        PlatformBridge.copyToPasteboard(text)
                        Haptics.success()
                        withAnimation(.snappy) { copied = true }
                        Task { try? await Task.sleep(for: .seconds(1.5)); withAnimation(.snappy) { copied = false } }
                    } label: {
                        Image(systemName: copied ? "checkmark" : "square.on.square")
                            .font(.system(size: 13, weight: .medium))
                            .contentTransition(.symbolEffect(.replace))
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(GPT.secondaryText)
                    .accessibilityLabel(copied ? "Copied" : "Copy code")
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .frame(minHeight: 48)

            Group {
                if wraps {
                    code.fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        code.fixedSize(horizontal: true, vertical: true)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GPT.codeBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(GPT.subtleBorder))
    }

    /// The small table: semibold header over a strong rule, subtle rules
    /// between rows, tabular figures; wide ones scroll sideways.
    private func table(headers: [String], rows: [[String]]) -> some View {
        let small = max(codeSize, bodySize * 0.875)
        let columns = headers.count
        return ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(0..<columns, id: \.self) { column in
                        inline(headers[column])
                            .font(.system(size: small, weight: .semibold))
                            .padding(.vertical, 2 * s)
                            .padding(.trailing, column == columns - 1 ? 0 : 6 * s)
                    }
                }
                Rectangle().fill(GPT.strongBorder).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(0..<columns, id: \.self) { column in
                            inline(column < row.count ? row[column] : "")
                                .font(.system(size: small).monospacedDigit())
                                .padding(.vertical, 2.5 * s)
                                .padding(.trailing, column == columns - 1 ? 0 : 6 * s)
                        }
                    }
                    if index < rows.count - 1 {
                        Rectangle().fill(GPT.subtleBorder).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
            .fixedSize(horizontal: true, vertical: true)
        }
        .accessibilityIdentifier("markdown-table")
    }

    private func marker(_ symbol: String, indent: Int, text: String, tail: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 1.5 * s) {
            Text(symbol)
                .font(.system(size: bodySize, weight: .semibold))
                .frame(minWidth: 16, alignment: .trailing)
            inline(text, tail: tail).font(.system(size: bodySize)).lineSpacing(lineSpacing)
        }
        .padding(.leading, CGFloat(indent) * bodySize * 1.4 + 4)
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

/// The CODEX theme's colours on a snippet: comments, strings, numbers,
/// keywords, called functions. A small scanner, not a grammar: it is right
/// for the common shapes and never worse than plain text.
enum CodeHighlighter {
    private static let keywords: Set<String> = [
        "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "defer",
        "do", "elif", "else", "enum", "export", "extends", "extension", "false", "final", "fn", "for", "from",
        "func", "function", "guard", "if", "impl", "import", "in", "interface", "is", "let", "match", "mut", "new",
        "nil", "None", "null", "private", "protocol", "pub", "public", "return", "self", "Self", "static", "struct",
        "super", "switch", "this", "throw", "throws", "true", "True", "False", "try", "type", "typeof", "undefined",
        "use", "var", "void", "where", "while", "with", "yield", "echo", "then", "fi", "done", "esac",
        "select", "insert", "update", "delete", "where", "join", "on", "and", "or", "not", "limit", "order", "by",
        "SELECT", "FROM", "WHERE", "JOIN", "ON", "AND", "OR", "NOT", "LIMIT", "ORDER", "BY", "INSERT", "UPDATE",
    ]

    static func highlight(_ text: String, language: String?) -> AttributedString {
        let lang = (language ?? "").lowercased()
        let hashComments = ["sh", "bash", "zsh", "shell", "python", "py", "ruby", "rb", "yaml", "yml", "toml", "r", "perl"].contains(lang)
        let dashComments = ["sql", "lua", "haskell"].contains(lang)
        var out = AttributedString()
        let chars = Array(text)
        var i = 0
        var plain = ""
        func flush() {
            guard !plain.isEmpty else { return }
            var run = AttributedString(plain)
            run.foregroundColor = GPT.codeText
            out += run
            plain = ""
        }
        func emit(_ piece: String, _ color: Color) {
            flush()
            var run = AttributedString(piece)
            run.foregroundColor = color
            out += run
        }
        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            // Comments to the end of the line.
            if (c == "/" && next == "/" && !hashComments) || (c == "#" && hashComments) || (c == "-" && next == "-" && dashComments) {
                var j = i
                while j < chars.count, chars[j] != "\n" { j += 1 }
                emit(String(chars[i..<j]), GPT.codeComment)
                i = j
                continue
            }
            // Strings.
            if c == "\"" || c == "'" || c == "`" {
                var j = i + 1
                while j < chars.count, chars[j] != c {
                    if chars[j] == "\\" { j += 1 }
                    if j < chars.count, chars[j] == "\n", c != "`" { break }
                    j += 1
                }
                j = min(chars.count, j + 1)
                emit(String(chars[i..<j]), GPT.codeString)
                i = j
                continue
            }
            // Numbers.
            if c.isNumber, plain.last.map({ !$0.isLetter && $0 != "_" }) ?? true {
                var j = i
                while j < chars.count, chars[j].isNumber || chars[j] == "." || chars[j] == "_" || chars[j] == "x" { j += 1 }
                emit(String(chars[i..<j]), GPT.codeNumber)
                i = j
                continue
            }
            // Words: keywords, calls, $variables.
            if c.isLetter || c == "_" || c == "$" || c == "@" {
                var j = i + 1
                while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" { j += 1 }
                let word = String(chars[i..<j])
                if keywords.contains(word) {
                    emit(word, GPT.codeKeyword)
                } else if c == "$" || c == "@" {
                    emit(word, GPT.codeVariable)
                } else if j < chars.count, chars[j] == "(" {
                    emit(word, GPT.codeFunction)
                } else if word.first?.isUppercase == true {
                    emit(word, GPT.codeFunction)
                } else if i > 0, chars[i - 1] == "." {
                    emit(word, GPT.codeVariable)
                } else {
                    plain += word
                }
                i = j
                continue
            }
            plain.append(c)
            i += 1
        }
        flush()
        return out
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
    /// wash of it. Your neutral bubble uses the theme's user-text colour.
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
            self[lower..<upper].foregroundColor = mine ? GPT.userText : tint
            self[lower..<upper].backgroundColor = mine ? GPT.softFill : tint.opacity(0.16)
            var intent = self[lower..<upper].inlinePresentationIntent ?? []
            intent.insert(.stronglyEmphasized)
            self[lower..<upper].inlinePresentationIntent = intent
        }
    }

    /// `code` spans on a faint chip, so they read as code and not as prose
    /// in a different font.
    mutating func styleInlineCode() {
        for run in runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                self[run.range].backgroundColor = GPT.inlineCode
                self[run.range].font = .subheadline.monospaced()
            }
            // ChatGPT's links keep the text colour over a dotted underline.
            if run.link != nil {
                self[run.range].foregroundColor = Color.primary
                self[run.range].underlineStyle = Text.LineStyle(pattern: .dot, color: GPT.tertiaryText)
            }
        }
    }
}
