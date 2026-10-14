import SwiftUI
import UIKit
import CompanionCore

/// Only ordinary bot prose reaches this view. Cards and live tool progress
/// retain their own complete layouts and actions.
struct ExpandableBotReply: View {
    let source: String
    let openLink: (URL) -> OpenURLAction.Result
    @Environment(\.mentionContext) private var mentions
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 18
    @State private var expanded = false
    @State private var fullHeight: CGFloat = 0
    private var sixLines: CGFloat { UIFont.systemFont(ofSize: bodySize).lineHeight * 6 }
    private var preview: AttributedString {
        // Cached: this is the long-reply path, where the parse costs most.
        var text = MarkdownCache.inline(source) ?? AttributedString(source)
        text.styleMentions(mentions, mine: false)
        return text
    }
    var body: some View {
        let preview = preview
        VStack(alignment: .leading, spacing: 6) {
            if expanded {
                MarkdownText(source: source, openLink: openLink).textSelection(.enabled)
            } else {
                Text(preview).font(.system(size: bodySize)).lineLimit(6).textSelection(.enabled)
                    .environment(\.openURL, OpenURLAction(handler: openLink))
            }
            if fullHeight > sixLines + 1 {
                Button {
                    withAnimation(.snappy(duration: 0.25)) { expanded.toggle() }
                } label: {
                    Label(expanded ? "Show less" : "Show more", systemImage: expanded ? "chevron.up" : "chevron.down")
                        .labelStyle(.titleAndIcon)
                        .font(.caption.weight(.semibold))
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .accessibilityLabel(expanded ? "Collapse bot reply" : "Expand bot reply")
            }
        }
        .background(alignment: .topLeading) {
            Text(preview).font(.system(size: bodySize)).lineLimit(nil).fixedSize(horizontal: false, vertical: true)
                .background { GeometryReader { proxy in Color.clear.onAppear { fullHeight = proxy.size.height }.onChange(of: proxy.size.height) { _, value in fullHeight = value } } }
                .hidden().accessibilityHidden(true)
        }
        .onChange(of: source) { _, _ in expanded = false }
    }
}
