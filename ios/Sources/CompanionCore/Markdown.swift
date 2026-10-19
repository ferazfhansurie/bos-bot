// Markdown, split into blocks.
//
// The desktop renders bot replies with react-markdown + GFM. The phone was
// showing the source: `**bold**`, `- ` bullets and `[text](url)` arriving as
// literal characters, which is worse than no markdown at all — it is the
// author's intent visible but not applied.
//
// Foundation can already do the *inline* half. `AttributedString(markdown:)`
// handles emphasis, code spans, strikethrough and links, and SwiftUI renders
// the links tappable for free. What it will not do is lay out blocks: with
// `.full` it records a presentation intent and leaves you to draw the bullet,
// the indent and the spacing yourself. So this splits the text into blocks
// and the view draws each one, handing the inline run back to Foundation.
//
// Deliberately not a full CommonMark implementation. It covers what a model
// actually emits into a chat bubble — paragraphs, lists, headings, fences,
// quotes, rules — and treats anything it does not recognise as text, which is
// the failure mode that loses nothing.
import Foundation

public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    /// `indent` is nesting depth, 0 for a top-level item.
    case bullet(indent: Int, text: String)
    case ordered(indent: Int, number: Int, text: String)
    case heading(level: Int, text: String)
    /// A fenced block. `language` is whatever followed the opening fence.
    case code(language: String?, text: String)
    case quote(String)
    case rule
    /// A GFM pipe table: a header row, a `---` row, then body rows. Cells
    /// are raw inline markdown. Rows are padded or cut to the header width.
    case table(headers: [String], rows: [[String]])
}

public enum Markdown {
    /// Split into blocks. Never throws and never drops input: an unparseable
    /// line ends up in a paragraph, which is what the reader wanted anyway.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            // GFM: a single newline inside a paragraph is a soft break, which
            // renders as a space. The desktop does not enable `breaks`, so
            // neither does this — the two should wrap the same way.
            blocks.append(.paragraph(paragraph.joined(separator: " ")))
            paragraph.removeAll()
        }

        // Normalise the line endings before splitting, because
        // `CharacterSet.newlines` contains \r and \n *separately* and
        // `components(separatedBy:)` breaks on each of them: "a\r\nb" comes
        // back as ["a", "", "b"], one phantom empty line per CRLF. That empty
        // line is not cosmetic — it calls `flushParagraph`, so a paragraph
        // written across several lines arrives as one paragraph per line, and
        // a fenced block gains a blank line between every line of code. Tool
        // output and pasted text reach chat bubbles with CRLF intact, so this
        // is a path real messages take.
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var lines = normalised.components(separatedBy: "\n")[...]
        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // A fence runs to its closing fence, or to the end — a reply still
            // streaming has an open one, and showing it as code beats showing
            // three backticks and waiting.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let marker = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                while let next = lines.first {
                    lines = lines.dropFirst()
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix(marker) { break }
                    body.append(next)
                }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                continue
            }

            // --- or *** or ___, three or more, nothing else on the line
            if trimmed.count >= 3, "-*_".contains(trimmed.first!),
               trimmed.allSatisfy({ $0 == trimmed.first! }) {
                flushParagraph()
                blocks.append(.rule)
                continue
            }

            // A pipe row followed by a separator row opens a table; it runs
            // until the first line that is not a pipe row.
            if trimmed.hasPrefix("|"), let next = lines.first,
               let headers = Optional(tableCells(trimmed)), !headers.isEmpty,
               isTableSeparatorRow(next, columns: headers.count) {
                flushParagraph()
                lines = lines.dropFirst()
                var rows: [[String]] = []
                while let row = lines.first, row.trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    lines = lines.dropFirst()
                    var cells = tableCells(row.trimmingCharacters(in: .whitespaces))
                    if cells.count < headers.count { cells += Array(repeating: "", count: headers.count - cells.count) }
                    rows.append(Array(cells.prefix(headers.count)))
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                blocks.append(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
                continue
            }

            if let item = listItem(line) {
                flushParagraph()
                blocks.append(item)
                continue
            }

            paragraph.append(trimmed)
        }
        flushParagraph()
        return blocks
    }

    public static func tableCells(_ line: String) -> [String] {
        var body = line.trimmingCharacters(in: .whitespaces)
        if body.first == "|" { body.removeFirst() }
        if body.last == "|", !body.hasSuffix("\\|") { body.removeLast() }
        var cells: [String] = []
        var cell = ""
        var escaped = false
        for character in body {
            if escaped {
                if character != "|" { cell.append("\\") }
                cell.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func isTableSeparatorRow(_ line: String, columns: Int) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.allSatisfy({ "|-: \t".contains($0) }) else { return false }
        let cells = tableCells(trimmed)
        return cells.count == columns && cells.allSatisfy { cell in
            let core = cell.replacingOccurrences(of: " ", with: "").trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return core.count >= 1 && core.allSatisfy { $0 == "-" }
        }
    }

    private static func heading(_ trimmed: String) -> MarkdownBlock? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = String(trimmed.dropFirst(hashes))
        // "#hashtag" is not a heading; ATX requires the space
        guard rest.hasPrefix(" ") else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> MarkdownBlock? {
        let leading = line.prefix(while: { $0 == " " || $0 == "\t" }).count
        // two spaces per level, which is what a model emits and what GFM
        // treats as nesting for a tight list
        let indent = min(leading / 2, 4)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return .bullet(indent: indent, text: String(trimmed.dropFirst(2)))
        }

        // "1. " / "12) "
        let digits = trimmed.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count <= 9 {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                return .ordered(indent: indent, number: Int(digits) ?? 1, text: String(rest.dropFirst(2)))
            }
        }
        return nil
    }
}
