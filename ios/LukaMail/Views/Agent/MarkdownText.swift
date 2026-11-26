import SwiftUI

/// Renders the agent's Markdown: paragraphs, headings, bullet and numbered
/// lists, quotes, code blocks and tables, with inline bold, italics, code and
/// links. SwiftUI's own Markdown support is inline-only.
struct MarkdownText: View {
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownBlock.parse(source).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            Text(Self.inline(text))
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
            Text(Self.inline(text))
                .font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.weight(.semibold))
                .padding(.top, 4)
        case .list(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.marker)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(Self.inline(item.text))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.indent) * 16)
                }
            }
        case .quote(let text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(.tint.opacity(0.5))
                    .frame(width: 3)
                Text(Self.inline(text))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .code(let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.callout.monospaced())
                    .padding(12)
            }
            .background(.fill.tertiary, in: .rect(cornerRadius: 12))
        case .table(let header, let rows):
            MarkdownTable(header: header, rows: rows)
        case .rule:
            Divider()
        }
    }

    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

private struct MarkdownTable: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        Text(MarkdownText.inline(cell)).font(.subheadline.weight(.semibold))
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(header.indices), id: \.self) { column in
                            Text(MarkdownText.inline(column < row.count ? row[column] : ""))
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: 260, alignment: .leading)
                        }
                    }
                }
            }
            .padding(12)
        }
        .background(.fill.quaternary, in: .rect(cornerRadius: 12))
    }
}

enum MarkdownBlock: Equatable {
    struct Item: Equatable {
        let marker: String
        let text: String
        let indent: Int
    }

    case paragraph(String)
    case heading(Int, String)
    case list([Item])
    case quote(String)
    case code(String)
    case table([String], [[String]])
    case rule

    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var items: [Item] = []
        var quote: [String] = []
        var table: [[String]] = []
        var code: [String]?

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !items.isEmpty { blocks.append(.list(items)); items = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
            if !table.isEmpty {
                let header = table[0]
                blocks.append(table.count > 1 ? .table(header, Array(table.dropFirst())) : .paragraph(header.joined(separator: " · ")))
                table = []
            }
        }

        for rawLine in source.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if var lines = code {
                if line.hasPrefix("```") {
                    blocks.append(.code(lines.joined(separator: "\n")))
                    code = nil
                } else {
                    lines.append(rawLine)
                    code = lines
                }
                continue
            }
            if line.hasPrefix("```") { flush(); code = []; continue }
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("|"), line.hasSuffix("|") {
                if table.isEmpty { flush() }
                let cells = line.dropFirst().dropLast().split(separator: "|", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                if cells.allSatisfy({ $0.allSatisfy { "-: ".contains($0) } && !$0.isEmpty }) { continue }
                table.append(cells)
                continue
            }
            if !table.isEmpty { flush() }
            if line == "---" || line == "***" || line == "___" { flush(); blocks.append(.rule); continue }
            if let heading = line.firstMatch(of: #/^(#{1,4})\s+(.+)$/#) {
                flush()
                blocks.append(.heading(heading.1.count, String(heading.2)))
                continue
            }
            if line.hasPrefix(">") {
                if !paragraph.isEmpty || !items.isEmpty { flush() }
                quote.append(line.drop(while: { $0 == ">" }).trimmingCharacters(in: .whitespaces))
                continue
            }
            let indent = (rawLine.prefix(while: { $0 == " " }).count) / 2
            if let bullet = line.firstMatch(of: #/^[-*•]\s+(.+)$/#) {
                if !paragraph.isEmpty || !quote.isEmpty { flush() }
                items.append(Item(marker: "•", text: String(bullet.1), indent: min(indent, 3)))
                continue
            }
            if let numbered = line.firstMatch(of: #/^(\d{1,3})[.)]\s+(.+)$/#) {
                if !paragraph.isEmpty || !quote.isEmpty { flush() }
                items.append(Item(marker: "\(numbered.1).", text: String(numbered.2), indent: min(indent, 3)))
                continue
            }
            if !items.isEmpty || !quote.isEmpty { flush() }
            paragraph.append(line)
        }
        if let lines = code { blocks.append(.code(lines.joined(separator: "\n"))) }
        flush()
        return blocks
    }
}
