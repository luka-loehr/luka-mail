import Foundation
import Testing
@testable import LukaMail

struct MailHTMLDocumentTests {
    @Test
    func newsletterWithBackgroundsKeepsOriginalColorsOnLightCard() {
        let html = ##"<table bgcolor="#eef1f5"><tr><td style="background:#ffffff;color:#333">Hi</td></tr></table>"##
        let document = MailHTMLDocument.make(source: .html(html), allowRemoteImages: false, isDark: true,
                                             horizontalPadding: 16, verticalPadding: 4)
        #expect(document.appearance == .original)
        #expect(document.showsLightCard)
        #expect(document.forcesLightAppearance)
        #expect(document.html.contains("color:#333"), "Original colors stay untouched on the light card")
    }

    @Test
    func zimbraReplyWithBlackTextAdaptsInDarkMode() {
        let html = #"<div style="font-family: arial; font-size: 12pt; color: #000000">Hallo</div><blockquote style="border-left:2px solid #1010FF;color:#000;">Zitat</blockquote>"#
        let analysis = MailHTMLDocument.analyze(html)
        #expect(analysis.appearance == .adaptive)
        let dark = MailHTMLDocument.adaptTextColors(in: html, isDark: true)
        #expect(!dark.contains("color: #000000"))
        #expect(!dark.contains("color:#000;"))
        #expect(dark.contains("var(--lm-text)"))
        #expect(dark.contains("border-left:2px solid #1010FF"), "Border colors are not text colors")
        let light = MailHTMLDocument.adaptTextColors(in: html, isDark: false)
        #expect(light == html, "Black text is already readable in light mode")
    }

    @Test
    func darkNavyTextBecomesLightTintedInsteadOfGray() throws {
        let navy = try #require(CSSColor("#1F497D"))
        let replacement = try #require(MailHTMLDocument.adaptedColor(navy, isDark: true))
        let adapted = try #require(CSSColor(replacement))
        #expect(adapted.contrast(with: CSSColor(red: 0.11, green: 0.11, blue: 0.118)) >= 4.5)
        #expect(adapted.blue > adapted.red, "Hue is preserved")
    }

    @Test
    func outlookStylesheetAndFontColorsAreAdapted() {
        let html = #"<style>p.MsoNormal { color:windowtext; }</style><p class="MsoNormal"><font color="black">Text</font></p>"#
        let adapted = MailHTMLDocument.adaptTextColors(in: html, isDark: true)
        #expect(adapted.contains("p.MsoNormal { color: var(--lm-text); }"))
        #expect(adapted.contains(#"<font style="color: var(--lm-text)">"#))
    }

    @Test
    func explicitDarkBackgroundUsesOriginalAppearance() {
        let html = ##"<body bgcolor="#111418" text="#e6edf3"><p style="color:#e6edf3">Build passed</p></body>"##
        #expect(MailHTMLDocument.analyze(html).appearance == .original)
    }

    @Test
    func transparentBackgroundsDoNotForceLightCard() {
        let html = #"<div style="background: transparent; background-color: rgba(0,0,0,0)">Hi</div>"#
        #expect(MailHTMLDocument.analyze(html).hasBackgrounds == false)
    }

    @Test
    func darkModeAwareMessageIsTrusted() {
        let html = "<style>body{background:#fff} @media (prefers-color-scheme: dark) { body { background:#000 } }</style>"
        #expect(MailHTMLDocument.analyze(html).appearance == .native)
    }

    @Test
    func detectsRemoteImages() {
        #expect(MailHTMLDocument.analyze(#"<img src="https://example.com/a.png">"#).hasRemoteImages)
        #expect(!MailHTMLDocument.analyze(#"<img src="data:image/png;base64,AAAA">"#).hasRemoteImages)
    }

    @Test
    func plainTextIsEscapedLinkifiedAndQuoted() {
        let html = MailHTMLDocument.plainTextHTML("Hi <b>\nSee https://example.com\n> quoted\n>> nested\nBye")
        #expect(html.contains("&lt;b&gt;"))
        #expect(html.contains(#"<a href="https://example.com">https://example.com</a>"#))
        #expect(html.contains("<blockquote>quoted<blockquote>nested</blockquote></blockquote>"))
        #expect(html.hasSuffix("Bye</div>"))
    }

