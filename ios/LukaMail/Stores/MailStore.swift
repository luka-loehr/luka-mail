import Foundation
import Network
import Observation
import UniformTypeIdentifiers

enum MailConnectionStatus: Equatable, Sendable {
    case online
    case reconnecting
    case offline
    case serverUnavailable

    var message: String? {
        switch self {
        case .online: nil
        case .reconnecting: "Reconnecting… Saved mail remains available."
        case .offline: "Offline · Showing saved mail"
        case .serverUnavailable: "lmail is unavailable · Showing saved mail"
        }
    }

    var systemImage: String {
        switch self {
        case .online: "checkmark.circle"
        case .reconnecting: "arrow.clockwise"
        case .offline: "wifi.slash"
        case .serverUnavailable: "exclamationmark.triangle"
        }
    }
}

enum MailStartupPresentation: Equatable, Sendable {
    case restoringSession
    case signedOut
    case mailbox
}

@MainActor
@Observable
final class MailStore {
    private(set) var configured = false
    private(set) var bootstrapFinished = false
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var messages: [MailMessage] = []
    private(set) var drafts: [Draft] = []
    private(set) var detail: MailDetail?
    private(set) var summary: MailSummary?
    private(set) var identities: [MailIdentity] = []
    private(set) var contacts: [MailContact] = []
    private(set) var errorMessage: String?
    private(set) var errorTitle = "Couldn’t Update Mail"
    private(set) var connectionLabel = "Not signed in"
    private(set) var connectionStatus: MailConnectionStatus = .online
    private(set) var lastSuccessfulSync: Date?
    private(set) var logoCacheVersion = 0
    private(set) var pendingNotificationTarget: MailNotificationTarget?

    private(set) var endpoint: String
    private(set) var isDemoMode = false
    var identity = UserDefaults.standard.string(forKey: "identity") ?? ""
    private(set) var selectedInbox = MailStore.launchInbox

    var serverHost: String {
        if isDemoMode { return "Demo Mailbox (On-Device)" }
        let host = ServerEndpoint.displayHost(for: endpoint)
        return host.isEmpty ? "Not configured" : host
    }

    private static var launchInbox: String {
        UserDefaults.standard.removeObject(forKey: "selectedInbox") // left over from builds that remembered it
        return DemoLaunch.string("DemoInbox") ?? ""
    }
    var loadRemoteImages = UserDefaults.standard.bool(forKey: "loadRemoteImages")
    var mailbox: Mailbox = .inbox
    var search = ""

    private var nextCursor: String?
    private var client: APIClient?
    private var sessionWho: WhoAmI?
    private var contactsIdentity: String?
    @ObservationIgnored private var contactRequestGeneration: UUID?
    @ObservationIgnored private var cache: MailCache
    // Rows own their decoded image state. Keeping these transport/cache maps out
    // of Observation prevents one newly loaded sender logo from invalidating the
    // entire visible mailbox list.
    @ObservationIgnored private var senderLogos: [String: SenderLogoAsset] = [:]
    @ObservationIgnored private var missingSenderLogos: Set<String> = []
    @ObservationIgnored private var senderLogoRequests: [String: Task<SenderLogoAsset?, Never>] = [:]
    private var mailboxRevision: String?
    private var mailboxRevisionIdentity: String?
    private var lastIdentityRefreshAt: Date?
    private var networkAvailable = true
    private var allowsBackgroundNetworkWork = true
    private struct RefreshKey: Hashable {
        let mailbox: Mailbox
        let query: String
        let identity: String
        let includeAddresses: Bool
    }
    private var presentedMailboxContext: RefreshKey?
    @ObservationIgnored private var sessionGeneration = UUID()
    @ObservationIgnored private var refreshGeneration: UUID?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTaskKey: RefreshKey?
    @ObservationIgnored private var detailRequestGeneration: UUID?
    @ObservationIgnored private var bootstrapTask: Task<Void, Never>?
    @ObservationIgnored private var bootstrapTaskID: UUID?
    @ObservationIgnored private var backfillTask: Task<Void, Never>?
    @ObservationIgnored private var backfillTaskID: UUID?
    @ObservationIgnored private var mailboxWatchTask: Task<Void, Never>?
    @ObservationIgnored private var mailboxWatchTaskID: UUID?
    @ObservationIgnored private var mailboxWatchSubscribers: Set<UUID> = []
    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private let pathMonitorQueue = DispatchQueue(label: "com.example.lmail.connectivity", qos: .utility)

    private var canPerformRequests: Bool { isDemoMode || networkAvailable }

