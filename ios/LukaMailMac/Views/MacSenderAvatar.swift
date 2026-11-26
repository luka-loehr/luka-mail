import AppKit
import CryptoKit
import ImageIO
import SwiftUI

struct MacSenderAvatar: View {
    @Environment(MailStore.self) private var store
    @Environment(\.displayScale) private var displayScale
    @State private var loadedLogo: LoadedSenderLogo?

    let name: String
    let address: String
    let avatarColor: String?
    let messageID: String?
    var size: CGFloat = 36

    var body: some View {
        let cachedAsset = store.cachedSenderLogo(address: address)
        let displayedLogo = (loadedLogo?.taskID == taskID ? loadedLogo?.image : nil)
            ?? MacSenderLogoImageCache.shared.cachedImage(
            address: normalizedAddress,
            cacheVersion: store.logoCacheVersion,
            etag: cachedAsset?.etag,
            pixelSize: pixelSize
        )
        Group {
            if let displayedLogo {
                Image(nsImage: displayedLogo)
                    .resizable()
                    .interpolation(.high)
                    .antialiased(true)
                    .scaledToFit()
                    .background(Color(nsColor: .windowBackgroundColor))
            } else {
                MonogramAvatar(name: name, address: address, avatarColor: avatarColor, size: size)
            }
        }
        .frame(width: size, height: size)
        .clipShape(.circle)
        .overlay { Circle().stroke(.primary.opacity(0.08), lineWidth: 1) }
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
            let image = await MacSenderLogoImageCache.shared.image(
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
    let image: NSImage
}

@MainActor
private final class MacSenderLogoImageCache {
    static let shared = MacSenderLogoImageCache()

    private let images = NSCache<NSString, NSImage>()
    private var requests: [String: Task<NSImage?, Never>] = [:]
    private var addressAliases: [String: String] = [:]

    private init() {
        images.countLimit = 256
        images.totalCostLimit = 16 * 1_024 * 1_024
    }

    func cachedImage(address: String, cacheVersion: Int, etag: String?, pixelSize: Int) -> NSImage? {
        let assetID = Self.normalizedETag(etag)
            ?? addressAliases[Self.aliasKey(address: address, cacheVersion: cacheVersion)]
        guard let assetID else { return nil }
        return images.object(forKey: Self.cacheKey(assetID: assetID, pixelSize: pixelSize) as NSString)
    }

    func image(asset: SenderLogoAsset, address: String, cacheVersion: Int, pixelSize: Int) async -> NSImage? {
        let assetID = await Self.assetID(for: asset)
        addressAliases[Self.aliasKey(address: address, cacheVersion: cacheVersion)] = assetID
        let cacheKey = Self.cacheKey(assetID: assetID, pixelSize: pixelSize)
        if let image = images.object(forKey: cacheKey as NSString) { return image }
        if let request = requests[cacheKey] { return await request.value }

        let request = Task.detached(priority: .utility) {
            Self.decode(asset, pixelSize: pixelSize)
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

    nonisolated private static func decode(_ asset: SenderLogoAsset, pixelSize: Int) -> NSImage? {
        if !asset.contentType.localizedCaseInsensitiveContains("svg"),
           let source = CGImageSourceCreateWithData(asset.data as CFData, nil),
           let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
               kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceCreateThumbnailWithTransform: true,
               kCGImageSourceThumbnailMaxPixelSize: max(pixelSize, 1),
               kCGImageSourceShouldCacheImmediately: true,
           ] as CFDictionary) {
            let image = NSImage(cgImage: thumbnail, size: NSSize(width: pixelSize, height: pixelSize))
            image.cacheMode = .always
            return image
        }

        // AppKit has a native SVG representation, avoiding a WebKit process per list row.
        guard let image = NSImage(data: asset.data) else { return nil }
        image.cacheMode = .always
        return image
    }

    nonisolated private static func estimatedCost(of image: NSImage) -> Int {
        let pixelsWide = max(Int(image.size.width * 2), 1)
        let pixelsHigh = max(Int(image.size.height * 2), 1)
        return min(pixelsWide * pixelsHigh * 4, 512 * 1_024)
    }
}
