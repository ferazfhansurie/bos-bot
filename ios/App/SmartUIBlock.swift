// A reply's ```chart, ```stats and ```openui blocks, drawn full width by the
// same components the desktop chat uses.
//
// The components are web: rather than a second copy in SwiftUI that drifts
// from the desktop, each block is a transparent WKWebView over the bundled
// SmartUI/smart-ui.html (built by `pnpm build:smart-ui`), sized to its
// content. The page has no network (its CSP allows inline code and data:
// only); the bridge carries its height, saved values, button presses and
// links back here. A block it can't draw comes back as the code card.
import SwiftUI
import WebKit
import CompanionCore

/// The live transcript's hooks: post as the person into this thread, and
/// save a block's values onto its message. Set once on the transcript.
struct SmartUIThread {
    let send: (String) -> Void
    let save: (_ messageId: String, _ key: String, _ state: [String: JSONValue]) -> Void

    func actions(for message: Message) -> SmartUIActions {
        SmartUIActions(messageId: message.id, states: message.uiState, send: send) { save(message.id, $0, $1) }
    }
}

private struct SmartUIThreadKey: EnvironmentKey {
    static let defaultValue: SmartUIThread? = nil
}

/// What a block can do in the thread it sits in. Absent outside a live
/// transcript (shared links, previews): blocks still draw, buttons stay quiet.
final class SmartUIActions {
    let messageId: String
    let states: [String: [String: JSONValue]]?
    let send: (String) -> Void
    let save: (_ key: String, _ state: [String: JSONValue]) -> Void

    init(messageId: String, states: [String: [String: JSONValue]]?,
         send: @escaping (String) -> Void,
         save: @escaping (_ key: String, _ state: [String: JSONValue]) -> Void) {
        self.messageId = messageId
        self.states = states
        self.send = send
        self.save = save
    }
}

private struct SmartUIActionsKey: EnvironmentKey {
    static let defaultValue: SmartUIActions? = nil
}

/// bos bot 3.0 is on (the mac's features.v3 mirror): blocks get the
/// desktop's card polish. Cards draw either way.
private struct SmartUIV3Key: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var smartUIThread: SmartUIThread? {
        get { self[SmartUIThreadKey.self] }
        set { self[SmartUIThreadKey.self] = newValue }
    }

    var smartUIActions: SmartUIActions? {
        get { self[SmartUIActionsKey.self] }
        set { self[SmartUIActionsKey.self] = newValue }
    }

    var smartUIV3: Bool {
        get { self[SmartUIV3Key.self] }
        set { self[SmartUIV3Key.self] = newValue }
    }
}

enum SmartUI {
    static let languages: Set<String> = ["chart", "stats", "openui", "openui-lang"]

    static func handles(_ language: String?) -> Bool {
        language.map { languages.contains($0.lowercased()) } ?? false
    }

    static let page = Bundle.main.url(forResource: "smart-ui", withExtension: "html")

    /// Heights already measured, so a block scrolled back on screen, a
    /// streamed reply settling or a chat reopened on one opens at its size
    /// instead of growing into it. Kept across launches: a block growing
    /// as the chat opens left a reader at the end short of it.
    @MainActor private(set) static var heights: [String: CGFloat] =
        (UserDefaults.standard.dictionary(forKey: heightsKey) as? [String: Double])?.mapValues { CGFloat($0) } ?? [:]
    private static let heightsKey = "smartUI.heights"

    @MainActor static func remember(_ height: CGFloat, for key: String) {
        guard heights[key] != height else { return }
        if heights.count >= 400 { heights.removeAll() }
        heights[key] = height
        UserDefaults.standard.set(heights.mapValues { Double($0) }, forKey: heightsKey)
    }

    /// A key that stays the same across launches (`hashValue` doesn't).
    static func stableHash(_ text: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100_0000_01b3 }
        return String(hash, radix: 36)
    }
    /// Values typed this session, ahead of the server echoing them back.
    @MainActor static var live: [String: [String: [String: JSONValue]]] = [:]
    static let processPool = WKProcessPool()
}

struct SmartUIBlock<Fallback: View>: View {
    let language: String
    let code: String
    let streaming: Bool
    @ViewBuilder let fallback: () -> Fallback

    @Environment(\.colorScheme) private var scheme
    @Environment(\.smartUIActions) private var actions
    @Environment(\.smartUIV3) private var v3
    @Environment(\.openURL) private var openURL
    @State private var height: CGFloat?
    @State private var failed = false

