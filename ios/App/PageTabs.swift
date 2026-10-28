import Combine
import SwiftUI
import WebKit
import CompanionCore

// Pages a bot opened beside this conversation (open_tab, app_create). The
// desktop shows them as a tab; the phone shows a "Page · title" card at the
// end of the thread that opens the page full screen. A page that declares
// itself a mini app opens as one. Everything else renders in a locked
// webview: no network, no bridge, no navigation, nothing kept between opens.

struct PageTabCards: View {
    let botId: String
    let threadId: String
    @EnvironmentObject private var session: Session
    @State private var pages: [PageTab] = []
    @State private var opened: PageTab?

    /// More than this and the end of the thread is all cards.
    private static let shown = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(pages.filter { $0.gone != true }.prefix(Self.shown)) { page in
                Button { opened = page } label: { PageTabCard(page: page) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("page-tab-\(page.displayTitle)")
            }
        }
        .task(id: "\(threadId)-\(session.appsOnline)") { await load() }
        .onReceive(session.pageTabsOpened.filter { [threadId] in $0 == threadId }
            .debounce(for: .milliseconds(400), scheduler: RunLoop.main)) { _ in
            Task { await load() }
        }
        .fullScreenCover(item: $opened) { page in
            if let appId = page.appId {
                MiniAppScreen(app: AppSummary(id: appId, botId: botId, name: page.displayTitle)).session(session)
            } else {
                PageTabScreen(botId: botId, threadId: threadId, page: page).session(session)
            }
        }
    }

    private func load() async {
        guard session.appsOnline else { return }
        // an older computer has no /api/page-tabs: no cards, not an error
        if let next = try? await session.loadPageTabs(botId: botId, threadId: threadId) { pages = next }
    }
}

private struct PageTabCard: View {
    let page: PageTab

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: page.appId == nil ? "doc.richtext" : "square.grid.2x2")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 34, height: 34)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                (Text(page.appId == nil ? "Page" : "App").foregroundStyle(.secondary) + Text(verbatim: " · ") .foregroundStyle(.secondary)
                    + Text(verbatim: page.displayTitle).foregroundStyle(.primary))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text("Tap to open")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: 360, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.06)))
        .contentShape(Rectangle())
    }
}

/// One page, full screen. It follows the file: while open it checks every
/// few seconds and reloads when the bot edits it.
struct PageTabScreen: View {
    let botId: String
    let threadId: String
    let page: PageTab
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var html: String?
    @State private var mtime: Double?
    @State private var error: String?

    private static let pollSeconds: Double = 3

    var body: some View {
        NavigationStack {
            Group {
                if let html {
                    LockedPageView(html: html).ignoresSafeArea(edges: .bottom)
                } else if let error {
                    ContentUnavailableView("Can't open this page", systemImage: "exclamationmark.triangle", description: Text(error))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(page.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .task {
            await load()
            // follow edits: the list carries each file's mtime, so the html
            // itself is only fetched again when it changed
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.pollSeconds))
                guard session.appsOnline,
                      let pages = try? await session.loadPageTabs(botId: botId, threadId: threadId),
                      let now = pages.first(where: { $0.path == page.path })?.mtime,
                      now != mtime else { continue }
                await load()
            }
        }
    }

    private func load() async {
        do {
            let next = try await session.loadPageTab(botId: botId, threadId: threadId, path: page.path)
            mtime = next.mtime
            if next.html != html { html = next.html }
            error = nil
        } catch {
            if html == nil { self.error = error.localizedDescription }
        }
    }
}

/// The page with nothing it could reach: an offline content rule list (no
/// requests leave), a throwaway data store, no script handlers, no new
/// windows and no navigation after the first load.
private struct LockedPageView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.allowsInlineMediaPlayback = true
        config.dataDetectorTypes = []
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsLinkPreview = false
        context.coordinator.web = web
        context.coordinator.load(html)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.html != html { context.coordinator.load(html) }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var web: WKWebView?
        var html: String?
        private var allowLoad = false

        func load(_ html: String) {
            self.html = html
            Task {
                // fail closed: no rule list, no page
                guard let rules = await MiniAppRules.shared(), let web else { return }
                web.configuration.userContentController.removeAllContentRuleLists()
                web.configuration.userContentController.add(rules)
                allowLoad = true
                web.loadHTMLString(html, baseURL: nil)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            let scheme = action.request.url?.scheme?.lowercased()
            if action.targetFrame?.isMainFrame == true, scheme == "about", allowLoad {
                allowLoad = false
                decisionHandler(.allow)
            } else if action.targetFrame?.isMainFrame == true, action.navigationType == .other, scheme == "about",
                      action.request.url?.fragment != nil {
                // an in-page #anchor
                decisionHandler(.allow)
            } else if action.targetFrame?.isMainFrame == false, scheme == "about" || scheme == "data" {
                // an inline iframe the page drew itself
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if let html { load(html) }
        }
    }
}
