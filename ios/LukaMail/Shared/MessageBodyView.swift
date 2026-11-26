import SwiftUI

/// Renders a message body with the platform web view, deciding between an adaptive body and
/// a light card (see `MailHTMLDocument`), and offering to load blocked remote images.
struct MessageBodyView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @Environment(\.composeMessage) private var compose

    let message: MailDetail
    let inlineImages: [String: String]
    /// Inset of the body text from the content edges, matching the message header.
    let horizontalPadding: CGFloat

    @State private var document: MailHTMLDocument?
    @State private var contentHeight: CGFloat = 0
    @State private var remoteImagesAllowedForMessage = false

    private var allowsRemoteImages: Bool { store.loadRemoteImages || remoteImagesAllowedForMessage }

    private struct RenderKey: Hashable {
        let source: MailBodySource
        let inlineImageIDs: [String]
        let allowsRemoteImages: Bool
        let isDark: Bool
    }

    private var renderKey: RenderKey {
        RenderKey(source: message.bodySource, inlineImageIDs: inlineImages.keys.sorted(),
                  allowsRemoteImages: allowsRemoteImages, isDark: colorScheme == .dark)
    }

    /// Light cards are inset from the content edges so their rounded corners read as a card.
    private var cardInset: CGFloat { horizontalPadding * 0.75 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let document, document.analysis.hasRemoteImages, !allowsRemoteImages {
                remoteImagesNotice
                    .padding(.horizontal, horizontalPadding)
            }
            if let document {
                MailWebView(document: document, contentHeight: $contentHeight, onLink: handle)
                    .frame(height: max(contentHeight, 1))
                    .background(document.showsLightCard ? Color.white : Color.clear)
                    .clipShape(.rect(cornerRadius: document.showsLightCard ? 16 : 0, style: .continuous))
                    .padding(.horizontal, document.showsLightCard ? cardInset : 0)
                    .accessibilityLabel("Message body")
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 120)
            }
        }
        .task(id: renderKey) {
            let rendered = await MailHTMLDocument.render(
                source: message.bodySource,
                inlineImages: inlineImages,
                allowRemoteImages: allowsRemoteImages,
                isDark: colorScheme == .dark,
                horizontalPadding: Int(horizontalPadding),
                verticalPadding: 4,
                // On a light card the page keeps its own margin inside the inset card.
                cardPadding: (Int(horizontalPadding - cardInset), 16)
            )
            guard !Task.isCancelled else { return }
            document = rendered
        }
    }

    private var remoteImagesNotice: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                noticeLabel
                Spacer(minLength: 0)
                loadImagesButton
            }
            VStack(alignment: .leading, spacing: 8) {
                noticeLabel
                loadImagesButton
            }
        }
        .padding(12)
        .background(.fill.tertiary, in: .rect(cornerRadius: MailDesign.chipCornerRadius, style: .continuous))
    }

    private var noticeLabel: some View {
        Label("Remote images are hidden to protect your privacy.", systemImage: "eye.slash")
            .font(.footnote)
            .foregroundStyle(.secondary)
    }

    private var loadImagesButton: some View {
        Button("Load Images") { remoteImagesAllowedForMessage = true }
            .buttonStyle(.bordered)
            .controlSize(.small)
    }

    private func handle(_ action: MailLinkAction) {
        switch action {
        case .openExternally(let url): openURL(url)
        case .compose(let link): compose(.compose(link, from: store.selectedInbox))
        case .ignore: break
        }
    }
}
