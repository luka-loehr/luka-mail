import Foundation

struct CachedSenderLogo: Codable, Sendable {
    let asset: SenderLogoAsset?
}

struct CachedMailSession: Codable, Sendable {
    let who: WhoAmI
    let identities: [MailIdentity]
}

struct CacheSnapshot<Value: Sendable>: Sendable {
    let savedAt: Date
    let value: Value
}

struct BlobCacheEntry: Sendable {
    let url: URL
    let size: Int64
    let modifiedAt: Date
}

actor MailCache {
    private struct Envelope<Value: Codable>: Codable {
        let savedAt: Date
        let value: Value
    }

    private let directory: URL
    private let removeDirectory: @Sendable (URL) throws -> Void
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var blobPruneTask: Task<Void, Never>?
    private var blobPruneTaskID: UUID?
    private var lastBlobPruneAt: Date?
    private var cacheGeneration: UInt64 = 0

    init(
        directory: URL? = nil,
        removeDirectory: @escaping @Sendable (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
    ) {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.directory = directory ?? root.appending(path: "LukaMail/Cache", directoryHint: .isDirectory)
        self.removeDirectory = removeDirectory
    }

    func page(for mailbox: Mailbox, endpoint: String, identity: String) -> MessagePage? {
        pageSnapshot(for: mailbox, endpoint: endpoint, identity: identity)?.value
    }
    func pageSnapshot(for mailbox: Mailbox, endpoint: String, identity: String) -> CacheSnapshot<MessagePage>? {
        snapshot("page-v2-\(scope(endpoint: endpoint, identity: identity))-\(mailbox.rawValue).json")
    }
    func save(_ page: MessagePage, for mailbox: Mailbox, endpoint: String, identity: String) {
        write(page, to: "page-v2-\(scope(endpoint: endpoint, identity: identity))-\(mailbox.rawValue).json")
    }
    func detail(id: String, endpoint: String, identity: String) -> MailDetail? {
        read("detail-v2-\(scope(endpoint: endpoint, identity: identity))-\(stableHash(id)).json")
    }
    func save(_ detail: MailDetail, endpoint: String, identity: String) {
        write(detail, to: "detail-v2-\(scope(endpoint: endpoint, identity: identity))-\(stableHash(detail.id)).json")
    }

    func session(endpoint: String) -> CachedMailSession? {
        read("session-v1-\(endpointScope(endpoint)).json")
    }
    func saveSession(_ session: CachedMailSession, endpoint: String) {
        write(session, to: "session-v1-\(endpointScope(endpoint)).json")
    }

    func summary(endpoint: String, identity: String) -> MailSummary? {
        read("summary-v1-\(scope(endpoint: endpoint, identity: identity)).json")
    }
    func saveSummary(_ summary: MailSummary, endpoint: String, identity: String) {
        write(summary, to: "summary-v1-\(scope(endpoint: endpoint, identity: identity)).json")
    }

    func drafts(endpoint: String, identity: String) -> [Draft]? {
        read("drafts-v1-\(scope(endpoint: endpoint, identity: identity)).json")
    }
    func saveDrafts(_ drafts: [Draft], endpoint: String, identity: String) {
        write(drafts, to: "drafts-v1-\(scope(endpoint: endpoint, identity: identity)).json")
    }

    func contacts(endpoint: String, identity: String) -> [MailContact]? {
        read("contacts-v1-\(scope(endpoint: endpoint, identity: identity)).json")
    }
    func saveContacts(_ contacts: [MailContact], endpoint: String, identity: String) {
        write(contacts, to: "contacts-v1-\(scope(endpoint: endpoint, identity: identity)).json")
    }

    func attachment(id: String, endpoint: String, identity: String) -> Data? {
        readData("attachment-v1-\(scope(endpoint: endpoint, identity: identity))-\(stableHash(id)).data")
    }
    func saveAttachment(_ data: Data, id: String, endpoint: String, identity: String) {
        guard data.count <= 25_000_000 else { return }
        writeData(data, to: "attachment-v1-\(scope(endpoint: endpoint, identity: identity))-\(stableHash(id)).data")
    }

    func rawMessage(id: String, endpoint: String, identity: String) -> Data? {
        readData("raw-message-v1-\(scope(endpoint: endpoint, identity: identity))-\(stableHash(id)).data")
    }
    func saveRawMessage(_ data: Data, id: String, endpoint: String, identity: String) {
        guard data.count <= 25_000_000 else { return }
        writeData(data, to: "raw-message-v1-\(scope(endpoint: endpoint, identity: identity))-\(stableHash(id)).data")
    }

    func senderLogo(for cacheKey: String) -> CachedSenderLogo? {
        let filename = senderLogoFilename(for: cacheKey)
        return Self.readSenderLogo(at: directory.appending(path: filename))
    }

    func saveSenderLogo(_ asset: SenderLogoAsset?, for cacheKey: String) {
        write(CachedSenderLogo(asset: asset), to: senderLogoFilename(for: cacheKey))
    }

    func senderLogos(for cacheKeys: Set<String>) async -> [String: CachedSenderLogo] {
        let files = cacheKeys.map { cacheKey in
            (cacheKey, directory.appending(path: senderLogoFilename(for: cacheKey)))
        }
        return await withTaskGroup(of: (String, CachedSenderLogo?).self, returning: [String: CachedSenderLogo].self) { group in
            for (cacheKey, url) in files {
                group.addTask(priority: .utility) {
                    (cacheKey, Self.readSenderLogo(at: url))
                }
            }
            var result: [String: CachedSenderLogo] = [:]
            result.reserveCapacity(files.count)
            for await (cacheKey, cached) in group {
                if let cached { result[cacheKey] = cached }
            }
            return result
        }
    }

    func clearMissingSenderLogos() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for file in files where file.lastPathComponent.hasPrefix("sender-logo-v1-") {
            guard let data = try? Data(contentsOf: file),
                  let envelope = try? decoder.decode(Envelope<CachedSenderLogo>.self, from: data),
                  envelope.value.asset == nil else { continue }
            try? FileManager.default.removeItem(at: file)
        }
    }

    func clear() throws {
        blobPruneTask?.cancel()
        blobPruneTask = nil
        blobPruneTaskID = nil
        lastBlobPruneAt = nil
        cacheGeneration &+= 1
        do {
            try removeDirectory(directory)
        } catch let error as CocoaError where error.code == .fileNoSuchFile {
            return
        } catch {
            throw MailCacheError.clearFailed
        }
    }

    private func scope(endpoint: String, identity: String) -> String {
        stableHash("\(endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased())\u{0}\(identity.lowercased())")
    }

    private func endpointScope(_ endpoint: String) -> String {
        stableHash(endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased())
    }

    private func senderLogoFilename(for cacheKey: String) -> String {
        "sender-logo-v1-\(stableHash(cacheKey)).json"
    }

    private func stableHash(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return String(hash, radix: 16)
    }

    private func read<Value: Codable>(_ filename: String) -> Value? {
        let envelope: Envelope<Value>? = readEnvelope(filename)
        return envelope?.value
    }

    private func snapshot<Value: Codable & Sendable>(_ filename: String) -> CacheSnapshot<Value>? {
        guard let envelope: Envelope<Value> = readEnvelope(filename) else { return nil }
        return CacheSnapshot(savedAt: envelope.savedAt, value: envelope.value)
    }

    private func readEnvelope<Value: Codable>(_ filename: String) -> Envelope<Value>? {
        guard let data = try? Data(contentsOf: directory.appending(path: filename)) else { return nil }
        return try? decoder.decode(Envelope<Value>.self, from: data)
    }

    private func readData(_ filename: String) -> Data? {
        try? Data(contentsOf: directory.appending(path: filename), options: .mappedIfSafe)
    }

    private nonisolated static func readSenderLogo(at url: URL) -> CachedSenderLogo? {
        guard let data = try? Data(contentsOf: url),
              let envelope = try? JSONDecoder().decode(Envelope<CachedSenderLogo>.self, from: data) else { return nil }
        let lifetime: TimeInterval = envelope.value.asset == nil ? 24 * 60 * 60 : 180 * 24 * 60 * 60
        guard Date().timeIntervalSince(envelope.savedAt) < lifetime else { return nil }
        return envelope.value
    }

    private func write<Value: Codable>(_ value: Value, to filename: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var resource = URLResourceValues()
            resource.isExcludedFromBackup = true
            var mutableDirectory = directory
            try? mutableDirectory.setResourceValues(resource)
            let data = try encoder.encode(Envelope(savedAt: Date(), value: value))
            let url = directory.appending(path: filename)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            // Cache failures never block live mail operations.
        }
    }

    private func writeData(_ data: Data, to filename: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appending(path: filename), options: [.atomic, .completeFileProtection])
            scheduleBlobPruneIfNeeded()
        } catch {
            // Cache failures never block live mail operations.
        }
    }

    private func scheduleBlobPruneIfNeeded() {
        guard blobPruneTask == nil,
              lastBlobPruneAt.map({ Date().timeIntervalSince($0) >= 300 }) ?? true else { return }
        let taskID = UUID()
        let generation = cacheGeneration
        lastBlobPruneAt = .now
        blobPruneTaskID = taskID
        blobPruneTask = Task(priority: .background) { [weak self] in
            try? await Task.sleep(for: .milliseconds(100), tolerance: .milliseconds(50))
            guard !Task.isCancelled else { return }
            await self?.runScheduledBlobPrune(taskID: taskID, generation: generation)
        }
    }

    private func runScheduledBlobPrune(taskID: UUID, generation: UInt64) {
        guard Self.maintenanceContextIsCurrent(
            taskID: taskID,
            currentTaskID: blobPruneTaskID,
            generation: generation,
            currentGeneration: cacheGeneration
        ), !Task.isCancelled else { return }
        defer {
            if blobPruneTaskID == taskID {
                blobPruneTask = nil
                blobPruneTaskID = nil
            }
        }
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else { return }
        let entries = files.compactMap { url -> BlobCacheEntry? in
            guard url.lastPathComponent.hasPrefix("attachment-v1-")
                    || url.lastPathComponent.hasPrefix("raw-message-v1-") else { return nil }
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { return nil }
            return BlobCacheEntry(
                url: url,
                size: Int64(max(values.fileSize ?? 0, 0)),
                modifiedAt: values.contentModificationDate ?? .distantPast
            )
        }
        for url in Self.blobFilesToRemove(entries) {
            guard Self.maintenanceContextIsCurrent(
                taskID: taskID,
                currentTaskID: blobPruneTaskID,
                generation: generation,
                currentGeneration: cacheGeneration
            ), !Task.isCancelled else { return }
            try? FileManager.default.removeItem(at: url)
        }
    }

    nonisolated static func maintenanceContextIsCurrent(
        taskID: UUID,
        currentTaskID: UUID?,
        generation: UInt64,
        currentGeneration: UInt64
    ) -> Bool {
        taskID == currentTaskID && generation == currentGeneration
    }

    nonisolated static func blobFilesToRemove(
        _ entries: [BlobCacheEntry],
        maximumBytes: Int64 = 256 * 1_024 * 1_024,
        targetBytes: Int64 = 192 * 1_024 * 1_024
    ) -> [URL] {
        let maximum = max(maximumBytes, 0)
        let target = min(max(targetBytes, 0), maximum)
        var remaining = entries.reduce(Int64(0)) { $0 + max($1.size, 0) }
        guard remaining > maximum else { return [] }

        var removals: [URL] = []
        for entry in entries.sorted(by: {
            if $0.modifiedAt == $1.modifiedAt { return $0.url.lastPathComponent < $1.url.lastPathComponent }
            return $0.modifiedAt < $1.modifiedAt
        }) where remaining > target {
            removals.append(entry.url)
            remaining -= max(entry.size, 0)
        }
        return removals
    }
}

enum MailCacheError: LocalizedError, Equatable, Sendable {
    case clearFailed

    var errorDescription: String? {
        "lmail could not delete its local cache. Check the device's storage permissions and try again."
    }
}
