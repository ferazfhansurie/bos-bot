// Mini apps on the phone: every bot's apps in one grid, each opened full
// screen in a locked webview that talks to the computer the way the
// desktop tab does, and links from bosbot.my/a/… added from here.
//
// The webview is the desktop's sandbox rebuilt natively: the page loads
// from a string with no base url, a content rule list blocks every load but
// about:, data: and blob:, the CSP and WebRTC strip run before the page's
// own code, and the bridge posts to `messageHandlers.bos`. The page never
// names its app: this side answers under the app id it opened. While the
// computer is away the app opens from its last loaded copy, read-only.
import SwiftUI
import WebKit
import Combine
import CompanionCore

enum MiniAppIcon {
    /// The desktop's lucide names → SF Symbols.
    static func symbol(_ name: String?) -> String {
        switch name {
        case "users": return "person.2"
        case "briefcase": return "briefcase"
        case "table": return "tablecells"
        case "file-text": return "doc.text"
        case "kanban": return "rectangle.split.3x1"
        case "receipt": return "doc.plaintext"
        case "box": return "shippingbox"
        case "calendar": return "calendar"
        case "heart": return "heart"
        case "star": return "star"
        case "shopping-cart": return "cart"
        case "package": return "shippingbox.fill"
        case "clipboard-list": return "list.clipboard"
        case "wallet": return "wallet.pass"
        case "graduation-cap": return "graduationcap"
        case "home": return "house"
        default: return "square.grid.2x2"
        }
    }
}

/// `-open-app a-…` at launch opens that app and prints what its page drew,
/// so `devicectl device process launch --console` can check an app opens on
/// a real phone. Without the flag it does nothing.
enum MiniAppProbe {
    static let appId: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-open-app"), i + 1 < args.count, MiniApps.validAppId(args[i + 1]) else { return nil }
        return args[i + 1]
    }()
    @MainActor static var opened = false
    static func log(_ line: String) { print("[mini-app] \(line)"); fflush(stdout) }
}

private func describe(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}

// MARK: - Grid

struct AppsView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var apps: [AppSummary] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var opened: AppSummary?
    @State private var adding = false

    private var bots: [Bot] { session.state.bots.filter { $0.hidden != true } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !session.appsOnline {
                        Label("Your computer is offline. Apps open read-only from their last copy.", systemImage: "wifi.slash")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let error, apps.isEmpty {
                        Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.secondary)
                    }
                    if apps.isEmpty && loaded {
                        ContentUnavailableView("No apps yet", systemImage: "square.grid.2x2",
                                               description: Text("Ask a bot to make one, like “make me a crm”, or add one from a link."))
                    } else if !loaded {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(groups, id: \.name) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(verbatim: group.name)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.secondary)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
                                ForEach(group.apps) { app in
                                    Button {
                                        Haptics.selection()
                                        opened = app
                                    } label: { AppTile(app: app) }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                .padding(16)
            }
            .refreshable { await load() }
            .navigationTitle("Apps")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { adding = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add from link")
                        .disabled(!session.appsOnline)
                }
            }
        }
        // the roster can land after the stream goes live; reload when it does
        .task(id: "\(session.appsOnline)-\(bots.count)") { await load() }
        // a new, renamed or deleted app; record changes leave the grid alone
        .onReceive(session.appChanges
            .filter { [apps] change in change.meta == true || change.deleted == true || !apps.contains { $0.id == change.appId } }
            .debounce(for: .seconds(1), scheduler: RunLoop.main)) { _ in
            Task { await load() }
        }
        .fullScreenCover(item: $opened) { app in
            MiniAppScreen(app: app).session(session)
        }
        .sheet(isPresented: $adding) {
            InstallAppSheet { result in
                adding = false
                Task {
                    await load()
                    try? await Task.sleep(for: .milliseconds(450))
                    opened = result.app
                }
            }
            .session(session)
        }
    }

    private var groups: [(name: String, apps: [AppSummary])] {
        let known = Set(bots.map(\.id))
        var out = bots.compactMap { bot -> (String, [AppSummary])? in
            let mine = apps.filter { $0.botId == bot.id }
            return mine.isEmpty ? nil : (bot.name, mine)
        }
        let other = apps.filter { !known.contains($0.botId) }
        if !other.isEmpty { out.append(("Other", other)) }
        return out
    }

    private func load() async {
        if session.appsOnline {
            do {
                apps = try await session.loadApps().sorted { $0.updatedAt > $1.updatedAt }
                error = nil
                loaded = true
                probe()
                return
            } catch {
                self.error = describe(error)
            }
        }
        apps = (session.appCache?.list() ?? []).sorted { $0.updatedAt > $1.updatedAt }
        loaded = true
        probe()
    }

    private func probe() {
        guard let id = MiniAppProbe.appId, !MiniAppProbe.opened else { return }
        MiniAppProbe.log("grid \(apps.count) apps, online \(session.appsOnline)")
        if let app = apps.first(where: { $0.id == id }) {
            MiniAppProbe.opened = true
            opened = app
        } else if session.appsOnline, !bots.isEmpty {
            MiniAppProbe.opened = true
            MiniAppProbe.log("not in grid \(id)")
        }
    }
}

