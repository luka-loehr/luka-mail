import Foundation

struct APIConfiguration: Sendable, Equatable {
    let endpoint: URL
    let accessToken: String
}

struct SenderLogoAsset: Codable, Sendable, Equatable {
    let data: Data
    let contentType: String
    let etag: String?

    init(data: Data, contentType: String, etag: String? = nil) {
        self.data = data
        self.contentType = contentType
        self.etag = etag
    }
}

enum MailAPIError: LocalizedError, Equatable {
    case invalidConfiguration
    case networkUnavailable
    case timedOut
    case unauthorized
    case forbidden
    case rateLimited
    case server(Int, String)
    case invalidResponse(String?)

    var isRetryable: Bool {
        switch self {
        case .networkUnavailable, .timedOut, .rateLimited: true
        case .server(let status, _): status >= 500
        default: false
        }
    }

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "Your lmail session is invalid. Sign in again."
        case .networkUnavailable: "You’re offline. lmail is showing the mail saved on this device."
        case .timedOut: "The mail server is taking longer than expected. Cached mail is still available."
        case .unauthorized: "Your lmail session expired or was revoked. Sign in again."
        case .forbidden: "This session does not have the required permission."
        case .rateLimited: "Too many requests. Try again in a minute."
        case .server(_, let message): message
        case .invalidResponse(let endpoint):
            if let endpoint { "The server returned an invalid response for \(endpoint)." }
            else { "The server returned an invalid response." }
        }
    }
}

