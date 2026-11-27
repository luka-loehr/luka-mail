import Foundation
import Testing
@testable import LukaMail

struct LukaMailTests {
    @Test @MainActor
    func createsConfigurationForValidHTTPSServerAndAccessToken() throws {
        let endpoint = try #require(ServerEndpoint.normalize("mail.example.com"))
        let configuration = MailStore.configuration(endpoint: endpoint, accessToken: "test-token")
        #expect(configuration?.endpoint.absoluteString == "https://mail.example.com")
        #expect(configuration?.accessToken == "test-token")
    }

    @Test
    func normalizesAndValidatesServerEndpoints() {
        #expect(ServerEndpoint.normalize("mail.example.com")?.absoluteString == "https://mail.example.com")
        #expect(ServerEndpoint.normalize("  MAIL.EXAMPLE.COM/inbox  ")?.absoluteString == "https://mail.example.com")
        #expect(ServerEndpoint.normalize("https://mail.example.org:8443/path")?.absoluteString == "https://mail.example.org:8443")
        #expect(ServerEndpoint.normalize("http://mail.example.com") == nil)
        #expect(ServerEndpoint.normalize("https://user:pass@mail.example.com") == nil)
        #expect(ServerEndpoint.normalize("localhost") == nil)
        #expect(ServerEndpoint.normalize("   ") == nil)
    }

    @Test @MainActor
    func rejectsEmptyAccessToken() throws {
        let endpoint = try #require(URL(string: "https://mail.example.com"))
        #expect(MailStore.configuration(endpoint: endpoint, accessToken: "  ") == nil)
    }

    @Test @MainActor
    func startupDoesNotPresentSignInUntilSessionRestorationFinishes() {
        #expect(MailStore.startupPresentation(configured: false, bootstrapFinished: false) == .restoringSession)
        #expect(MailStore.startupPresentation(configured: false, bootstrapFinished: true) == .signedOut)
        #expect(MailStore.startupPresentation(configured: true, bootstrapFinished: false) == .mailbox)
        #expect(MailStore.startupPresentation(configured: true, bootstrapFinished: true) == .mailbox)
    }

