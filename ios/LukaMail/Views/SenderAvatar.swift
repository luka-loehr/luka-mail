import CryptoKit
import SwiftUI
import WebKit

struct SenderAvatar: View {
    @Environment(MailStore.self) private var store
    @Environment(\.displayScale) private var displayScale
    @State private var loadedLogo: LoadedSenderLogo?
    let name: String
    let address: String
    let avatarColor: String?
    let messageID: String?
    var size: CGFloat = 44

    var body: some View {
        let cachedAsset = store.cachedSenderLogo(address: address)
        let displayedLogo = (loadedLogo?.taskID == taskID ? loadedLogo?.image : nil)
            ?? SenderLogoImageCache.shared.cachedImage(
            address: normalizedAddress,
            cacheVersion: store.logoCacheVersion,
            etag: cachedAsset?.etag,
            pixelSize: pixelSize
        )
        Group {
            if let displayedLogo {
                BIMILogoView(image: displayedLogo)
                    .background(Color(uiColor: .systemBackground))
            } else {
                MonogramAvatar(name: name, address: address, avatarColor: avatarColor, size: size)
            }
        }
        .frame(width: size, height: size)
        .clipShape(.circle)
        .task(id: taskID) {
            loadedLogo = nil
            let asset: SenderLogoAsset?
            if let cached = cachedAsset {
                asset = cached
            } else if let messageID {
                asset = await store.senderLogoData(messageID: messageID, address: address)
            } else {
                asset = nil
            }
            guard !Task.isCancelled, let asset else {
                return
            }
            let image = await SenderLogoImageCache.shared.image(
                asset: asset,
                address: normalizedAddress,
                cacheVersion: store.logoCacheVersion,
                pixelSize: pixelSize
            )
            guard !Task.isCancelled else { return }
            loadedLogo = image.map { LoadedSenderLogo(taskID: taskID, image: $0) }
        }
        .accessibilityHidden(true)
    }

    private var normalizedAddress: String {
        address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var pixelSize: Int {
        max(Int((size * displayScale).rounded(.up)), 1)
    }

    private var taskID: SenderLogoTaskID {
        SenderLogoTaskID(address: normalizedAddress, cacheVersion: store.logoCacheVersion, pixelSize: pixelSize)
    }
}

private struct SenderLogoTaskID: Hashable {
    let address: String
    let cacheVersion: Int
    let pixelSize: Int
}

private struct LoadedSenderLogo {
    let taskID: SenderLogoTaskID
    let image: UIImage
}

struct BIMILogoView: View {
    let image: UIImage

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .interpolation(.high)
            .antialiased(true)
            .scaledToFit()
    }
}

@MainActor
final class SenderLogoImageCache {
    static let shared = SenderLogoImageCache()

    private let images = NSCache<NSString, UIImage>()
    private var requests: [String: Task<UIImage?, Never>] = [:]
    private var addressAliases: [String: String] = [:]

    private init() {
        images.countLimit = 256
        images.totalCostLimit = 24 * 1_024 * 1_024
    }

    func cachedImage(address: String, cacheVersion: Int, etag: String?, pixelSize: Int) -> UIImage? {
        let assetID = Self.normalizedETag(etag)
            ?? addressAliases[Self.aliasKey(address: address, cacheVersion: cacheVersion)]
        guard let assetID else { return nil }
        return images.object(forKey: Self.cacheKey(assetID: assetID, pixelSize: pixelSize) as NSString)
    }

    func image(asset: SenderLogoAsset, address: String, cacheVersion: Int, pixelSize: Int) async -> UIImage? {
        let assetID = await Self.assetID(for: asset)
        addressAliases[Self.aliasKey(address: address, cacheVersion: cacheVersion)] = assetID
        let cacheKey = Self.cacheKey(assetID: assetID, pixelSize: pixelSize)
        if let image = images.object(forKey: cacheKey as NSString) { return image }
        if let request = requests[cacheKey] { return await request.value }

        let request: Task<UIImage?, Never>
        if asset.contentType.localizedCaseInsensitiveContains("svg") {
            request = Task {
                await SVGLogoRenderer.shared.render(
                    data: asset.data,
                    contentType: asset.contentType,
                    pixelSize: pixelSize
                )
            }
        } else {
            request = Task.detached(priority: .utility) {
                Self.decodeBitmap(asset.data, pixelSize: pixelSize)
            }
        }
        requests[cacheKey] = request
        let image = await request.value
        requests[cacheKey] = nil
        if let image {
            images.setObject(image, forKey: cacheKey as NSString, cost: Self.estimatedCost(of: image))
        }
        return image
    }

