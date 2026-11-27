import AppKit
import SwiftUI
import WebKit

/// The message is sized to its full height, so scroll events belong to the enclosing
/// SwiftUI scroll view rather than WKWebView's internal one.
private final class MailContentWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        var ancestor = superview
        while let view = ancestor {
            if let scrollView = view as? NSScrollView {
                scrollView.scrollWheel(with: event)
                return
            }
            ancestor = view.superview
        }
        super.scrollWheel(with: event)
    }
}

/// Sandboxed WKWebView for a message body. Message JavaScript is disabled; the layout script
/// that fits wide content and reports the height runs in an isolated content world.
struct MailWebView: NSViewRepresentable {
    let document: MailHTMLDocument
    @Binding var contentHeight: CGFloat
    let onLink: (MailLinkAction) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let controller = configuration.userContentController
        controller.add(context.coordinator, contentWorld: .defaultClient, name: MailHTMLDocument.heightMessageName)
        controller.addUserScript(WKUserScript(source: MailHTMLDocument.layoutScript, injectionTime: .atDocumentEnd,
                                              forMainFrameOnly: true, in: .defaultClient))
        let webView = MailContentWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.underPageBackgroundColor = .clear
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = true
        webView.allowsBackForwardNavigationGestures = false
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.contentHeight = $contentHeight
        context.coordinator.onLink = onLink
        webView.appearance = document.forcesLightAppearance ? NSAppearance(named: .aqua) : nil
        let needsReload = context.coordinator.loadedHTML != document.html
            || context.coordinator.loadedAllowRemoteImages != document.allowRemoteImages
        guard needsReload else { return }
        context.coordinator.loadedHTML = document.html
        context.coordinator.loadedAllowRemoteImages = document.allowRemoteImages
        let html = document.html
        let allowRemote = document.allowRemoteImages
        Task { @MainActor in
            await Self.applyContentRules(to: webView, allowRemoteImages: allowRemote)
            guard context.coordinator.loadedHTML == html else { return }
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    private static func applyContentRules(to webView: WKWebView, allowRemoteImages: Bool) async {
        let controller = webView.configuration.userContentController
        controller.removeAllContentRuleLists()
        let identifier = allowRemoteImages ? "lm-mac-https-only" : "lm-mac-block-remote"
        let source = MailHTMLDocument.contentBlockingRulesJSON(allowRemoteImages: allowRemoteImages)
        if let ruleList = try? await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: identifier,
            encodedContentRuleList: source
        ) {
            controller.add(ruleList)
        }
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var loadedHTML = ""
        var loadedAllowRemoteImages: Bool?
        var contentHeight: Binding<CGFloat>?
        var onLink: (MailLinkAction) -> Void = { _ in }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == MailHTMLDocument.heightMessageName,
                  let height = (message.body as? NSNumber)?.doubleValue, height > 0 else { return }
            contentHeight?.wrappedValue = CGFloat(height)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if action.navigationType == .linkActivated {
                onLink(MailLinkAction.forActivatedLink(url))
                return .cancel
            }
            // Only the document loaded by `loadHTMLString` may occupy the frame; this blocks
            // meta refreshes and other message-authored navigations.
            return url.scheme == "about" ? .allow : .cancel
        }

        /// Links with `target="_blank"` ask for a new web view instead of navigating.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { onLink(MailLinkAction.forActivatedLink(url)) }
            return nil
        }
    }
}