actor APIClient {
    private let configuration: APIConfiguration
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(configuration: APIConfiguration, session: URLSession? = nil) {
        self.configuration = configuration
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 15
            config.timeoutIntervalForResource = 45
            config.waitsForConnectivity = false
            config.urlCache = URLCache(memoryCapacity: 32 * 1_024 * 1_024, diskCapacity: 0, directory: nil)
            config.requestCachePolicy = .useProtocolCachePolicy
            config.httpMaximumConnectionsPerHost = 8
            config.httpAdditionalHeaders = ["Accept": "application/json"]
            self.session = URLSession(configuration: config)
        }
    }

    func whoAmI() async throws -> WhoAmI { try await json("v1/whoami") }
    func summary(identity: String) async throws -> MailSummary {
        try await json("v1/summary", query: [URLQueryItem(name: "identity", value: identity)])
    }
    func mailboxState(identity: String, after revision: String? = nil, waitSeconds: Int = 0) async throws -> MailboxState {
        var query = [URLQueryItem(name: "identity", value: identity), URLQueryItem(name: "wait", value: String(waitSeconds))]
        if let revision { query.append(URLQueryItem(name: "after", value: revision)) }
        var request = try makeRequest("v1/mailbox-state", query: query)
        request.timeoutInterval = TimeInterval(waitSeconds + 10)
        return try await decode(request)
    }
    func mailboxSnapshot(
        folder: Mailbox,
        identity: String,
        query: String = "",
        limit: Int = 50,
        includeAddresses: Bool = false
    ) async throws -> MailboxSnapshot {
        var items = [
            URLQueryItem(name: "identity", value: identity),
            URLQueryItem(name: "folder", value: folder.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "includeAddresses", value: includeAddresses ? "1" : "0"),
        ]
        if !query.isEmpty { items.append(URLQueryItem(name: "query", value: query)) }
        return try await json("v1/mailbox-snapshot", query: items)
    }
    func mailboxDelta(identity: String, since revision: String, cursor: String? = nil, limit: Int = 100) async throws -> MailboxDelta {
        var items = [
            URLQueryItem(name: "identity", value: identity),
            URLQueryItem(name: "since", value: revision),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await json("v1/mailbox-delta", query: items)
    }
    func registerPushDevice(token: String, environment: String, identities: [String]) async throws {
        let _: PushDeviceResponse = try await json("v1/push-devices", method: "PUT",
            body: PushDeviceRequest(deviceToken: token, environment: environment, identities: identities))
    }
    func identities() async throws -> [MailIdentity] {
        let response: IdentityResponse = try await json("v1/addresses")
        return response.addresses
    }
    func contacts(identity: String, query: String = "", limit: Int = 200) async throws -> [MailContact] {
        var items = [URLQueryItem(name: "identity", value: identity), URLQueryItem(name: "limit", value: String(limit))]
        if !query.isEmpty { items.append(URLQueryItem(name: "query", value: query)) }
        let response: ContactResponse = try await json("v1/contacts", query: items)
        return response.contacts
    }
    func createContact(identity: String, address: String, displayName: String) async throws -> MailContact {
        let response: ContactMutationResponse = try await json("v1/contacts", method: "POST",
            body: ContactMutationRequest(identity: identity, address: address, displayName: displayName))
        return response.contact
    }
    func updateContact(identity: String, address: String, displayName: String) async throws -> MailContact {
        let response: ContactMutationResponse = try await json("v1/contacts/\(encoded(address))", method: "PATCH",
            body: ContactMutationRequest(identity: identity, address: nil, displayName: displayName))
        return response.contact
    }
    func deleteContact(identity: String, address: String) async throws {
        let _: DeletedContact = try await json("v1/contacts/\(encoded(address))",
            query: [URLQueryItem(name: "identity", value: identity)], method: "DELETE")
    }
    func messages(folder: Mailbox, identity: String, query: String = "", cursor: String? = nil, limit: Int = 50) async throws -> MessagePage {
        var items = [URLQueryItem(name: "folder", value: folder.apiFolder), URLQueryItem(name: "identity", value: identity),
                     URLQueryItem(name: "limit", value: String(limit))]
        if !query.isEmpty { items.append(URLQueryItem(name: "query", value: query)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await json("v1/messages", query: items)
    }
    func message(id: String, identity: String) async throws -> MailDetail {
        try await json("v1/messages/\(encoded(id))", query: [URLQueryItem(name: "identity", value: identity)])
    }
    func drafts(identity: String) async throws -> [Draft] {
        let response: DraftResponse = try await json("v1/drafts", query: [URLQueryItem(name: "identity", value: identity)])
        return response.drafts
    }
    func updateMessage(id: String, update: MessageUpdate) async throws {
        let _: UpdatedMessage = try await json("v1/messages/\(encoded(id))", method: "PATCH", body: update)
    }
    func saveDraft(_ draft: Draft) async throws -> String {
        let response: SavedDraft = try await json("v1/drafts", method: "PUT", body: draft)
        return response.id
    }
    func deleteDraft(id: String) async throws {
        let _: DeletedDraft = try await json("v1/drafts/\(encoded(id))", method: "DELETE")
    }
    func send(_ request: SendRequest) async throws -> SentMessage {
        try await json("v1/messages/send", method: "POST", body: request)
    }
    func attachment(id: String) async throws -> Data { try await data("v1/attachments/\(encoded(id))") }
    func rawMessage(id: String) async throws -> Data { try await data("v1/messages/\(encoded(id))/raw") }
    func senderLogo(messageID: String) async throws -> SenderLogoAsset {
        var request = try makeRequest("v1/messages/\(encoded(messageID))/sender-logo")
        request.setValue("image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8", forHTTPHeaderField: "Accept")
        let (payload, response) = try await transportData(for: request)
        try validate(response, payload: payload)
        guard let http = response as? HTTPURLResponse else { throw MailAPIError.invalidResponse(request.url?.path) }
        return SenderLogoAsset(
            data: payload,
            contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "image/svg+xml",
            etag: http.value(forHTTPHeaderField: "ETag")
        )
    }
    func backfillSenderLogos(cursor: String?) async throws -> LogoBackfillPage {
        let query = cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? []
        return try await json("v1/logo-backfill", query: query, method: "POST")
    }

    // MARK: Agent chats

    func agentChats(limit: Int = 100) async throws -> [AgentChatSummary] {
        let response: AgentChatList = try await json("v1/agent/chats", query: [URLQueryItem(name: "limit", value: String(limit))])
        return response.chats
    }
    func agentChat(id: String) async throws -> AgentChatDetail { try await json("v1/agent/chats/\(encoded(id))") }
    func deleteAgentChat(id: String) async throws {
        let _: AgentChatDeleted = try await json("v1/agent/chats/\(encoded(id))", method: "DELETE")
    }
    func updateAgentDraft(chatID: String, draftID: String, patch: AgentDraftPatch) async throws -> AgentDraft {
        let response: AgentDraftResponse = try await json("v1/agent/chats/\(encoded(chatID))/drafts/\(encoded(draftID))",
                                                          method: "PATCH", body: patch)
        return response.draft
    }
    func sendAgentDraft(chatID: String, draftID: String, request: AgentDraftSendRequest) async throws -> AgentDraftSendResponse {
        var urlRequest = try makeRequest("v1/agent/chats/\(encoded(chatID))/drafts/\(encoded(draftID))/send", method: "POST",
                                         body: try encoder.encode(request))
        urlRequest.timeoutInterval = 60
        return try await decode(urlRequest)
    }

    /// Runs one chat turn and hands every streamed event to `onEvent` as it arrives.
    func streamAgentTurn(_ turn: AgentTurnRequest, onEvent: @Sendable (AgentStreamEvent) async -> Void) async throws {
        var request = try makeRequest("v1/agent/chats", method: "POST", body: try encoder.encode(turn))
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 330
        // Agent turns run for minutes; the mailbox session gives up after 45 seconds.
        let configuration = session.configuration
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 330
        let streamingSession = URLSession(configuration: configuration)
        defer { streamingSession.finishTasksAndInvalidate() }
        let (bytes, response) = try await streamingSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw MailAPIError.invalidResponse(request.url?.path) }
        guard (200..<300).contains(http.statusCode) else {
            var payload = Data()
            for try await byte in bytes { payload.append(byte) }
            try validate(response, payload: payload)
            return
        }
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if let event = AgentStreamEvent.decode(line) { await onEvent(event) }
        }
    }

    private func encoded(_ component: String) -> String {
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return component.addingPercentEncoding(withAllowedCharacters: unreserved) ?? component
    }

    private func makeRequest(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard configuration.endpoint.scheme == "https",
              var components = URLComponents(url: configuration.endpoint.appending(path: path), resolvingAgainstBaseURL: false) else {
            throw MailAPIError.invalidConfiguration
        }
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw MailAPIError.invalidConfiguration }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(configuration.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func json<Response: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], method: String = "GET") async throws -> Response {
        try await decode(makeRequest(path, query: query, method: method))
    }

    private func json<Response: Decodable & Sendable, Body: Encodable & Sendable>(_ path: String, method: String, body: Body) async throws -> Response {
        try await decode(makeRequest(path, method: method, body: try encoder.encode(body)))
    }

    private func decode<Response: Decodable & Sendable>(_ request: URLRequest) async throws -> Response {
        let (payload, response) = try await transportData(for: request)
        try validate(response, payload: payload)
        do { return try decoder.decode(Response.self, from: payload) }
        catch { throw MailAPIError.invalidResponse(request.url?.path) }
    }

    private func data(_ path: String) async throws -> Data {
        let (payload, response) = try await transportData(for: makeRequest(path))
        try validate(response, payload: payload)
        return payload
    }

    private func transportData(for request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError {
            switch error.code {
            case .cancelled:
                throw CancellationError()
            case .timedOut:
                throw MailAPIError.timedOut
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed,
                 .internationalRoamingOff, .cannotFindHost, .cannotConnectToHost,
                 .dnsLookupFailed:
                throw MailAPIError.networkUnavailable
            default:
                throw error
            }
        }
    }

    private func validate(_ response: URLResponse, payload: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw MailAPIError.invalidResponse(nil) }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? decoder.decode(APIErrorBody.self, from: payload).error) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            switch http.statusCode {
            case 401: throw MailAPIError.unauthorized
            case 403: throw MailAPIError.forbidden
            case 429: throw MailAPIError.rateLimited
            default: throw MailAPIError.server(http.statusCode, message)
            }
        }
    }
}

private struct APIErrorBody: Decodable {
    let error: String
    let code: String?
    let retryable: Bool?
    let requestId: String?
}