private struct AppTile: View {
    let app: AppSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: MiniAppIcon.symbol(app.icon))
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 36, height: 36)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: app.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(app.recordCount == 1 ? "1 record" : "\(app.recordCount) records")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.06)))
        .contentShape(Rectangle())
        .accessibilityIdentifier("app-tile-\(app.id)")
    }
}

// MARK: - One app

struct MiniAppScreen: View {
    let app: AppSummary
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var page: AppPage?
    @State private var error: String?
    @State private var gone = false

    var body: some View {
        NavigationStack {
            Group {
                if gone {
                    ContentUnavailableView("This app was deleted", systemImage: "trash")
                } else if let page, let kit = MiniAppKit.bundled {
                    MiniAppWebView(appId: app.id, name: page.app.name, html: kit.document(html: page.html), kit: kit,
                                   theme: colorScheme == .dark ? "dark" : "light", online: session.appsOnline,
                                   session: session, deleted: { gone = true })
                        .ignoresSafeArea(edges: .bottom)
                } else if let error {
                    ContentUnavailableView("Can't open this app", systemImage: "exclamationmark.triangle", description: Text(error))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(page?.app.name ?? app.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                if !session.appsOnline && page != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Label("Read only", systemImage: "lock").labelStyle(.titleAndIcon).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task(id: session.appsOnline) { await load() }
        // its page changed (renamed, edited): load the new one
        .onReceive(session.appChanges.filter { [id = app.id] in $0.appId == id && $0.meta == true }) { _ in
            Task { await load() }
        }
    }

    private func load() async {
        if session.appsOnline {
            do { page = try await session.loadAppPage(app.id); error = nil; return } catch { self.error = describe(error) }
        }
        if let error, MiniAppProbe.appId == app.id { MiniAppProbe.log("page error \(error)") }
        if let cached = session.appCache?.page(app.id) { page = cached; return }
        if page == nil && error == nil {
            error = "Your computer is offline and this app hasn't been opened on this phone yet."
        }
    }
}

/// The locked webview. Everything the page asks for goes through
/// `Coordinator.handle`, under `appId`.
struct MiniAppWebView: UIViewRepresentable {
    let appId: String
    let name: String
    let html: String
    let kit: MiniAppKit
    let theme: String
    let online: Bool
    let session: Session
    let deleted: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        coordinator.parent = self
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.allowsInlineMediaPlayback = true
        config.dataDetectorTypes = []
        let controller = config.userContentController
        // policy before the page: the WebRTC strip, then the bridge, both in
        // the main frame only and before any of the app's own script runs
        controller.addUserScript(WKUserScript(source: kit.noRtc, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: kit.bridgeScript(frameId: coordinator.frameId), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakScriptHandler(coordinator), contentWorld: .page, name: "bos")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = coordinator
        web.uiDelegate = coordinator
        web.allowsLinkPreview = false
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never
        coordinator.web = web
        coordinator.online = online
        coordinator.subscribe()
        coordinator.load(html)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if coordinator.html != html { coordinator.load(html) }
        // back online: the page re-reads everything it shows
        if online && !coordinator.online { coordinator.run(MiniAppBridge.changedScript(frameId: coordinator.frameId, collections: [], all: true)) }
        coordinator.online = online
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "bos", contentWorld: .page)
        coordinator.changes = nil
        web.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        static let inflightLimit = 32
        let frameId = UUID().uuidString.lowercased()
        var parent: MiniAppWebView?
        weak var web: WKWebView?
        var html: String?
        var online = false
        var changes: AnyCancellable?
        private var allowLoad = false
        private var inflight = 0

        func subscribe() {
            guard let parent else { return }
            let appId = parent.appId
            changes = parent.session.appChanges
                .filter { $0.appId == appId }
                .receive(on: RunLoop.main)
                .sink { [weak self] change in
                    guard let self else { return }
                    if change.deleted == true { self.parent?.deleted(); return }
                    if !change.collections.isEmpty {
                        self.run(MiniAppBridge.changedScript(frameId: self.frameId, collections: change.collections))
                    }
                }
        }

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

        func run(_ script: String) {
            web?.evaluateJavaScript(script, in: nil, in: .page) { _ in }
        }

        // MARK: bridge

        nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let isMain = message.frameInfo.isMainFrame
            let body = message.body
            MainActor.assumeIsolated {
                guard isMain, message.webView === web, let parent else { return }
                switch MiniAppBridge.message(body, frameId: frameId) {
                case .ignore:
                    return
                case .hello:
                    run(MiniAppBridge.initScript(frameId: frameId, appId: parent.appId, name: parent.name, theme: parent.theme))
                    if MiniAppProbe.appId == parent.appId { MiniAppProbe.log("hello \(parent.appId)") }
                case let .call(.invalid(rid, error)):
                    if let rid { reply(rid, .error(error)) }
                case let .call(.request(request)):
                    guard inflight < Self.inflightLimit else { reply(request.rid, .error("too many requests at once")); return }
                    inflight += 1
                    Task {
                        let result = await handle(request, parent: parent)
                        inflight -= 1
                        reply(request.rid, result)
                        if MiniAppProbe.appId == parent.appId { probe(request, result) }
                    }
                }
            }
        }

        private func probe(_ request: BridgeRequest, _ result: MiniAppBridge.Reply) {
            switch result {
            case let .value(.array(records)): MiniAppProbe.log("\(request.op.rawValue) \(request.collection) \(records.count) records")
            case .value: MiniAppProbe.log("\(request.op.rawValue) \(request.collection) ok")
            case let .error(error): MiniAppProbe.log("\(request.op.rawValue) \(request.collection) error \(error)")
            }
            Task {
                try? await Task.sleep(for: .seconds(1))
                let text = try? await web?.evaluateJavaScript("document.body ? document.body.innerText : ''", in: nil, contentWorld: .page) as? String
                let drawn = (text ?? "").split(whereSeparator: \.isNewline).prefix(4).joined(separator: " | ")
                MiniAppProbe.log("drew \((text ?? "").count) chars: \(drawn.prefix(160))")
            }
        }

        private func reply(_ rid: Int, _ result: MiniAppBridge.Reply) {
            run(MiniAppBridge.replyScript(frameId: frameId, rid: rid, result: result))
        }

        private func handle(_ request: BridgeRequest, parent: MiniAppWebView) async -> MiniAppBridge.Reply {
            let session = parent.session
            let appId = parent.appId
            let live = session.appsOnline
            do {
                switch request.op {
                case .list:
                    if live { return .value(.array(try await session.appRecords(appId, collection: request.collection))) }
                    guard let cached = session.appCache?.records(appId: appId, collection: request.collection) else {
                        return .error("offline: not loaded on this phone yet")
                    }
                    return .value(.array(cached))
                case .get:
                    guard let id = request.id else { return .error("bad request") }
                    if live { return .value(try await session.appRecord(appId, collection: request.collection, id: id)) }
                    let cached = session.appCache?.records(appId: appId, collection: request.collection) ?? []
                    let match = cached.first { if case let .object(fields) = $0, fields["id"] == .string(id) { return true }; return false }
                    return .value(match ?? .null)
                case .put, .patch, .remove:
                    guard live else { return .error("offline: read only") }
                    guard let op = MiniAppBridge.writeOp(request) else { return .error("bad request") }
                    let records = try await session.appWrite(appId, ops: [op])
                    return request.op == .remove ? .value(.bool(true)) : .value(records.first ?? .null)
                }
            } catch {
                return .error(describe(error))
            }
        }

        // MARK: navigation: the one page load, nothing else

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            let scheme = action.request.url?.scheme?.lowercased()
            if allowLoad && action.targetFrame?.isMainFrame == true && scheme == "about" {
                allowLoad = false
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

/// WKUserContentController holds its handlers strongly; the coordinator
/// holds the webview. This breaks the loop.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Blocks every load except about:, data: and blob: (both local; the CSP
/// allows them for images and media), compiled once per launch.
@MainActor
enum MiniAppRules {
    private static var compiled: WKContentRuleList?
    private static let json = #"""
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]
    """#

    static func shared() async -> WKContentRuleList? {
        if let compiled { return compiled }
        let list = await withCheckedContinuation { (done: CheckedContinuation<WKContentRuleList?, Never>) in
            WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "bos-mini-app-offline", encodedContentRuleList: json) { list, _ in
                done.resume(returning: list)
            }
        }
        compiled = list
        return list
    }
}

// MARK: - Add from a link

struct InstallAppSheet: View {
    var installed: (InstallResult) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var preview: InstallPreviewResponse?
    @State private var checking = false
    @State private var installing = false
    @State private var error: String?
    @State private var botId = ""

    private var bots: [Bot] { session.state.bots.filter { $0.hidden != true } }
    private var botName: String { bots.first { $0.id == botId }?.name ?? "this bot" }

    var body: some View {
        NavigationStack {
            Form {
                if let preview {
                    loaded(preview.preview)
                } else {
                    Section {
                        TextField("bosbot.my/a/…", text: $link)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .submitLabel(.go)
                            .onSubmit { Task { await check() } }
                        PasteButton(payloadType: String.self) { strings in
                            let text = strings.joined(separator: " ")
                            link = MiniApps.installLink(in: text) ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task { await check() }
                        }
                    } footer: {
                        Text("Paste a mini app link. You'll see what it asks for before anything is added.")
                    }
                    if checking {
                        Section { HStack(spacing: 10) { ProgressView(); Text("fetching it and checking what it asks for").foregroundStyle(.secondary) } }
                    }
                }
                if let error {
                    Section {
                        Label("can't add this app", systemImage: "exclamationmark.triangle").font(.subheadline.weight(.semibold))
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(preview?.preview.manifest.name ?? "Add an app")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("cancel") { dismiss() }.disabled(installing) }
                ToolbarItem(placement: .confirmationAction) {
                    if let preview {
                        Button(installing ? "adding…" : (existing(preview.preview) != nil ? "update" : "add app")) { Task { await install(preview) } }
                            .disabled(installing || botId.isEmpty)
                    } else {
                        Button("next") { Task { await check() } }.disabled(checking || link.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .interactiveDismissDisabled(installing)
        .onAppear { if botId.isEmpty { botId = bots.first?.id ?? "" } }
    }

    @ViewBuilder
    private func loaded(_ preview: InstallPreview) -> some View {
        let manifest = preview.manifest
        Section {
            HStack(spacing: 12) {
                Image(systemName: MiniAppIcon.symbol(manifest.icon))
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 40, height: 40)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: manifest.name).font(.headline)
                    Text(verbatim: header(preview)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let description = manifest.description, !description.isEmpty {
                Text(verbatim: description).font(.subheadline)
            }
        }
        Section("it can") {
            let permission = MiniApps.permissionLine(collections: manifest.collections, botName: botName)
            VStack(alignment: .leading, spacing: 2) {
                Label(permission.text, systemImage: "tray.full")
                Text(permission.detail).font(.caption).foregroundStyle(.secondary)
            }
            Label(MiniApps.neverLine, systemImage: "lock")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        Section {
            Picker("runs with", selection: $botId) {
                ForEach(bots) { bot in Text(verbatim: bot.name).tag(bot.id) }
            }
        } footer: {
            if let existing = existing(preview) {
                Text(existing.version == manifest.version
                     ? "\(botName) already has v\(existing.version). adding it again keeps its data."
                     : "updates v\(existing.version) to v\(manifest.version). keeps its data.")
            }
        }
    }

    private func header(_ preview: InstallPreview) -> String {
        var parts = ["v\(preview.manifest.version)", preview.builtin ? "made by bos bot" : preview.host]
        if let author = preview.manifest.author, !author.isEmpty { parts.append("by \(author)") }
        return parts.joined(separator: " · ")
    }

    private func existing(_ preview: InstallPreview) -> InstallPreview.Existing? { preview.existing[botId] }

    private func check() async {
        guard !checking else { return }
        let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let url = MiniApps.installLink(in: text) ?? MiniApps.normalizeInstallURL(text) else {
            error = "That isn't an https link."
            return
        }
        checking = true
        error = nil
        defer { checking = false }
        do {
            preview = try await session.previewAppInstall(url: url)
        } catch {
            self.error = describe(error)
        }
    }

    private func install(_ response: InstallPreviewResponse) async {
        installing = true
        error = nil
        defer { installing = false }
        do {
            let result = try await session.installApp(token: response.token, botId: botId)
            Haptics.success()
            installed(result)
        } catch {
            self.error = describe(error)
        }
    }
}