    private var cacheKey: String { "\(scheme == .dark ? "d" : "l")\(v3 ? "3" : "")\(language)\(SmartUI.stableHash(code))" }

    var body: some View {
        if failed || SmartUI.page == nil {
            VStack(alignment: .leading, spacing: 6) {
                fallback()
                if language.lowercased().hasPrefix("openui") {
                    Text("couldn't draw this")
                        .font(.system(size: 12))
                        .foregroundStyle(GPT.secondaryText)
                }
            }
        } else {
            SmartUIWebView(payload: payload, onEvent: handle)
                .frame(maxWidth: .infinity)
                .frame(height: height ?? SmartUI.heights[cacheKey] ?? 120)
                .accessibilityElement(children: .contain)
        }
    }

    private var payload: [String: Any] {
        var states: [String: Any] = [:]
        if let actions {
            for (key, value) in actions.states ?? [:] { states[key] = SmartUIWebView.plain(.object(value)) }
            for (key, value) in SmartUI.live[actions.messageId] ?? [:] { states[key] = SmartUIWebView.plain(.object(value)) }
        }
        return [
            "lang": language,
            "code": code,
            "streaming": streaming,
            "theme": scheme == .dark ? "dark" : "light",
            "states": states,
            "cards": true,
            "v3": v3,
        ]
    }

    private func handle(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "height":
            guard let value = event["value"] as? Double, value > 0 else { return }
            let next = CGFloat(value)
            if height != next { height = next }
            if !streaming { SmartUI.remember(next, for: cacheKey) }
        case "failed":
            if !streaming { failed = true }
        case "assistant":
            if let text = event["text"] as? String, !text.isEmpty { actions?.send(text) }
        case "openUrl":
            if let raw = event["url"] as? String, let url = URL(string: raw),
               ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                openURL(url)
            }
        case "state":
            guard let actions, let key = event["key"] as? String,
                  let raw = event["state"],
                  let data = try? JSONSerialization.data(withJSONObject: raw),
                  let state = try? JSONDecoder().decode([String: JSONValue].self, from: data)
            else { return }
            SmartUI.live[actions.messageId, default: [:]][key] = state
            actions.save(key, state)
        default:
            break
        }
    }
}

/// The transparent page one block draws in. Renders again whenever the
/// payload changes (a streaming block grows, the theme flips).
private struct SmartUIWebView: UIViewRepresentable {
    let payload: [String: Any]
    let onEvent: ([String: Any]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.processPool = SmartUI.processPool
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(WeakHandler(context.coordinator), name: "bosSmartUI")
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.navigationDelegate = context.coordinator
        context.coordinator.view = view
        context.coordinator.onEvent = onEvent
        context.coordinator.pending = payload
        if let page = SmartUI.page { view.loadFileURL(page, allowingReadAccessTo: page) }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onEvent = onEvent
        context.coordinator.render(payload)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "bosSmartUI")
    }

    /// JSONValue back to the Foundation types JSONSerialization writes.
    static func plain(_ value: JSONValue) -> Any {
        switch value {
        case .null: return NSNull()
        case let .bool(v): return v
        case let .number(v): return v
        case let .string(v): return v
        case let .array(v): return v.map(plain)
        case let .object(v): return v.mapValues(plain)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var view: WKWebView?
        var onEvent: (([String: Any]) -> Void)?
        var pending: [String: Any]?
        private var ready = false
        private var sent: String?

        func render(_ payload: [String: Any]) {
            pending = payload
            guard ready, let view,
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8),
                  json != sent
            else { return }
            sent = json
            view.evaluateJavaScript("window.bosSmartUI.render(\(json))")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let event = message.body as? [String: Any] else { return }
            if event["type"] as? String == "ready" {
                ready = true
                if let pending { render(pending) }
                return
            }
            onEvent?(event)
        }

        /// Only the bundled page itself loads here; anything else is a link.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.request.url?.isFileURL == true, action.request.url == SmartUI.page {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                onEvent?(["type": "openUrl", "url": url.absoluteString])
            }
        }

        /// The page's process can be reclaimed while off screen; draw again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            ready = false
            sent = nil
            webView.reload()
        }
    }

    /// The content controller retains its handlers; this keeps it from
    /// keeping the coordinator (and through it the view) alive.
    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: WKScriptMessageHandler?
        init(_ target: WKScriptMessageHandler) { self.target = target }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(controller, didReceive: message)
        }
    }
}