    @Test
    func inlineImagesReplaceContentIDs() {
        let document = MailHTMLDocument.make(source: .html(#"<img src="cid:logo@x">"#), inlineImages: ["logo@x": "data:image/png;base64,AA"],
                                             allowRemoteImages: false, isDark: false, horizontalPadding: 16, verticalPadding: 4)
        #expect(document.html.contains(#"src="data:image/png;base64,AA""#))
        #expect(document.html.contains("img-src data:;"), "Remote images stay blocked by CSP")
    }

    @Test
    func stripsUntrustedBeaconTagsAndEnforcesHTTPSImagePolicy() {
        let malicious = """
        <link rel="dns-prefetch" href="//beacon.example.com">
        <link rel="preconnect" href="https://beacon.example.com">
        <meta http-equiv="refresh" content="0;url=https://evil.example.com">
        <base href="https://evil.example.com/">
        <script>alert(1)</script>
        <iframe src="https://evil.example.com/frame"></iframe>
        <p>Safe text</p>
        <img srcset="https://cdn.example.com/1x.png 1x, https://cdn.example.com/2x.png 2x">
        """
        let blocked = MailHTMLDocument.make(source: .html(malicious), allowRemoteImages: false, isDark: false,
                                            horizontalPadding: 16, verticalPadding: 4)
        #expect(blocked.analysis.hasRemoteImages)
        #expect(!blocked.html.contains("dns-prefetch"))
        #expect(!blocked.html.contains("preconnect"))
        #expect(!blocked.html.contains("http-equiv=\"refresh\""))
        #expect(!blocked.html.contains("<base"))
        #expect(!blocked.html.contains("<script"))
        #expect(!blocked.html.contains("<iframe"))
        #expect(blocked.html.contains("Safe text"))
        #expect(MailHTMLDocument.contentBlockingRulesJSON(allowRemoteImages: false).contains("^https?://"))

        let allowed = MailHTMLDocument.make(source: .html(malicious), allowRemoteImages: true, isDark: false,
                                            horizontalPadding: 16, verticalPadding: 4)
        #expect(allowed.html.contains("img-src https: data:;"))
        #expect(!allowed.html.contains("http: data:"))
        #expect(MailHTMLDocument.contentBlockingRulesJSON(allowRemoteImages: true).contains("^http://"))
    }

    @Test
    func parsesCSSColors() {
        #expect(CSSColor("#fff") == CSSColor(red: 1, green: 1, blue: 1))
        #expect(CSSColor("rgb(255, 0, 0)") == CSSColor(red: 1, green: 0, blue: 0))
        #expect(CSSColor("rgba(0,0,0,0)")?.alpha == 0)
        #expect(CSSColor("WindowText") == CSSColor(red: 0, green: 0, blue: 0))
        #expect(CSSColor("inherit") == nil)
    }

    @Test
    func mailtoLinksBecomeDrafts() throws {
        let url = try #require(URL(string: "mailto:a@example.com?cc=b@example.com&subject=Hello%20there&body=Hi"))
        guard case .compose(let link) = MailLinkAction.forActivatedLink(url) else {
            Issue.record("mailto should compose")
            return
        }
        let draft = Draft.compose(link, from: "me@example.com")
        #expect(draft.to == ["a@example.com"])
        #expect(draft.cc == ["b@example.com"])
        #expect(draft.subject == "Hello there")
        #expect(MailLinkAction.forActivatedLink(URL(string: "javascript:alert(1)")!) == .ignore)
    }

    @Test
    func replyAllExcludesOwnAddresses() {
        let detail = MailDetail(
            id: "1", threadId: "1", direction: "inbound", folder: "inbox", subject: "Plan",
            sender: MailAddress(address: "a@example.com"),
            recipients: [MailAddress(address: "me@example.com"), MailAddress(address: "b@example.com")],
            preview: "", receivedAt: "2026-10-01T10:00:00Z", unread: false, starred: false, hasAttachments: false,
            attachmentCount: 0, storedAttachmentCount: 0, attachmentsTruncated: false, size: 0, messageId: nil,
            inReplyTo: nil, cc: [MailAddress(address: "c@example.com")], text: "", html: nil, attachments: [],
            thread: [], threadTruncated: false)
        let draft = Draft.replyAll(to: detail, from: "me@example.com", ownAddresses: ["me@example.com"])
        #expect(draft.to == ["a@example.com"])
        #expect(draft.cc == ["b@example.com", "c@example.com"])
        #expect(draft.subject == "Re: Plan")
    }
}
