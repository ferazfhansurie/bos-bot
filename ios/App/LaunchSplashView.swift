import SwiftUI
import WebKit

/// Decorative cold-launch overlay; connection and deep-link handling run underneath.
struct LaunchSplashView: UIViewRepresentable {
    var onFinished: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinished: onFinished) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "splashDone")
        controller.addUserScript(WKUserScript(source: "window.addEventListener('bos-splash-done',()=>window.webkit.messageHandlers.splashDone.postMessage('done'),{once:true});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 13/255, green: 13/255, blue: 13/255, alpha: 1)
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        if let url = Bundle.main.url(forResource: "bos-splash", withExtension: "html") {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.query = "hold=1"
            view.loadFileURL(components.url!, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            DispatchQueue.main.async { context.coordinator.finish() }
        }
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "splashDone")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private var finished = false
        private let onFinished: () -> Void
        init(onFinished: @escaping () -> Void) { self.onFinished = onFinished }
        func finish() {
            guard !finished else { return }
            finished = true
            onFinished()
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "splashDone", message.frameInfo.isMainFrame { finish() }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("window.BosSplash?.exit()") { _, error in
                if error != nil { self.finish() }
            }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish() }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel)
        }
    }
}