    @Test @MainActor
    func replacementSignInRevokesOnlyADifferentExistingToken() {
        #expect(MailStore.supersededAccessToken(previous: "old-token", replacement: "new-token") == "old-token")
        #expect(MailStore.supersededAccessToken(previous: "same-token", replacement: "same-token") == nil)
        #expect(MailStore.supersededAccessToken(previous: nil, replacement: "new-token") == nil)
        #expect(MailStore.supersededAccessToken(previous: "  ", replacement: "new-token") == nil)
        #expect(MailStore.requiresPrincipalCacheReset(previous: "old-token", replacement: "new-token"))
        #expect(!MailStore.requiresPrincipalCacheReset(previous: "same-token", replacement: "same-token"))
        #expect(!MailStore.requiresPrincipalCacheReset(previous: nil, replacement: "new-token"))
        #expect(MailStore.requiresPrincipalCacheReset(
            previous: nil,
            replacement: "new-token",
            cachedPrincipalKey: "old-principal",
            newPrincipalKey: "new-principal"
        ))
        #expect(!MailStore.requiresPrincipalCacheReset(
            previous: nil,
            replacement: "new-token",
            cachedPrincipalKey: "same-principal",
            newPrincipalKey: "same-principal"
        ))
    }

    @Test
    func localCacheClearDeletesDataAndSurfacesFilesystemFailure() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "LukaMailTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let directory = root.appending(path: "Cache", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("cached".utf8).write(to: directory.appending(path: "message.json"))

        let cache = MailCache(directory: directory)
        try await cache.clear()
        #expect(!FileManager.default.fileExists(atPath: directory.path))
        try await cache.clear()

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let failingCache = MailCache(directory: directory, removeDirectory: { _ in
            throw CocoaError(.fileWriteNoPermission)
        })
        do {
            try await failingCache.clear()
            Issue.record("A failed cache deletion was reported as successful")
        } catch let error as MailCacheError {
            #expect(error == .clearFailed)
        }
        #expect(FileManager.default.fileExists(atPath: directory.path))
    }

    @Test
    func persistentCacheRestoresMailboxAndSessionMetadata() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "LukaMailCacheSnapshotTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = MailCache(directory: root)
        let endpoint = "https://mail.example.com"
        let identity = "person@example.com"
        let message = MailMessage(
            id: "message-1",
            threadId: "thread-1",
            direction: "inbound",
            folder: "inbox",
            subject: "Cached mail",
            sender: MailAddress(name: "Sender", address: "sender@example.com"),
            recipients: [MailAddress(address: identity)],
            preview: "Available offline",
            receivedAt: "2026-08-12T10:00:00Z",
            unread: true,
            starred: false,
            hasAttachments: false,
            attachmentCount: 0,
            storedAttachmentCount: 0,
            attachmentsTruncated: false,
            size: 128
        )
        let page = MessagePage(messages: [message], nextCursor: "next-page")
        let summary = MailSummary(unread: 1, inbox: 1, sent: 2, starred: 0, archive: 3, trash: 0, drafts: 1)
        let session = CachedMailSession(
            who: WhoAmI(
                principal: .init(keyId: "key", name: "Person", scopes: ["mail:read"], allowedIdentities: [identity]),
                owner: identity
            ),
            identities: [MailIdentity(address: identity, displayName: "Person")]
        )
        let draft = Draft.compose(from: identity)

        await cache.save(page, for: .inbox, endpoint: endpoint, identity: identity)
        await cache.saveSummary(summary, endpoint: endpoint, identity: identity)
        await cache.saveSession(session, endpoint: endpoint)
        await cache.saveDrafts([draft], endpoint: endpoint, identity: identity)
        await cache.saveAttachment(Data("inline-image".utf8), id: "attachment-1", endpoint: endpoint, identity: identity)

        let pageSnapshot = await cache.pageSnapshot(for: .inbox, endpoint: endpoint, identity: identity)
        let restoredSummary = await cache.summary(endpoint: endpoint, identity: identity)
        let restoredSession = await cache.session(endpoint: endpoint)
        let restoredDrafts = await cache.drafts(endpoint: endpoint, identity: identity)
        let restoredAttachment = await cache.attachment(id: "attachment-1", endpoint: endpoint, identity: identity)

        #expect(pageSnapshot?.value.messages.map(\.id) == ["message-1"])
        #expect(pageSnapshot?.value.nextCursor == "next-page")
        #expect(pageSnapshot?.savedAt.timeIntervalSinceNow ?? -10 > -2)
        #expect(restoredSummary?.unread == 1)
        #expect(restoredSession?.identities.map(\.address) == [identity])
        #expect(restoredSession?.who.principal.name == "Person")
        #expect(restoredDrafts?.count == 1)
        #expect(restoredAttachment == Data("inline-image".utf8))
    }

    @Test @MainActor
    func retryBackoffIsJitteredAndBounded() {
        #expect(abs(MailStore.mailboxRetryDelaySeconds(attempt: 0, jitter: 0) - 0.8) < 0.0001)
        #expect(abs(MailStore.mailboxRetryDelaySeconds(attempt: 0, jitter: 1) - 1.2) < 0.0001)
        #expect(abs(MailStore.mailboxRetryDelaySeconds(attempt: 4, jitter: 0.5) - 16) < 0.0001)
        #expect(abs(MailStore.mailboxRetryDelaySeconds(attempt: 99, jitter: 1) - 300) < 0.0001)
        #expect(abs(MailStore.mailboxRetryDelaySeconds(attempt: -1, jitter: -1) - 0.8) < 0.0001)
    }

    @Test @MainActor
    func networkCancellationIsSilentAndOfflineErrorsAreActionable() {
        #expect(MailStore.isCancellation(CancellationError()))
        #expect(MailStore.isCancellation(URLError(.cancelled)))
        #expect(!MailStore.isCancellation(MailAPIError.networkUnavailable))
        #expect(MailStore.friendlyErrorMessage(MailAPIError.networkUnavailable).contains("offline"))
        #expect(MailStore.friendlyActionErrorMessage(MailAPIError.networkUnavailable).contains("couldn’t be saved"))
        #expect(MailStore.friendlyErrorMessage(MailAPIError.timedOut).contains("saved mail"))
    }

    @Test
    func blobCachePruningRemovesOldestFilesDownToTargetBudget() {
        let now = Date(timeIntervalSince1970: 1_000)
        let entries = [
            BlobCacheEntry(url: URL(fileURLWithPath: "/cache/old"), size: 50, modifiedAt: now.addingTimeInterval(-30)),
            BlobCacheEntry(url: URL(fileURLWithPath: "/cache/middle"), size: 40, modifiedAt: now.addingTimeInterval(-20)),
            BlobCacheEntry(url: URL(fileURLWithPath: "/cache/new"), size: 30, modifiedAt: now.addingTimeInterval(-10)),
        ]

        #expect(MailCache.blobFilesToRemove(entries, maximumBytes: 100, targetBytes: 70)
            == [URL(fileURLWithPath: "/cache/old")])
        #expect(MailCache.blobFilesToRemove(entries, maximumBytes: 120, targetBytes: 70).isEmpty)
        #expect(MailCache.blobFilesToRemove(entries, maximumBytes: 100, targetBytes: 40)
            == [URL(fileURLWithPath: "/cache/old"), URL(fileURLWithPath: "/cache/middle")])
    }

    @Test
    func cacheMaintenanceRejectsCancelledOrSupersededGeneration() {
        let taskID = UUID()
        #expect(MailCache.maintenanceContextIsCurrent(
            taskID: taskID,
            currentTaskID: taskID,
            generation: 4,
            currentGeneration: 4
        ))
        #expect(!MailCache.maintenanceContextIsCurrent(
            taskID: taskID,
            currentTaskID: UUID(),
            generation: 4,
            currentGeneration: 4
        ))
        #expect(!MailCache.maintenanceContextIsCurrent(
            taskID: taskID,
            currentTaskID: taskID,
            generation: 4,
            currentGeneration: 5
        ))
    }

    @Test @MainActor
    func asynchronousResponsesApplyOnlyToTheirOriginalSessionAndLatestRequest() {
        let originalGeneration = UUID()
        let newerGeneration = UUID()
        let latestRequest = UUID()
        let staleRequest = UUID()

        #expect(MailStore.sessionContextIsCurrent(
            generation: originalGeneration,
            currentGeneration: originalGeneration,
            identity: "one@example.com",
            currentIdentity: "one@example.com"
        ))
        #expect(!MailStore.sessionContextIsCurrent(
            generation: originalGeneration,
            currentGeneration: newerGeneration,
            identity: "one@example.com",
            currentIdentity: "one@example.com"
        ))
        #expect(!MailStore.sessionContextIsCurrent(
            generation: originalGeneration,
            currentGeneration: originalGeneration,
            identity: "one@example.com",
            currentIdentity: "two@example.com"
        ))
        #expect(MailStore.requestContextIsCurrent(
            requestID: latestRequest,
            currentRequestID: latestRequest,
            generation: originalGeneration,
            currentGeneration: originalGeneration,
            identity: "one@example.com",
            currentIdentity: "one@example.com"
        ))
        #expect(!MailStore.requestContextIsCurrent(
            requestID: staleRequest,
            currentRequestID: latestRequest,
            generation: originalGeneration,
            currentGeneration: originalGeneration,
            identity: "one@example.com",
            currentIdentity: "one@example.com"
        ))
    }

    @Test @MainActor
    func nativeAuthorizationURLUsesExactPKCEContract() throws {
        let endpoint = try #require(URL(string: "https://mail.example.com"))
        let url = try NativeAuthSession.authorizeURL(endpoint: endpoint, state: "state-value", challenge: "challenge-value", platform: .ios)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
            item.value.map { (item.name, $0) }
        })

        #expect(components.scheme == "https")
        #expect(components.host == "mail.example.com")
        #expect(components.path == "/auth/native/authorize")
        #expect(query["redirect_uri"] == "lmail://auth/callback")
        #expect(query["state"] == "state-value")
        #expect(query["code_challenge"] == "challenge-value")
        #expect(query["code_challenge_method"] == "S256")
        #expect(query["platform"] == "ios")
    }

    @Test @MainActor
    func nativeCallbackRequiresExactOriginAndMatchingState() throws {
        let valid = try #require(URL(string: "lmail://auth/callback?code=one-time-code&state=expected"))
        #expect(try NativeAuthSession.validatedCode(from: valid, expectedState: "expected") == "one-time-code")
        let legacyValid = try #require(URL(string: "lukamail://auth/callback?code=legacy-code&state=expected"))
        #expect(try NativeAuthSession.validatedCode(from: legacyValid, expectedState: "expected") == "legacy-code")

        for rawURL in [
            "https://mail.example.com/auth/native/callback?code=one-time-code&state=expected",
            "otherapp://auth/callback?code=one-time-code&state=expected",
            "lmail://evil/callback?code=one-time-code&state=expected",
            "lmail://auth/other?code=one-time-code&state=expected",
            "lmail://user@auth/callback?code=one-time-code&state=expected",
            "lmail://auth/callback?code=one-time-code&state=wrong",
            "lmail://auth/callback?code=one-time-code&state=expected&state=expected",
            "lmail://auth/callback?state=expected",
        ] {
            let url = try #require(URL(string: rawURL))
            do {
                _ = try NativeAuthSession.validatedCode(from: url, expectedState: "expected")
                Issue.record("Accepted an invalid native auth callback: \(rawURL)")
            } catch let error as NativeAuthError {
                #expect(error == .invalidCallback)
            }
        }
    }

    @Test @MainActor
    func nativeAuthCompletionCanRunOnSafariXPCExecutor() async throws {
        let callbackURL = try #require(URL(string: "lmail://auth/callback?code=one-time-code&state=expected"))
        let owner = NativeAuthSession()
        let resolved: URL = try await withCheckedThrowingContinuation { continuation in
            let completion = NativeAuthSession.authenticationCompletion(owner: owner, continuation: continuation)
            DispatchQueue.global(qos: .userInitiated).async {
                completion(callbackURL, nil)
            }
        }

        #expect(resolved == callbackURL)
    }

    @Test
    func parsesFractionalAndStandardISO8601Dates() {
        #expect(MailDate.parse("2026-08-08T10:00:00.123Z") != nil)
        #expect(MailDate.parse("2026-08-08T10:00:00Z") != nil)
    }

    @Test
    func mailboxMetadataIsStable() {
        #expect(Mailbox.inbox.apiFolder == "inbox")
        #expect(Mailbox.drafts.apiFolder == "inbox")
        #expect(Mailbox.allCases.count == 6)
    }

    @Test
    func decodesLegacyAndStructuredRecipients() throws {
        let decoder = JSONDecoder()
        let legacy = try decoder.decode([MailAddress].self, from: Data("[\"person@example.com\"]".utf8))
        let structured = try decoder.decode([MailAddress].self, from: Data("[{\"name\":\"Person\",\"address\":\"person@example.com\"}]".utf8))

        #expect(legacy == [MailAddress(address: "person@example.com")])
        #expect(structured == [MailAddress(name: "Person", address: "person@example.com")])
    }

    @Test
    func rememberedContactMatchesNameAndAddressCaseInsensitively() {
        let contact = MailContact(identityAddress: "alex@example.com", address: "friend@example.com",
            displayName: "Friendly Person", avatarColor: "#123456", source: "learned", sendCount: 3,
            firstSentAt: nil, lastSentAt: nil, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z")
        #expect(contact.matches("FRIENDLY"))
        #expect(contact.matches("example.com"))
        #expect(!contact.matches("someone else"))
    }

    @Test
    func decodesMailboxRevisionAsAnOpaqueString() throws {
        let state = try JSONDecoder().decode(MailboxState.self,
            from: Data("{\"revision\":\"42\",\"changed\":true}".utf8))
        #expect(state.revision == "42")
        #expect(state.changed)
    }

    @Test @MainActor
    func deltaRemovesOneRowFromALargeMailboxWithoutReplacingTheList() {
        let messages = (0..<10_000).map { index in
            Self.testMessage(id: "message-\(index)", folder: "inbox", receivedAt: String(format: "2026-08-12T10:%02d:%02dZ", (index / 60) % 60, index % 60))
        }.sorted(by: MailStore.messageSortsBefore)
        let removedID = messages[99].id
        let deletion = MailboxChange(revision: "2", kind: "message", id: removedID, operation: "delete",
            threadId: "thread-\(removedID)", previousFolder: "inbox", message: nil, draft: nil)

        let reconciled = MailStore.applying(deletion, to: messages, mailbox: .inbox, nextCursor: nil)

        #expect(reconciled.count == 9_999)
        #expect(!reconciled.contains { $0.id == removedID })
        #expect(reconciled.first?.id == messages.first?.id)
    }

    @Test @MainActor
    func deltaReconcilesMovesStarsAndLoadedPageBoundaries() throws {
        let first = Self.testMessage(id: "first", folder: "inbox", receivedAt: "2026-08-12T12:00:00Z")
        let last = Self.testMessage(id: "last", folder: "inbox", receivedAt: "2026-08-12T11:00:00Z")
        let cursorData = try JSONSerialization.data(withJSONObject: ["time": last.receivedAt, "id": last.id])
        let cursor = cursorData.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        var moved = first
        moved.folder = "archive"
        let move = MailboxChange(revision: "3", kind: "message", id: first.id, operation: "upsert",
            threadId: first.threadId, previousFolder: "inbox", message: moved, draft: nil)
        var result = MailStore.applying(move, to: [first, last], mailbox: .inbox, nextCursor: cursor)
        #expect(result.map { $0.id } == ["last"])

        var starred = Self.testMessage(id: "starred", folder: "archive", receivedAt: "2026-08-12T11:30:00Z")
        starred.starred = true
        let star = MailboxChange(revision: "4", kind: "message", id: starred.id, operation: "upsert",
            threadId: starred.threadId, previousFolder: "archive", message: starred, draft: nil)
        result = MailStore.applying(star, to: [], mailbox: .starred, nextCursor: cursor)
        #expect(result.map { $0.id } == ["starred"])

        let tooOld = Self.testMessage(id: "old", folder: "inbox", receivedAt: "2026-08-12T10:00:00Z")
        let oldChange = MailboxChange(revision: "5", kind: "message", id: tooOld.id, operation: "upsert",
            threadId: tooOld.threadId, previousFolder: nil, message: tooOld, draft: nil)
        #expect(MailStore.applying(oldChange, to: [last], mailbox: .inbox, nextCursor: cursor).map { $0.id } == ["last"])
    }

    @Test
    func decodesPaginatedAndResetMailboxDeltas() throws {
        let page = try JSONDecoder().decode(MailboxDelta.self, from: Data("""
        {"identity":"person@example.com","fromRevision":"8","revision":"10","changes":[],
         "summary":{"unread":1,"inbox":1,"sent":0,"starred":0,"archive":0,"trash":0,"drafts":0},
         "hasMore":true,"nextCursor":"cursor","resetRequired":false}
        """.utf8))
        #expect(page.identity == "person@example.com")
        #expect(page.hasMore && page.nextCursor == "cursor")

        let reset = try JSONDecoder().decode(MailboxDelta.self, from: Data("""
        {"fromRevision":"1","revision":"99","changes":[],"hasMore":false,"nextCursor":null,
         "resetRequired":true,"reason":"history_expired"}
        """.utf8))
        #expect(reset.resetRequired && reset.reason == "history_expired")
        #expect(reset.summary == nil)
    }

    @Test @MainActor
    func liveIdentityRefreshAddsDropdownAccountsWithoutChangingTheSelection() {
        let original = MailIdentity(address: "alex@example.com", displayName: "Alex")
        let added = MailIdentity(address: "work@example.org", displayName: "Work Account")
        #expect(MailStore.selectedInboxAfterIdentityRefresh(current: original.address,
                                                            available: [added, original]) == original.address)
        #expect(MailStore.selectedInboxAfterIdentityRefresh(current: original.address,
                                                            available: [added]) == added.address)
    }

    @Test @MainActor
    func spamMessagesStayOutOfInboxDeltasAndInlineAttachmentsRejectUnsafeTypes() {
        var spamMessage = Self.testMessage(id: "spam-1", folder: "inbox", receivedAt: "2026-08-12T12:00:00Z")
        spamMessage.spam = true
        let spamChange = MailboxChange(revision: "9", kind: "message", id: spamMessage.id, operation: "upsert",
            threadId: spamMessage.threadId, previousFolder: nil, message: spamMessage, draft: nil)
        #expect(MailStore.applying(spamChange, to: [], mailbox: .inbox, nextCursor: nil).isEmpty)

        #expect(MailStore.sanitizedInlineImageSpec(contentId: "<banner@demo>", contentType: "image/png; name=banner.png")?.mime == "image/png")
        #expect(MailStore.sanitizedInlineImageSpec(contentId: "<evil@demo>", contentType: "image/svg+xml") == nil)
        #expect(MailStore.sanitizedInlineImageSpec(contentId: "<evil@demo>", contentType: "image/png\" onerror=\"alert(1)") == nil)
        #expect(MailStore.sanitizedInlineImageSpec(contentId: "bad\"cid", contentType: "image/png") == nil)

        let attachment = MailAttachment(id: "../escape/../../id", filename: "..\\..\\secret.pdf",
                                        contentType: "application/pdf", contentId: nil, size: 12, disposition: "attachment")
        let tempURL = attachment.temporaryFileURL()
        #expect(tempURL.deletingLastPathComponent().lastPathComponent == "LukaMail")
        #expect(!tempURL.lastPathComponent.contains(".."))
    }

    private static func testMessage(id: String, folder: String, receivedAt: String) -> MailMessage {
        MailMessage(id: id, threadId: "thread-\(id)", direction: "inbound", folder: folder,
            subject: id, sender: MailAddress(address: "sender@example.com"),
            recipients: [MailAddress(address: "person@example.com")], preview: id, receivedAt: receivedAt,
            unread: true, starred: false, hasAttachments: false, attachmentCount: 0,
            storedAttachmentCount: 0, attachmentsTruncated: false, size: 1)
    }
}