    nonisolated private static func assetID(for asset: SenderLogoAsset) async -> String {
        if let etag = normalizedETag(asset.etag) {
            return etag
        }
        return await Task.detached(priority: .utility) {
            SHA256.hash(data: asset.data).map { String(format: "%02x", $0) }.joined()
        }.value
    }

    nonisolated private static func cacheKey(assetID: String, pixelSize: Int) -> String {
        "\(assetID)|\(pixelSize)"
    }

    nonisolated private static func aliasKey(address: String, cacheVersion: Int) -> String {
        "\(cacheVersion)|\(address)"
    }

    nonisolated private static func normalizedETag(_ etag: String?) -> String? {
        guard let value = etag?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    nonisolated private static func decodeBitmap(_ data: Data, pixelSize: Int) -> UIImage? {
        guard let source = UIImage(data: data) else { return nil }
        let size = CGSize(width: pixelSize, height: pixelSize)
        return source.preparingThumbnail(of: size)
            ?? source.preparingForDisplay()
            ?? source
    }

    nonisolated private static func estimatedCost(of image: UIImage) -> Int {
        let pixelsWide = max(Int(image.size.width * image.scale), 1)
        let pixelsHigh = max(Int(image.size.height * image.scale), 1)
        return min(pixelsWide * pixelsHigh * 4, 1_024 * 1_024)
    }
}

@MainActor
private final class SVGLogoRenderer: NSObject, WKNavigationDelegate {
    static let shared = SVGLogoRenderer()

    private struct PendingRequest {
        let id: UUID
        let data: Data
        let pixelSize: Int
        let continuation: CheckedContinuation<UIImage?, Never>
    }

    private struct ActiveRequest {
        let request: PendingRequest
        var navigation: WKNavigation?
        var timeout: Task<Void, Never>?
    }

    private var pending: [PendingRequest] = []
    private var current: ActiveRequest?
    private lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 64, height: 64), configuration: configuration)
        view.navigationDelegate = self
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        return view
    }()

    func render(data: Data, contentType: String, pixelSize: Int) async -> UIImage? {
        let mimeType = contentType.components(separatedBy: ";").first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard mimeType == "image/svg+xml", !data.isEmpty, data.count <= 2_000_000 else { return nil }
        return await withCheckedContinuation { continuation in
            pending.append(PendingRequest(
                id: UUID(),
                data: data,
                pixelSize: pixelSize,
                continuation: continuation
            ))
            startNextIfNeeded()
        }
    }

    private func startNextIfNeeded() {
        guard current == nil, !pending.isEmpty else { return }
        let request = pending.removeFirst()
        current = ActiveRequest(request: request, navigation: nil, timeout: nil)
        let scale = max(webView.traitCollection.displayScale, 1)
        let pointSize = max(CGFloat(request.pixelSize) / scale, 1)
        webView.frame = CGRect(x: 0, y: 0, width: pointSize, height: pointSize)
        let source = "data:image/svg+xml;base64,\(request.data.base64EncodedString())"
        let document = """
        <!doctype html>
        <html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
        <style>
        html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: transparent; }
        body { display: flex; align-items: center; justify-content: center; }
        img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center; }
        </style></head><body><img alt="" src="\(source)"></body></html>
        """
        guard let navigation = webView.loadHTMLString(document, baseURL: nil) else {
            finish(id: request.id, with: nil)
            return
        }
        let requestID = request.id
        let timeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(5)) }
            catch { return }
            guard !Task.isCancelled else { return }
            self?.finish(id: requestID, with: nil)
        }
        guard current?.request.id == requestID else {
            timeout.cancel()
            return
        }
        current?.navigation = navigation
        current?.timeout = timeout
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let navigation, let active = current, active.navigation === navigation else { return }
        let requestID = active.request.id
        let configuration = WKSnapshotConfiguration()
        configuration.rect = webView.bounds
        configuration.afterScreenUpdates = true
        webView.takeSnapshot(with: configuration) { [weak self] image, _ in
            Task { @MainActor [weak self] in
                self?.finish(id: requestID, with: image)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard let navigation, let active = current, active.navigation === navigation else { return }
        finish(id: active.request.id, with: nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let navigation, let active = current, active.navigation === navigation else { return }
        finish(id: active.request.id, with: nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let active = current else { return }
        finish(id: active.request.id, with: nil)
    }

    private func finish(id: UUID, with image: UIImage?) {
        guard let active = current, active.request.id == id else { return }
        active.timeout?.cancel()
        webView.stopLoading()
        current = nil
        active.request.continuation.resume(returning: image)
        startNextIfNeeded()
    }
}