    init() {
        #if DEBUG
        if MailDemo.isEnabled {
            isDemoMode = true
            endpoint = MailDemo.endpoint
            cache = MailCache(directory: MailDemo.cacheDirectory)
        } else {
            endpoint = ServerEndpoint.saved()?.absoluteString ?? ""
            cache = MailCache()
        }
        #else
        endpoint = ServerEndpoint.saved()?.absoluteString ?? ""
        cache = MailCache()
        #endif
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            let allowsBackgroundWork = available && !path.isExpensive && !path.isConstrained
            Task { @MainActor [weak self] in
                self?.networkPathDidChange(available: available, allowsBackgroundWork: allowsBackgroundWork)
            }
        }
        pathMonitor.start(queue: pathMonitorQueue)
    }

    deinit {
        pathMonitor.cancel()
    }

    var startupPresentation: MailStartupPresentation {
        Self.startupPresentation(configured: configured, bootstrapFinished: bootstrapFinished)
    }

    static func startupPresentation(configured: Bool, bootstrapFinished: Bool) -> MailStartupPresentation {
        if configured { return .mailbox }
        return bootstrapFinished ? .signedOut : .restoringSession
    }

    func bootstrap() async {
        if let bootstrapTask {
            await bootstrapTask.value
            return
        }
        if configured {
            bootstrapFinished = true
            return
        }
        let taskID = UUID()
        bootstrapTaskID = taskID
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performBootstrap(taskID: taskID)
        }
        bootstrapTask = task
        await task.value
        if bootstrapTaskID == taskID {
            bootstrapTask = nil
            bootstrapTaskID = nil
            bootstrapFinished = true
        }
    }

    private func performBootstrap(taskID: UUID) async {
        if isDemoMode {
            await performDemoBootstrap()
            return
        }
        UserDefaults.standard.removeObject(forKey: "endpoint")
        try? KeychainStore.deleteLegacyAPIKey()
        guard let savedEndpoint = ServerEndpoint.saved() else {
            endpoint = ""
            configured = false
            return
        }
        endpoint = savedEndpoint.absoluteString
        let accessToken: String
        do {
            guard let storedToken = try KeychainStore.loadAccessToken(), !storedToken.isEmpty else {
                configured = false
                return
            }
            accessToken = storedToken
        } catch {
            configured = false
            presentError("Couldn’t Restore Your Session", error.localizedDescription)
            return
        }
        guard let configuration = Self.configuration(endpoint: savedEndpoint, accessToken: accessToken) else {
            configured = false
            presentError("Couldn’t Restore Your Session", MailAPIError.invalidConfiguration.localizedDescription)
            return
        }
        guard !Task.isCancelled, bootstrapTaskID == taskID else { return }
        let candidate = APIClient(configuration: configuration)

        if let cachedSession = await cache.session(endpoint: endpoint),
           let selected = cachedSession.identities.contains(where: { $0.address == selectedInbox })
            ? selectedInbox
            : cachedSession.identities.first?.address,
           !Task.isCancelled, bootstrapTaskID == taskID {
            establishSession(
                client: candidate,
                who: cachedSession.who,
                identities: cachedSession.identities,
                selectedInbox: selected
            )
            await restoreCachedMailbox(.inbox, identity: selected, generation: sessionGeneration)
        }

        if configured, !networkAvailable {
            connectionStatus = .offline
            return
        }

        do {
            async let fetchedWho = candidate.whoAmI()
            async let fetchedIdentities = candidate.identities()
            let (who, available) = try await (fetchedWho, fetchedIdentities)
            guard !Task.isCancelled, bootstrapTaskID == taskID else { return }
            let fallbackIdentity = available.first?.address
            guard let selected = available.contains(where: { $0.address == selectedInbox }) ? selectedInbox : fallbackIdentity else {
                configured = false
                presentError("No Mailbox Available", "No enabled mail identity is available for this passkey session.")
                return
            }
            let snapshot = try await candidate.mailboxSnapshot(
                folder: .inbox,
                identity: selected,
                includeAddresses: true
            )
            guard !Task.isCancelled, bootstrapTaskID == taskID else { return }
            establishSession(client: candidate, who: who, identities: available, selectedInbox: selected)
            await cache.saveSession(CachedMailSession(who: who, identities: available), endpoint: endpoint)
            let generation = sessionGeneration
            await applySnapshot(snapshot, key: RefreshKey(mailbox: .inbox, query: "", identity: selected,
                                                          includeAddresses: true), generation: generation)
            guard !Task.isCancelled, bootstrapTaskID == taskID, sessionGeneration == generation else { return }
            startSenderLogoBackfill()
        } catch {
            guard !Task.isCancelled, bootstrapTaskID == taskID else { return }
            if isUnauthorized(error) {
                try? KeychainStore.deleteAccessToken()
                try? await clearSessionState(clearCache: true)
                presentError("Session Expired", error.localizedDescription)
            } else if configured {
                recordBackgroundFailure(error)
                startSenderLogoBackfill()
            } else if !Self.isCancellation(error) {
                configured = false
                presentError("Can’t Connect to lmail", Self.friendlyErrorMessage(error))
            }
        }
    }

    /// Enters interactive on-device demo mode using synthetic sample mail without a server.
    func enterDemoMode() async {
        cancelBootstrap()
        errorMessage = nil
        isDemoMode = true
        endpoint = MailDemo.endpoint
        cache = MailCache(directory: MailDemo.cacheDirectory)
        DemoMailServer.shared.reset()
        await performDemoBootstrap()
    }

    /// Signs in against the in-process demo server without touching Keychain or real mail.
    private func performDemoBootstrap() async {
        guard let url = URL(string: MailDemo.endpoint), !DemoLaunch.flag("DemoSignedOut") else { return }
        let client = APIClient(configuration: APIConfiguration(endpoint: url, accessToken: "demo"),
                               session: MailDemo.makeSession())
        do {
            let who = try await client.whoAmI()
            let available = try await client.identities()
            guard let first = available.first?.address else { return }
            let selected = available.contains(where: { $0.address == selectedInbox }) ? selectedInbox : first
            let snapshot = try await client.mailboxSnapshot(folder: .inbox, identity: selected, includeAddresses: true)
            establishSession(client: client, who: who, identities: available, selectedInbox: selected)
            await applySnapshot(snapshot, key: RefreshKey(mailbox: .inbox, query: "", identity: selected, includeAddresses: true),
                                generation: sessionGeneration)
        } catch {
            presentError("Couldn’t Open Demo Mailbox", error.localizedDescription)
        }
    }

    private func presentError(_ title: String, _ message: String) {
        errorTitle = title
        errorMessage = message
    }

    func signIn(serverAddress: String, platform: NativeAuthPlatform) async throws {
        guard let endpointURL = ServerEndpoint.normalize(serverAddress) else {
            throw NativeAuthError.invalidServerAddress
        }
        cancelBootstrap()
        UserDefaults.standard.removeObject(forKey: "endpoint")
        errorMessage = nil
        let previousEndpoint = URL(string: endpoint)
        let previousAccessToken = try KeychainStore.loadAccessToken()
        let authSession = NativeAuthSession()
        let token = try await authSession.signIn(endpoint: endpointURL, platform: platform)
        let supersededAccessToken = Self.supersededAccessToken(
            previous: previousAccessToken,
            replacement: token.accessToken
        )
        do {
            guard let configuration = Self.configuration(endpoint: endpointURL, accessToken: token.accessToken) else {
                throw MailAPIError.invalidConfiguration
            }
            let candidate = APIClient(configuration: configuration)
            async let fetchedWho = candidate.whoAmI()
            async let fetchedIdentities = candidate.identities()
            let (who, available) = try await (fetchedWho, fetchedIdentities)
            guard let selected = available.contains(where: { $0.address == selectedInbox })
                ? selectedInbox
                : available.first?.address else {
                throw MailAPIError.invalidResponse("/v1/addresses")
            }
            isDemoMode = false
            endpoint = endpointURL.absoluteString
            cache = MailCache()
            ServerEndpoint.save(endpointURL)
            let cachedSession = await cache.session(endpoint: endpoint)
            if Self.requiresPrincipalCacheReset(
                previous: previousAccessToken,
                replacement: token.accessToken,
                cachedPrincipalKey: cachedSession?.who.principal.keyId,
                newPrincipalKey: who.principal.keyId
            ) {
                try await clearSessionState(clearCache: true)
            }
            try KeychainStore.saveAccessToken(token.accessToken)
            try? KeychainStore.deleteLegacyAPIKey()
            establishSession(client: candidate, who: who, identities: available, selectedInbox: selected)
            await cache.saveSession(CachedMailSession(who: who, identities: available), endpoint: endpoint)
            await refresh(mailbox: .inbox)
            startSenderLogoBackfill()
        } catch {
            try? await NativeAuthSession.revoke(endpoint: endpointURL, accessToken: token.accessToken)
            throw error
        }
        if let superseded = supersededAccessToken {
            let revokeEndpoint = previousEndpoint ?? endpointURL
            do {
                try await NativeAuthSession.revoke(endpoint: revokeEndpoint, accessToken: superseded)
            } catch {
                presentError("Previous Session Still Active", "Signed in, but lmail couldn’t revoke the previous session. It expires automatically within 30 days.")
            }
        }
    }

    func logout() async throws {
        if isDemoMode {
            isDemoMode = false
            endpoint = ServerEndpoint.saved()?.absoluteString ?? ""
            cache = MailCache()
            try await clearSessionState(clearCache: false)
            return
        }
        let currentEndpoint = URL(string: endpoint)
        let currentClient = client
        var revocationError: Error?
        var keychainError: Error?
        var cacheError: Error?
        let accessToken: String?
        do { accessToken = try KeychainStore.loadAccessToken() }
        catch {
            accessToken = nil
            keychainError = error
        }
        #if os(iOS)
        if let pushToken = PushNotificationCoordinator.shared.deviceToken, let currentClient {
            try? await currentClient.unregisterPushDevice(token: pushToken, environment: PushNotificationCoordinator.environment)
        }
        PushNotificationCoordinator.shared.clearRegistration()
        #endif
        do { try KeychainStore.deleteAccessToken() }
        catch { if keychainError == nil { keychainError = error } }
        do { try await clearSessionState(clearCache: true) }
        catch { cacheError = error }
        if let currentEndpoint, let accessToken, !accessToken.isEmpty {
            do { try await NativeAuthSession.revoke(endpoint: currentEndpoint, accessToken: accessToken) }
            catch { revocationError = error }
        }
        let warnings = [
            keychainError.map { _ in "the saved Keychain credential could not be removed" },
            cacheError.map { _ in "cached mail could not be fully deleted" },
            revocationError.map { _ in "the server could not confirm revocation; that session expires automatically within 30 days" },
        ].compactMap { $0 }
        if !warnings.isEmpty {
            presentError("Sign-Out Incomplete", "lmail closed the local session, but \(warnings.joined(separator: "; ")).")
            throw keychainError ?? cacheError ?? revocationError!
        }
    }

    func clearLocalCache() async throws {
        stopSenderLogoBackfill()
        senderLogoRequests.values.forEach { $0.cancel() }
        senderLogoRequests = [:]
        do {
            try await cache.clear()
        } catch {
            if configured { startSenderLogoBackfill() }
            throw error
        }
        senderLogos = [:]
        missingSenderLogos = []
        logoCacheVersion += 1
        #if os(iOS)
        SenderLogoImageCache.shared.clear()
        #elseif os(macOS)
        MacSenderLogoImageCache.shared.clear()
        #endif
        let tempPreviewDir = FileManager.default.temporaryDirectory.appending(path: "LukaMail", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: tempPreviewDir)
        if !isDemoMode {
            try? FileManager.default.removeItem(at: MailDemo.cacheDirectory)
        }
        UserDefaults.standard.removeObject(forKey: "senderLogoBackfillCursor")
        UserDefaults.standard.removeObject(forKey: "senderLogoBackfillCursorVersion")
        UserDefaults.standard.removeObject(forKey: "senderLogoBackfillVersion")
    }

    private func clearSessionState(clearCache: Bool) async throws {
        cancelBootstrap()
        stopSenderLogoBackfill()
        stopMailboxWatch()
        refreshTask?.cancel()
        sessionGeneration = UUID()
        refreshGeneration = nil
        refreshTask = nil
        refreshTaskKey = nil
        detailRequestGeneration = nil
        client = nil
        sessionWho = nil
        configured = false
        bootstrapFinished = true
        messages = []
        drafts = []
        detail = nil
        summary = nil
        identities = []
        contacts = []
        contactsIdentity = nil
        contactRequestGeneration = nil
        senderLogos = [:]
        missingSenderLogos = []
        senderLogoRequests.values.forEach { $0.cancel() }
        senderLogoRequests = [:]
        mailboxRevision = nil
        mailboxRevisionIdentity = nil
        lastIdentityRefreshAt = nil
        presentedMailboxContext = nil
        connectionLabel = "Not signed in"
        connectionStatus = .online
        lastSuccessfulSync = nil
        selectedInbox = ""
        identity = ""
        UserDefaults.standard.removeObject(forKey: "selectedInbox")
        UserDefaults.standard.removeObject(forKey: "identity")
        if clearCache { try await clearLocalCache() }
    }

    func setRemoteImages(_ enabled: Bool) {
        loadRemoteImages = enabled
        UserDefaults.standard.set(enabled, forKey: "loadRemoteImages")
    }

    func setIdentity(_ address: String) {
        identity = address
        UserDefaults.standard.set(address, forKey: "identity")
    }

    func selectInbox(_ address: String) async {
        guard identities.contains(where: { $0.address == address }), address != selectedInbox else { return }
        refreshTask?.cancel()
        refreshTask = nil
        refreshTaskKey = nil
        selectedInbox = address
        messages = []
        drafts = []
        contacts = []
        contactsIdentity = nil
        contactRequestGeneration = nil
        detail = nil
        nextCursor = nil
        mailboxRevision = nil
        mailboxRevisionIdentity = nil
        presentedMailboxContext = nil
        detailRequestGeneration = nil
        stopMailboxWatch()
        if search.isEmpty {
            await restoreCachedMailbox(mailbox, identity: address, generation: sessionGeneration)
        }
        restartMailboxWatchIfNeeded()
        await refresh(mailbox: mailbox, query: search)
    }

    func registerPushDevice(token: String, environment: String) async {
        guard let client, configured, !identities.isEmpty else { return }
        do {
            try await client.registerPushDevice(token: token, environment: environment,
                                                identities: identities.map(\.address))
        } catch where Self.isCancellation(error) {
            return
        } catch {
            // Mail remains fully usable if notification registration is
            // temporarily unavailable; the next active session retries it.
        }
    }

    func openNotification(_ target: MailNotificationTarget) async -> Bool {
        guard configured, identities.contains(where: { $0.address == target.identity }) else { return false }
        if selectedInbox != target.identity { await selectInbox(target.identity) }
        mailbox = .inbox
        search = ""
        // Resolve the message before asking the view to navigate. A notification
        // can arrive while the mailbox refresh is changing identity; navigating
        // first allowed that request to be superseded and left the detail view
        // showing its loading state forever.
        if !(await loadDetail(id: target.messageID)) {
            // A list snapshot is authoritative enough to open the notification
            // immediately. Keep that row visible while a later detail request can
            // refresh the full MIME body, rather than blocking the tap on a
            // transient request cancellation during identity/mailbox hand-off.
            guard let message = messages.first(where: { $0.id == target.messageID }) else {
                presentError("Message Unavailable", "This message is no longer available in this mailbox.")
                return false
            }
            detail = Self.previewDetail(from: message)
        }
        pendingNotificationTarget = target
        return true
    }

    func consumeNotification(_ target: MailNotificationTarget) {
        if pendingNotificationTarget == target { pendingNotificationTarget = nil }
    }

    func watchMailboxChanges() async {
        guard configured, client != nil else { return }
        let subscriber = UUID()
        mailboxWatchSubscribers.insert(subscriber)
        restartMailboxWatchIfNeeded()
        defer {
            mailboxWatchSubscribers.remove(subscriber)
            if mailboxWatchSubscribers.isEmpty { stopMailboxWatch() }
        }

        while !Task.isCancelled, configured {
            if mailboxWatchTask == nil { restartMailboxWatchIfNeeded() }
            do { try await Task.sleep(for: .seconds(60)) }
            catch { return }
        }
    }

    private func runMailboxWatch(taskID: UUID, generation: UUID) async {
        defer { finishMailboxWatch(taskID: taskID) }
        var retryAttempt = 0
        while !Task.isCancelled, configured, sessionGeneration == generation, let client {
            guard canPerformRequests else { return }
            await refreshIdentityListIfNeeded(client: client, generation: generation)
            guard !Task.isCancelled, configured, sessionGeneration == generation else { return }
            let watchedIdentity = selectedInbox
            if mailboxRevisionIdentity != watchedIdentity {
                mailboxRevision = nil
                mailboxRevisionIdentity = watchedIdentity
            }
            do {
                let state = try await client.mailboxState(identity: watchedIdentity, after: mailboxRevision, waitSeconds: 25)
                guard !Task.isCancelled, sessionGeneration == generation, selectedInbox == watchedIdentity else { continue }
                let hadRevision = mailboxRevision != nil
                let changed = state.changed || (hadRevision && state.revision != mailboxRevision)
                if changed {
                    try await synchronizeMailboxDelta(identity: watchedIdentity, generation: generation, client: client)
                } else if !hadRevision {
                    mailboxRevision = state.revision
                    mailboxRevisionIdentity = watchedIdentity
                }
                retryAttempt = 0
                recordSuccessfulSync()
            } catch where Self.isCancellation(error) {
                return
            } catch {
                guard !Task.isCancelled, sessionGeneration == generation else { return }
                if isUnauthorized(error) {
                    await expireSession(with: error)
                    return
                }
                recordBackgroundFailure(error)
                let delay = Self.mailboxRetryDelaySeconds(attempt: retryAttempt, jitter: Double.random(in: 0...1))
                retryAttempt += 1
                do { try await Task.sleep(for: .seconds(delay)) }
                catch { return }
            }
        }
    }

    private func refreshIdentityListIfNeeded(client: APIClient, generation: UUID) async {
        if let lastIdentityRefreshAt,
           Date().timeIntervalSince(lastIdentityRefreshAt) < 20 { return }
        lastIdentityRefreshAt = Date()
        do {
            let available = try await client.identities()
            guard !Task.isCancelled, configured, sessionGeneration == generation else { return }
            guard !available.isEmpty else { return }
            if identities != available {
                identities = available
                if let who = sessionWho {
                    await cache.saveSession(CachedMailSession(who: who, identities: available), endpoint: endpoint)
                }
            }
            if let fallback = Self.selectedInboxAfterIdentityRefresh(current: selectedInbox, available: available),
               fallback != selectedInbox {
                await selectInbox(fallback)
            }
        } catch where Self.isCancellation(error) {
            return
        } catch {
            guard sessionGeneration == generation else { return }
            if isUnauthorized(error) { await expireSession(with: error) }
            else { recordBackgroundFailure(error) }
        }
    }

    static func selectedInboxAfterIdentityRefresh(current: String, available: [MailIdentity]) -> String? {
        available.contains(where: { $0.address == current }) ? current : available.first?.address
    }

    private func synchronizeMailboxDelta(identity watchedIdentity: String, generation: UUID, client: APIClient) async throws {
        guard let baseRevision = mailboxRevision, mailboxRevisionIdentity == watchedIdentity else {
            await refresh(mailbox: mailbox, query: search)
            return
        }
        // SQLite LIKE and Swift's Unicode matching are not byte-for-byte equivalent.
        // Search views therefore use the correctness-first snapshot fallback.
        guard search.isEmpty else {
            await refresh(mailbox: mailbox, query: search)
            return
        }
        if let refreshTask { await refreshTask.value }
        guard !Task.isCancelled, sessionGeneration == generation, selectedInbox == watchedIdentity,
              mailboxRevision == baseRevision else { return }

        guard var expectedRevision = UInt64(baseRevision).map({ $0 + 1 }) else {
            await refresh(mailbox: mailbox, query: search)
            return
        }
        var cursor: String?
        repeat {
            do {
                let delta = try await client.mailboxDelta(identity: watchedIdentity, since: baseRevision, cursor: cursor)
                guard !Task.isCancelled, sessionGeneration == generation, selectedInbox == watchedIdentity,
                      mailboxRevision == baseRevision, delta.identity == nil || delta.identity == watchedIdentity,
                      delta.fromRevision == baseRevision else { return }
                if delta.resetRequired {
                    await refresh(mailbox: mailbox, query: search)
                    return
                }
                for change in delta.changes {
                    guard UInt64(change.revision) == expectedRevision else {
                        await refresh(mailbox: mailbox, query: search)
                        return
                    }
                    expectedRevision += 1
                    applyMailboxChange(change)
                }
                if let freshSummary = delta.summary { summary = freshSummary }
                if delta.hasMore {
                    guard let next = delta.nextCursor, next != cursor else {
                        await refresh(mailbox: mailbox, query: search)
                        return
                    }
                    cursor = next
                } else {
                    guard UInt64(delta.revision).map({ $0 + 1 }) == expectedRevision else {
                        await refresh(mailbox: mailbox, query: search)
                        return
                    }
                    mailboxRevision = delta.revision
                    mailboxRevisionIdentity = watchedIdentity
                    cursor = nil
                    await persistDeltaState(identity: watchedIdentity)
                    await warmSenderLogoCache(for: messages)
                    recordSuccessfulSync()
                    return
                }
            } catch where Self.isCancellation(error) {
                return
            } catch {
                throw error
            }
        } while cursor != nil
    }

    private func applyMailboxChange(_ change: MailboxChange) {
        if change.kind == "draft" {
            drafts.removeAll { $0.id == change.id }
            if change.operation == "upsert", let draft = change.draft {
                drafts.append(draft)
                drafts.sort { ($0.updatedAt ?? "", $0.id ?? "") > ($1.updatedAt ?? "", $1.id ?? "") }
            }
            return
        }
        guard change.kind == "message" else { return }
        let message = change.message
        messages = Self.applying(change, to: messages, mailbox: mailbox, nextCursor: nextCursor)
        guard change.operation == "upsert", let message,
              Self.message(message, belongsTo: mailbox) else {
            if detail?.id == change.id { detail = nil }
            return
        }
        if detail?.id == change.id {
            detail?.folder = message.folder
            detail?.unread = message.unread
            detail?.starred = message.starred
        }
    }

    private func persistDeltaState(identity: String) async {
        if let summary { await cache.saveSummary(summary, endpoint: endpoint, identity: identity) }
        await cache.saveDrafts(drafts, endpoint: endpoint, identity: identity)
        if mailbox != .drafts {
            await cache.save(MessagePage(messages: messages, nextCursor: nextCursor), for: mailbox,
                             endpoint: endpoint, identity: identity)
        }
    }

    static func message(_ message: MailMessage, belongsTo mailbox: Mailbox) -> Bool {
        switch mailbox {
        case .inbox: message.folder == "inbox" && message.spam != true
        case .starred: message.starred && message.folder != "trash" && message.spam != true
        case .sent: message.folder == "sent" && message.spam != true
        case .archive: message.folder == "archive" && message.spam != true
        case .trash: message.folder == "trash"
        case .drafts: false
        }
    }

    private static func previewDetail(from message: MailMessage) -> MailDetail {
        MailDetail(
            id: message.id,
            threadId: message.threadId,
            direction: message.direction,
            folder: message.folder,
            subject: message.subject,
            sender: message.sender,
            recipients: message.recipients,
            preview: message.preview,
            receivedAt: message.receivedAt,
            unread: message.unread,
            starred: message.starred,
            hasAttachments: message.hasAttachments,
            attachmentCount: message.attachmentCount,
            storedAttachmentCount: message.storedAttachmentCount,
            attachmentsTruncated: message.attachmentsTruncated,
            size: message.size,
            messageId: nil,
            inReplyTo: nil,
            cc: [],
            text: message.preview,
            html: nil,
            attachments: [],
            thread: [message],
            threadTruncated: false
        )
    }

    static func messageSortsBefore(_ lhs: MailMessage, _ rhs: MailMessage) -> Bool {
        lhs.receivedAt == rhs.receivedAt ? lhs.id > rhs.id : lhs.receivedAt > rhs.receivedAt
    }

    static func applying(_ change: MailboxChange, to current: [MailMessage], mailbox: Mailbox,
                         nextCursor: String?) -> [MailMessage] {
        var result = current
        let existingIndex = result.firstIndex { $0.id == change.id }
        guard change.kind == "message", change.operation == "upsert", let message = change.message,
              Self.message(message, belongsTo: mailbox) else {
            if let existingIndex { result.remove(at: existingIndex) }
            return result
        }
        if let existingIndex {
            result[existingIndex] = message
        } else if nextCursor == nil || Self.message(message, isWithinLoadedWindowEndingAt: nextCursor) {
            result.append(message)
        }
        result.sort(by: Self.messageSortsBefore)
        return result
    }

    static func message(_ message: MailMessage, isWithinLoadedWindowEndingAt cursor: String?) -> Bool {
        guard let cursor, let data = Self.base64URLData(cursor),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let time = value["time"], let id = value["id"] else { return false }
        return message.receivedAt > time || (message.receivedAt == time && message.id >= id)
    }

    private static func base64URLData(_ value: String) -> Data? {
        var normalized = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        normalized.append(String(repeating: "=", count: (4 - normalized.count % 4) % 4))
        return Data(base64Encoded: normalized)
    }

    func refresh(mailbox target: Mailbox? = nil, query: String? = nil, includeAddresses: Bool = false) async {
        guard let client else { return }
        let selected = target ?? mailbox
        let term = query ?? search
        let key = RefreshKey(mailbox: selected, query: term, identity: selectedInbox,
                             includeAddresses: includeAddresses)
        if refreshTaskKey == key, let refreshTask {
            await refreshTask.value
            return
        }

        refreshTask?.cancel()
        let requestID = UUID()
        refreshGeneration = requestID
        refreshTaskKey = key
        let generation = sessionGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performRefresh(key: key, requestID: requestID, generation: generation, client: client)
        }
        refreshTask = task
        await task.value
        if refreshGeneration == requestID {
            refreshGeneration = nil
            refreshTask = nil
            refreshTaskKey = nil
        }
    }

    private func performRefresh(key: RefreshKey, requestID: UUID, generation: UUID, client: APIClient) async {
        let selected = key.mailbox
        let term = key.query
        let inbox = key.identity
        let changedContext = presentedMailboxContext?.mailbox != key.mailbox
            || presentedMailboxContext?.query != key.query
            || presentedMailboxContext?.identity != key.identity
        mailbox = selected
        search = term
        if changedContext {
            messages = []
            drafts = []
            nextCursor = nil
            if term.isEmpty {
                await restoreCachedMailbox(selected, identity: inbox, generation: generation)
            }
            presentedMailboxContext = key
        }
        loading = selected == .drafts ? drafts.isEmpty : messages.isEmpty
        defer {
            if refreshGeneration == requestID { loading = false }
        }

        guard canPerformRequests else {
            connectionStatus = .offline
            return
        }

        do {
            let snapshot = try await client.mailboxSnapshot(
                folder: selected,
                identity: inbox,
                query: term,
                includeAddresses: key.includeAddresses
            )
            guard refreshGeneration == requestID else { return }
            await applySnapshot(snapshot, key: key, generation: generation)
        } catch {
            guard refreshGeneration == requestID, sessionGeneration == generation, !Task.isCancelled else { return }
            if isUnauthorized(error) { await expireSession(with: error) }
            else if !Self.isCancellation(error) { recordBackgroundFailure(error) }
        }
    }

    private func applySnapshot(_ snapshot: MailboxSnapshot, key: RefreshKey, generation: UUID) async {
        guard !Task.isCancelled, sessionGeneration == generation, selectedInbox == key.identity,
              mailbox == key.mailbox, search == key.query else { return }

        summary = snapshot.summary
        drafts = snapshot.drafts
        mailboxRevision = snapshot.revision
        mailboxRevisionIdentity = key.identity

        if key.mailbox == .drafts {
            messages = []
            nextCursor = nil
        } else {
            messages = snapshot.messages
            nextCursor = snapshot.nextCursor
        }
        presentedMailboxContext = key

        if let addresses = snapshot.addresses, !addresses.isEmpty {
            identities = addresses
            if let who = sessionWho {
                await cache.saveSession(CachedMailSession(who: who, identities: addresses), endpoint: endpoint)
            }
        }

        await cache.saveSummary(snapshot.summary, endpoint: endpoint, identity: key.identity)
        await cache.saveDrafts(snapshot.drafts, endpoint: endpoint, identity: key.identity)
        if key.mailbox != .drafts, key.query.isEmpty {
            await cache.save(
                MessagePage(messages: snapshot.messages, nextCursor: snapshot.nextCursor),
                for: key.mailbox,
                endpoint: endpoint,
                identity: key.identity
            )
        }
        await warmSenderLogoCache(for: snapshot.messages)
        guard !Task.isCancelled, sessionGeneration == generation, selectedInbox == key.identity else { return }
        recordSuccessfulSync()
    }

    func loadMoreIfNeeded(after message: MailMessage) async {
        guard message.id == messages.last?.id, let cursor = nextCursor, !loadingMore,
              mailbox != .drafts, let client, canPerformRequests else { return }
        let generation = sessionGeneration
        let target = mailbox
        let term = search
        let inbox = selectedInbox
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.messages(folder: target, identity: inbox, query: term, cursor: cursor)
            guard !Task.isCancelled, sessionGeneration == generation, selectedInbox == inbox,
                  mailbox == target, search == term, nextCursor == cursor, messages.last?.id == message.id else { return }
            let existing = Set(messages.map(\.id))
            let additions = page.messages.filter { !existing.contains($0.id) }
            messages.append(contentsOf: additions)
            nextCursor = page.nextCursor
            if term.isEmpty {
                await cache.save(MessagePage(messages: messages, nextCursor: nextCursor), for: target,
                                 endpoint: endpoint, identity: inbox)
            }
            await warmSenderLogoCache(for: additions)
            recordSuccessfulSync()
        } catch {
            guard !Task.isCancelled, sessionGeneration == generation, selectedInbox == inbox,
                  mailbox == target, search == term else { return }
            if !Self.isCancellation(error) { recordBackgroundFailure(error) }
        }
    }

    @discardableResult
    func loadDetail(id: String) async -> Bool {
        guard let client else { return false }
        let requestID = UUID()
        let generation = sessionGeneration
        let inbox = selectedInbox
        let cacheEndpoint = endpoint
        detailRequestGeneration = requestID
        detail = nil
        let cached = await cache.detail(id: id, endpoint: cacheEndpoint, identity: inbox)
        guard detailRequestGeneration == requestID, sessionGeneration == generation, selectedInbox == inbox else { return false }
        detail = cached
        do {
            let fetched = try await client.message(id: id, identity: inbox)
            guard detailRequestGeneration == requestID, sessionGeneration == generation,
                  selectedInbox == inbox, !Task.isCancelled else { return false }
            detail = fetched
            await cache.save(fetched, endpoint: cacheEndpoint, identity: inbox)
            if fetched.unread { await update(id: id, update: MessageUpdate(unread: false), removeFromCurrentList: false) }
            return true
        } catch {
            guard detailRequestGeneration == requestID, sessionGeneration == generation,
                  selectedInbox == inbox, !Task.isCancelled else { return false }
            if !Self.isCancellation(error) { recordBackgroundFailure(error) }
            return cached?.id == id
        }
    }

    @discardableResult
    func update(id: String, update: MessageUpdate, removeFromCurrentList: Bool = false) async -> Bool {
        guard let client else { return false }
        let generation = sessionGeneration
        let inbox = selectedInbox
        let cacheEndpoint = endpoint
        let targetMailbox = mailbox
        let targetSearch = search
        let targetDetailRequest = detailRequestGeneration
        let previous = messages
        let previousDetail = detail
        if let index = messages.firstIndex(where: { $0.id == id }) {
            if let unread = update.unread { messages[index].unread = unread }
            if let starred = update.starred { messages[index].starred = starred }
            if let folder = update.folder { messages[index].folder = folder }
            if removeFromCurrentList { messages.remove(at: index) }
        }
        if detail?.id == id {
            if let unread = update.unread { detail?.unread = unread }
            if let starred = update.starred { detail?.starred = starred }
            if let folder = update.folder { detail?.folder = folder }
        }
        do {
            try await client.updateMessage(id: id, update: update)
            guard sessionGeneration == generation, selectedInbox == inbox,
                  mailbox == targetMailbox, search == targetSearch,
                  detailRequestGeneration == targetDetailRequest else { return true }
            if targetSearch.isEmpty {
                await cache.save(MessagePage(messages: messages, nextCursor: nextCursor), for: targetMailbox,
                                 endpoint: cacheEndpoint, identity: inbox)
            }
            if let detail, detail.id == id { await cache.save(detail, endpoint: cacheEndpoint, identity: inbox) }
            return true
        } catch {
            guard sessionGeneration == generation, selectedInbox == inbox,
                  mailbox == targetMailbox, search == targetSearch,
                  detailRequestGeneration == targetDetailRequest, !Task.isCancelled else { return false }
            messages = previous
            detail = previousDetail
            if !Self.isCancellation(error) {
                recordBackgroundFailure(error)
                presentError("Couldn’t Save Change", Self.friendlyActionErrorMessage(error))
            }
            return false
        }
    }

    func send(_ draft: Draft, attachments: [OutboundAttachment]) async throws {
        guard let client else { throw MailAPIError.invalidConfiguration }
        let request = SendRequest(
            idempotencyKey: UUID(), from: draft.from, to: draft.to, cc: draft.cc, bcc: draft.bcc,
            subject: draft.subject, text: draft.text, html: nil, replyToMessageId: draft.replyToMessageId,
            attachments: attachments
        )
        _ = try await client.send(request)
        if let id = draft.id { try? await client.deleteDraft(id: id) }
        await loadContacts(identity: draft.from)
    }

    func loadContacts(identity requestedIdentity: String? = nil, query: String = "") async {
        guard let client else { return }
        let target = requestedIdentity ?? selectedInbox
        let generation = sessionGeneration
        let requestID = UUID()
        contactRequestGeneration = requestID
        contactsIdentity = target
        if query.isEmpty, let cached = await cache.contacts(endpoint: endpoint, identity: target),
           Self.requestContextIsCurrent(
                requestID: requestID,
                currentRequestID: contactRequestGeneration,
                generation: generation,
                currentGeneration: sessionGeneration,
                identity: target,
                currentIdentity: contactsIdentity
           ) {
            contacts = cached
        }
        do {
            let fetched = try await client.contacts(identity: target, query: query)
            guard Self.requestContextIsCurrent(
                requestID: requestID,
                currentRequestID: contactRequestGeneration,
                generation: generation,
                currentGeneration: sessionGeneration,
                identity: target,
                currentIdentity: contactsIdentity
            ) else { return }
            contacts = fetched
            if query.isEmpty { await cache.saveContacts(fetched, endpoint: endpoint, identity: target) }
        } catch {
            guard Self.requestContextIsCurrent(
                requestID: requestID,
                currentRequestID: contactRequestGeneration,
                generation: generation,
                currentGeneration: sessionGeneration,
                identity: target,
                currentIdentity: contactsIdentity
            ) else { return }
            if !Self.isCancellation(error) { recordBackgroundFailure(error) }
        }
    }

    @discardableResult
    func addContact(address: String, displayName: String = "", identity requestedIdentity: String? = nil) async throws -> MailContact {
        guard let client else { throw MailAPIError.invalidConfiguration }
        let target = requestedIdentity ?? selectedInbox
        let contact = try await client.createContact(identity: target, address: address, displayName: displayName)
        await loadContacts(identity: target)
        return contact
    }

    @discardableResult
    func renameContact(address: String, displayName: String, identity requestedIdentity: String? = nil) async throws -> MailContact {
        guard let client else { throw MailAPIError.invalidConfiguration }
        let target = requestedIdentity ?? selectedInbox
        let contact = try await client.updateContact(identity: target, address: address, displayName: displayName)
        await loadContacts(identity: target)
        return contact
    }

    func removeContact(address: String, identity requestedIdentity: String? = nil) async throws {
        guard let client else { throw MailAPIError.invalidConfiguration }
        let target = requestedIdentity ?? selectedInbox
        try await client.deleteContact(identity: target, address: address)
        contacts.removeAll { $0.identityAddress == target && $0.address.caseInsensitiveCompare(address) == .orderedSame }
    }

    func saveDraft(_ draft: Draft) async throws -> String {
        guard let client else { throw MailAPIError.invalidConfiguration }
        let generation = sessionGeneration
        let inbox = selectedInbox
        let id = try await client.saveDraft(draft)
        guard Self.sessionContextIsCurrent(
            generation: generation,
            currentGeneration: sessionGeneration,
            identity: inbox,
            currentIdentity: selectedInbox
        ) else { return id }
        var cachedDraft = draft
        cachedDraft.id = id
        if let existing = drafts.firstIndex(where: { $0.id == id }) {
            drafts[existing] = cachedDraft
        } else {
            drafts.insert(cachedDraft, at: 0)
        }
        let draftSnapshot = drafts
        await cache.saveDrafts(draftSnapshot, endpoint: endpoint, identity: inbox)
        return id
    }

    func deleteDraft(_ draft: Draft) async {
        guard let id = draft.id, let client else { return }
        let generation = sessionGeneration
        let inbox = selectedInbox
        do {
            try await client.deleteDraft(id: id)
            guard Self.sessionContextIsCurrent(
                generation: generation,
                currentGeneration: sessionGeneration,
                identity: inbox,
                currentIdentity: selectedInbox
            ) else { return }
            drafts.removeAll { $0.id == id }
            let draftSnapshot = drafts
            await cache.saveDrafts(draftSnapshot, endpoint: endpoint, identity: inbox)
        } catch {
            guard Self.sessionContextIsCurrent(
                generation: generation,
                currentGeneration: sessionGeneration,
                identity: inbox,
                currentIdentity: selectedInbox
            ), !Self.isCancellation(error) else { return }
            recordBackgroundFailure(error)
            presentError("Couldn’t Save Change", Self.friendlyActionErrorMessage(error))
        }
    }

    func attachmentData(id: String) async throws -> Data {
        guard let client else { throw MailAPIError.invalidConfiguration }
        if let cached = await cache.attachment(id: id, endpoint: endpoint, identity: selectedInbox) {
            return cached
        }
        let data = try await client.attachment(id: id)
        await cache.saveAttachment(data, id: id, endpoint: endpoint, identity: selectedInbox)
        return data
    }

    func rawMessageData(id: String) async throws -> Data {
        guard let client else { throw MailAPIError.invalidConfiguration }
        if let cached = await cache.rawMessage(id: id, endpoint: endpoint, identity: selectedInbox) {
            return cached
        }
        let data = try await client.rawMessage(id: id)
        await cache.saveRawMessage(data, id: id, endpoint: endpoint, identity: selectedInbox)
        return data
    }

    nonisolated static func sanitizedInlineImageSpec(contentId: String?, contentType: String) -> (cid: String, mime: String)? {
        guard let rawCid = contentId?.trimmingCharacters(in: CharacterSet(charactersIn: "<> \t\r\n")),
              !rawCid.isEmpty, rawCid.count <= 254,
              rawCid.range(of: #"^[A-Za-z0-9._@+-]+$"#, options: .regularExpression) != nil else {
            return nil
        }
        let rawMime = contentType.components(separatedBy: ";").first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        let safeRasterTypes: Set<String> = [
            "image/png", "image/jpeg", "image/jpg", "image/gif",
            "image/webp", "image/avif", "image/bmp", "image/heic", "image/heif",
        ]
        guard safeRasterTypes.contains(rawMime) else { return nil }
        return (rawCid, rawMime == "image/jpg" ? "image/jpeg" : rawMime)
    }

    func inlineImageData(for attachments: [MailAttachment]) async -> [String: String] {
        guard let client else { return [:] }
        let cacheEndpoint = endpoint
        let inbox = selectedInbox
        let maximumAggregateSize = 10_000_000
        var aggregateSize = 0
        let eligible = attachments.filter { attachment in
            guard Self.sanitizedInlineImageSpec(contentId: attachment.contentId, contentType: attachment.contentType) != nil,
                  attachment.size <= 5_000_000,
                  aggregateSize + attachment.size <= maximumAggregateSize else { return false }
            aggregateSize += attachment.size
            return true
        }

        var result: [String: String] = [:]
        for batchStart in stride(from: 0, to: eligible.count, by: 3) {
            let batch = eligible[batchStart..<min(batchStart + 3, eligible.count)]
            let entries = await withTaskGroup(of: (String, String)?.self, returning: [(String, String)].self) { group in
                for attachment in batch {
                    group.addTask { [cache] in
                        guard let spec = Self.sanitizedInlineImageSpec(
                            contentId: attachment.contentId,
                            contentType: attachment.contentType
                        ) else { return nil }
                        let data: Data
                        if let cached = await cache.attachment(id: attachment.id, endpoint: cacheEndpoint, identity: inbox) {
                            data = cached
                        } else {
                            guard let fetched = try? await client.attachment(id: attachment.id) else { return nil }
                            data = fetched
                            await cache.saveAttachment(fetched, id: attachment.id, endpoint: cacheEndpoint, identity: inbox)
                        }
                        return (spec.cid, "data:\(spec.mime);base64,\(data.base64EncodedString())")
                    }
                }
                var batchResult: [(String, String)] = []
                for await entry in group { if let entry { batchResult.append(entry) } }
                return batchResult
            }
            result.merge(Dictionary(uniqueKeysWithValues: entries)) { _, new in new }
        }
        return result
    }

    func senderLogoData(messageID: String, address: String) async -> SenderLogoAsset? {
        let cacheKey = senderLogoCacheKey(address: address)
        if let cached = senderLogos[cacheKey] { return cached }
        if missingSenderLogos.contains(cacheKey) { return nil }
        if let request = senderLogoRequests[cacheKey] { return await request.value }
        guard let client else { return nil }

        let request = Task { [cache] () -> SenderLogoAsset? in
            if let cached = await cache.senderLogo(for: cacheKey) { return cached.asset }
            let fetched = try? await client.senderLogo(messageID: messageID)
            await cache.saveSenderLogo(fetched, for: cacheKey)
            return fetched
        }
        senderLogoRequests[cacheKey] = request
        let data = await request.value
        senderLogoRequests[cacheKey] = nil
        guard let data else {
            missingSenderLogos.insert(cacheKey)
            return nil
        }
        senderLogos[cacheKey] = data
        return data
    }

    func cachedSenderLogo(address: String) -> SenderLogoAsset? {
        senderLogos[senderLogoCacheKey(address: address)]
    }

    private func warmSenderLogoCache(for messages: [MailMessage]) async {
        let keys = Set(messages.map { message in
            let correspondent = message.direction == "outbound" ? message.recipients.first ?? message.sender : message.sender
            return senderLogoCacheKey(address: correspondent.address)
        }).filter { senderLogos[$0] == nil && !missingSenderLogos.contains($0) }
        let cachedLogos = await cache.senderLogos(for: Set(keys))
        let assets = cachedLogos.compactMapValues(\.asset)
        let misses = Set(cachedLogos.compactMap { cacheKey, cached in cached.asset == nil ? cacheKey : nil })
        senderLogos.merge(assets) { _, cached in cached }
        missingSenderLogos.formUnion(misses)
    }

    private func senderLogoCacheKey(address: String) -> String {
        "\(endpoint.lowercased())|\(address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    private func cancelBootstrap() {
        bootstrapTask?.cancel()
        bootstrapTask = nil
        bootstrapTaskID = nil
    }

    private func startSenderLogoBackfill() {
        guard configured, client != nil, backfillTask == nil, networkAvailable,
              allowsBackgroundNetworkWork, !isDemoMode else { return }
        let taskID = UUID()
        let generation = sessionGeneration
        backfillTaskID = taskID
        backfillTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runSenderLogoBackfill(taskID: taskID, generation: generation)
        }
    }

    private func runSenderLogoBackfill(taskID: UUID, generation: UUID) async {
        defer {
            if backfillTaskID == taskID {
                backfillTask = nil
                backfillTaskID = nil
            }
        }
        await backfillPastSenderLogos(generation: generation)
    }

    private func stopSenderLogoBackfill() {
        backfillTask?.cancel()
        backfillTask = nil
        backfillTaskID = nil
    }

    private func restartMailboxWatchIfNeeded() {
        guard !mailboxWatchSubscribers.isEmpty, configured, client != nil, mailboxWatchTask == nil,
              canPerformRequests else { return }
        let taskID = UUID()
        let generation = sessionGeneration
        mailboxWatchTaskID = taskID
        mailboxWatchTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runMailboxWatch(taskID: taskID, generation: generation)
        }
    }

    private func finishMailboxWatch(taskID: UUID) {
        guard mailboxWatchTaskID == taskID else { return }
        mailboxWatchTask = nil
        mailboxWatchTaskID = nil
        restartMailboxWatchIfNeeded()
    }

    private func stopMailboxWatch() {
        mailboxWatchTask?.cancel()
        mailboxWatchTask = nil
        mailboxWatchTaskID = nil
    }

    private func restoreCachedMailbox(_ target: Mailbox, identity inbox: String, generation: UUID) async {
        if let cachedSummary = await cache.summary(endpoint: endpoint, identity: inbox),
           sessionGeneration == generation, selectedInbox == inbox {
            summary = cachedSummary
        }

        if target == .drafts {
            if let cachedDrafts = await cache.drafts(endpoint: endpoint, identity: inbox),
               sessionGeneration == generation, selectedInbox == inbox {
                drafts = cachedDrafts
                messages = []
                nextCursor = nil
            }
        } else if let cached = await cache.pageSnapshot(for: target, endpoint: endpoint, identity: inbox),
                  sessionGeneration == generation, selectedInbox == inbox {
            messages = cached.value.messages
            drafts = []
            nextCursor = cached.value.nextCursor
            lastSuccessfulSync = cached.savedAt
            await warmSenderLogoCache(for: cached.value.messages)
        }

        guard sessionGeneration == generation, selectedInbox == inbox else { return }
        presentedMailboxContext = RefreshKey(mailbox: target, query: "", identity: inbox,
                                             includeAddresses: false)
    }

    private func networkPathDidChange(available: Bool, allowsBackgroundWork: Bool) {
        let connectivityChanged = networkAvailable != available
        let backgroundPolicyChanged = allowsBackgroundNetworkWork != allowsBackgroundWork
        networkAvailable = available
        allowsBackgroundNetworkWork = allowsBackgroundWork

        guard connectivityChanged || backgroundPolicyChanged else { return }
        if isDemoMode { return }
        if !available {
            connectionStatus = .offline
            stopMailboxWatch()
            stopSenderLogoBackfill()
            refreshTask?.cancel()
            refreshTask = nil
            refreshTaskKey = nil
            refreshGeneration = nil
            loading = false
            return
        }

        if connectivityChanged {
            connectionStatus = .reconnecting
            restartMailboxWatchIfNeeded()
            if configured {
                let selectedMailbox = mailbox
                let selectedQuery = search
                Task { @MainActor [weak self] in
                    await self?.refresh(mailbox: selectedMailbox, query: selectedQuery)
                }
            }
        }
        if allowsBackgroundWork { startSenderLogoBackfill() }
        else { stopSenderLogoBackfill() }
    }

    private func recordSuccessfulSync() {
        lastSuccessfulSync = .now
        if connectionStatus != .online { connectionStatus = .online }
    }

    private func recordBackgroundFailure(_ error: Error) {
        guard !Self.isCancellation(error) else { return }
        if (error as? MailAPIError) == .networkUnavailable
            || Self.urlErrorCode(error).map(Self.offlineErrorCodes.contains) == true {
            connectionStatus = .offline
        } else {
            connectionStatus = .serverUnavailable
        }
    }

    private func backfillPastSenderLogos(generation: UUID) async {
        guard !Task.isCancelled, sessionGeneration == generation,
              UserDefaults.standard.integer(forKey: "senderLogoBackfillVersion") < 4, let client else { return }
        if UserDefaults.standard.integer(forKey: "senderLogoBackfillCursorVersion") != 4 {
            UserDefaults.standard.removeObject(forKey: "senderLogoBackfillCursor")
            UserDefaults.standard.set(4, forKey: "senderLogoBackfillCursorVersion")
        }
        var cursor = UserDefaults.standard.string(forKey: "senderLogoBackfillCursor")
        do {
            missingSenderLogos.removeAll()
            await cache.clearMissingSenderLogos()
            logoCacheVersion += 1
            for _ in 0..<32 {
                guard !Task.isCancelled, sessionGeneration == generation,
                      networkAvailable, allowsBackgroundNetworkWork else { return }
                let page = try await client.backfillSenderLogos(cursor: cursor)
                guard !Task.isCancelled, sessionGeneration == generation else { return }
                guard let next = page.nextCursor else {
                    UserDefaults.standard.removeObject(forKey: "senderLogoBackfillCursor")
                    UserDefaults.standard.set(4, forKey: "senderLogoBackfillVersion")
                    return
                }
                cursor = next
                UserDefaults.standard.set(next, forKey: "senderLogoBackfillCursor")
                try await Task.sleep(for: .milliseconds(100), tolerance: .milliseconds(50))
            }
        } catch {
            guard !Task.isCancelled else { return }
            // A later app launch resumes from the last completed batch.
        }
    }

    func clearError() { errorMessage = nil }

    private func establishSession(
        client: APIClient,
        who: WhoAmI,
        identities available: [MailIdentity],
        selectedInbox selected: String
    ) {
        stopSenderLogoBackfill()
        stopMailboxWatch()
        refreshTask?.cancel()
        sessionGeneration = UUID()
        refreshGeneration = nil
        refreshTask = nil
        refreshTaskKey = nil
        detailRequestGeneration = nil
        contactRequestGeneration = nil
        senderLogoRequests.values.forEach { $0.cancel() }
        senderLogoRequests = [:]
        senderLogos = [:]
        missingSenderLogos = []
        mailboxRevision = nil
        mailboxRevisionIdentity = nil
        presentedMailboxContext = nil
        self.client = client
        sessionWho = who
        identities = available
        selectedInbox = selected
        if !available.contains(where: { $0.address == identity }) { identity = selected }
        UserDefaults.standard.set(selectedInbox, forKey: "selectedInbox")
        UserDefaults.standard.set(identity, forKey: "identity")
        connectionLabel = isDemoMode ? "Demo Mailbox" : "Signed in as \(who.principal.name)"
        connectionStatus = canPerformRequests ? .online : .offline
        configured = true
        bootstrapFinished = true
        errorMessage = nil
        restartMailboxWatchIfNeeded()
    }

    private func isUnauthorized(_ error: Error) -> Bool {
        (error as? MailAPIError) == .unauthorized
    }

    static func mailboxRetryDelaySeconds(attempt: Int, jitter: Double) -> Double {
        let boundedAttempt = min(max(attempt, 0), 16)
        let base = min(pow(2, Double(boundedAttempt)), 300)
        let boundedJitter = min(max(jitter, 0), 1)
        return min(base * (0.8 + 0.4 * boundedJitter), 300)
    }

    static func sessionContextIsCurrent(
        generation: UUID,
        currentGeneration: UUID,
        identity: String,
        currentIdentity: String
    ) -> Bool {
        generation == currentGeneration && identity == currentIdentity
    }

    static func requestContextIsCurrent(
        requestID: UUID,
        currentRequestID: UUID?,
        generation: UUID,
        currentGeneration: UUID,
        identity: String,
        currentIdentity: String?
    ) -> Bool {
        requestID == currentRequestID
            && sessionContextIsCurrent(
                generation: generation,
                currentGeneration: currentGeneration,
                identity: identity,
                currentIdentity: currentIdentity ?? ""
            )
    }

    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        return urlErrorCode(error) == .cancelled
    }

    static func friendlyErrorMessage(_ error: Error) -> String {
        if let mailError = error as? MailAPIError {
            switch mailError {
            case .networkUnavailable:
                return "You’re offline. lmail will update automatically when your connection returns."
            case .timedOut:
                return "lmail couldn’t reach the server. Your saved mail is still available, and syncing will retry automatically."
            default:
                return mailError.localizedDescription
            }
        }
        if let code = urlErrorCode(error) {
            switch code {
            case .notConnectedToInternet, .internationalRoamingOff, .dataNotAllowed:
                return "You’re offline. lmail will update automatically when your connection returns."
            case .timedOut, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
                return "lmail couldn’t reach the server. Your saved mail is still available, and syncing will retry automatically."
            case .cancelled:
                return "The operation stopped before it finished."
            default:
                break
            }
        }
        return error.localizedDescription
    }

    static func friendlyActionErrorMessage(_ error: Error) -> String {
        if (error as? MailAPIError) == .networkUnavailable {
            return "That change couldn’t be saved because you’re offline. Reconnect and try again."
        }
        if (error as? MailAPIError) == .timedOut {
            return "That change didn’t reach the server. Check your connection and try again."
        }
        if let code = urlErrorCode(error), offlineErrorCodes.contains(code) {
            return "That change couldn’t be saved because you’re offline. Reconnect and try again."
        }
        if let code = urlErrorCode(error), code == .timedOut || code == .networkConnectionLost {
            return "That change didn’t reach the server. Check your connection and try again."
        }
        return friendlyErrorMessage(error)
    }

    private static let offlineErrorCodes: Set<URLError.Code> = [
        .notConnectedToInternet,
        .internationalRoamingOff,
        .dataNotAllowed,
        .callIsActive,
    ]

    private static func urlErrorCode(_ error: Error) -> URLError.Code? {
        if let error = error as? URLError { return error.code }
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return nil }
        return URLError.Code(rawValue: nsError.code)
    }

    private func expireSession(with error: Error) async {
        try? KeychainStore.deleteAccessToken()
        try? await clearSessionState(clearCache: true)
        presentError("Session Expired", error.localizedDescription)
    }

    static func supersededAccessToken(previous: String?, replacement: String) -> String? {
        guard let previous,
              !previous.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              previous != replacement else { return nil }
        return previous
    }

    static func requiresPrincipalCacheReset(
        previous: String?,
        replacement: String,
        cachedPrincipalKey: String? = nil,
        newPrincipalKey: String? = nil
    ) -> Bool {
        if supersededAccessToken(previous: previous, replacement: replacement) != nil { return true }
        guard let cachedPrincipalKey, let newPrincipalKey else { return false }
        return cachedPrincipalKey != newPrincipalKey
    }

    static func configuration(endpoint: URL, accessToken: String) -> APIConfiguration? {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              endpoint.scheme?.lowercased() == "https",
              endpoint.host != nil else { return nil }
        return APIConfiguration(endpoint: endpoint, accessToken: accessToken)
    }
}
