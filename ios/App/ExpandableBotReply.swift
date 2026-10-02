import SwiftUI
import UIKit
import CompanionCore

/// Only ordinary bot prose reaches this view. Cards and live tool progress
/// retain their own complete layouts and actions.
struct ExpandableBotReply: View {
    let source: String
    let openLink: (URL) -> OpenURLAction.Result
    @State private var expanded = false
    @State private var fullHeight: CGFloat = 0
    private var sixLines: CGFloat { UIFont.systemFont(ofSize: 18).lineHeight * 6 }
    private var preview: AttributedString {
        (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if expanded {
                MarkdownText(source: source, openLink: openLink).textSelection(.enabled)
            } else {
                Text(preview).font(.system(size: 18)).lineLimit(6).textSelection(.enabled)
                    .environment(\.openURL, OpenURLAction(handler: openLink))
            }
            if fullHeight > sixLines + 1 {
                Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                    .font(.caption.weight(.semibold)).accessibilityLabel(expanded ? "Collapse bot reply" : "Expand bot reply")
            }
        }
        .background(alignment: .topLeading) {
            Text(preview).font(.system(size: 18)).lineLimit(nil).fixedSize(horizontal: false, vertical: true)
                .background { GeometryReader { proxy in Color.clear.onAppear { fullHeight = proxy.size.height }.onChange(of: proxy.size.height) { _, value in fullHeight = value } } }
                .hidden().accessibilityHidden(true)
        }
        .onChange(of: source) { _, _ in expanded = false }
    }
}
