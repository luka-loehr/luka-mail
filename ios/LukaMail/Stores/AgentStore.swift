import Foundation
import Observation

/// The Agent tab: saved chats with the mail agent, the open conversation, and
/// the emails it proposed. The agent never sends; `sendDraft` is the only way
/// one leaves, and the views call it only after the owner confirmed.
@MainActor
@Observable
final class AgentStore {
    private(set) var chats: [AgentChatSummary] = []
    private(set) var chatID: String?
    private(set) var title = "Agent"
    private(set) var messages: [AgentChatMessage] = []
    private(set) var streaming = false
    private(set) var loadingChat = false
    private(set) var loadingChats = false
    /// What the agent is doing right now, for the working indicator.
    private(set) var liveStatus: String?
    private(set) var errorMessage: String?
    private(set) var sendingDraftIDs: Set<String> = []

    @ObservationIgnored private let mail: MailStore
    @ObservationIgnored private var turnTask: Task<Void, Never>?
    @ObservationIgnored private var draftSaveTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var openGeneration = UUID()
    /// The assistant message the running turn writes into; it is renamed to the server's id once known.
    @ObservationIgnored private var activeAssistantID: String?

    init(mail: MailStore) {
        self.mail = mail
    }

    var isEmpty: Bool { messages.isEmpty }

    func clearError() { errorMessage = nil }

    func loadChats() async {
        guard let client = mail.agentAPI else { return }
        loadingChats = true
        defer { loadingChats = false }
        do {
            chats = try await client.agentChats()
        } catch {
            if !(error is CancellationError) { errorMessage = error.localizedDescription }
        }
    }

    func newChat() {
        stop()
        openGeneration = UUID()
        chatID = nil
        title = "Agent"
        messages = []
        liveStatus = nil
    }

    func open(_ chat: AgentChatSummary) async {
        await open(chatID: chat.id, title: chat.title)
    }

    func open(chatID id: String, title chatTitle: String? = nil) async {
        guard let client = mail.agentAPI, id != chatID || messages.isEmpty else { return }
        stop()
        let generation = UUID()
        openGeneration = generation
        chatID = id
        title = chatTitle ?? title
        messages = []
        loadingChat = true
        defer { if openGeneration == generation { loadingChat = false } }
        do {
            let detail = try await client.agentChat(id: id)
            guard openGeneration == generation else { return }
            title = detail.chat.title
            messages = detail.messages
        } catch {
            guard openGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
    }

    func delete(_ chat: AgentChatSummary) async {
        guard let client = mail.agentAPI else { return }
        chats.removeAll { $0.id == chat.id }
        if chat.id == chatID { newChat() }
        do { try await client.deleteAgentChat(id: chat.id) } catch { errorMessage = error.localizedDescription }
    }

    /// Asks the agent. Pending edits to proposed emails are saved first, so it sees them.
    func ask(_ text: String) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !streaming, let client = mail.agentAPI else { return }
        let userID = "local-user-\(UUID().uuidString)"
        let assistantID = "local-assistant-\(UUID().uuidString)"
        messages.append(AgentChatMessage(id: userID, role: .user, content: prompt, createdAt: Date.now.formatted(.iso8601)))
        messages.append(AgentChatMessage(id: assistantID, role: .assistant, content: ""))
        streaming = true
        liveStatus = "Thinking"
        let generation = openGeneration
        let currentChat = chatID
        activeAssistantID = assistantID
        turnTask = Task { [weak self] in
            guard let self else { return }
            await self.flushDraftEdits()
            do {
                try await client.streamAgentTurn(AgentTurnRequest(chatId: currentChat, text: prompt)) { [weak self] event in
                    await MainActor.run {
                        guard let self, self.openGeneration == generation else { return }
                        self.apply(event, user: userID)
                    }
                }
            } catch is CancellationError {
                // Stopped by the owner: keep what arrived.
            } catch let error as URLError where error.code == .cancelled {
                // Stopped by the owner.
            } catch {
                guard self.openGeneration == generation else { return }
                self.update(self.activeAssistantID ?? assistantID) { message in
                    message.error = error.localizedDescription
                }
            }
            guard self.openGeneration == generation else { return }
            self.streaming = false
            self.liveStatus = nil
            self.turnTask = nil
            await self.loadChats()
        }
    }

    func stop() {
        turnTask?.cancel()
        turnTask = nil
        streaming = false
        liveStatus = nil
    }

    private func apply(_ event: AgentStreamEvent, user: String) {
        guard let assistant = activeAssistantID else { return }
        switch event {
        case .chat(let chat, let userMessageID, let assistantMessageID):
            chatID = chat
            rename(user, to: userMessageID)
            rename(assistant, to: assistantMessageID)
            activeAssistantID = assistantMessageID
        case .reasoning:
            if liveStatus == nil { liveStatus = "Thinking" }
        case .text(let text):
            liveStatus = nil
            update(assistant) { $0.content += text }
        case .toolCall(let activity):
            liveStatus = activity.label
            update(assistant) { $0.activity.append(activity) }
        case .draft(let draft):
            update(assistant) { $0.drafts.append(draft) }
            if let replaced = draft.revisesDraftId { setStatus(.superseded, of: replaced) }
        case .sources(let sources):
            update(assistant) { message in
                for source in sources {
                    if let index = message.sources.firstIndex(where: { $0.id == source.id }) {
                        message.sources[index].read = message.sources[index].read || source.read
                    } else {
                        message.sources.append(source)
                    }
                }
            }
        case .title(let newTitle):
            title = newTitle
        case .finish:
            liveStatus = nil
        case .error(let message):
            update(assistant) { $0.error = message }
        case .other:
            break
        }
    }

    private func rename(_ id: String, to newID: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].id = newID
    }

    private func update(_ id: String, _ change: (inout AgentChatMessage) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
    }

    private func setStatus(_ status: AgentDraft.Status, of draftID: String) {
        for index in messages.indices {
            if let draftIndex = messages[index].drafts.firstIndex(where: { $0.id == draftID }) {
                messages[index].drafts[draftIndex].status = status
            }
        }
    }

    func draft(_ id: String) -> AgentDraft? {
        messages.lazy.flatMap(\.drafts).first { $0.id == id }
    }

    /// Applies an edit locally at once and saves it shortly after the owner stops typing.
    func edit(_ draft: AgentDraft) {
        guard draft.isEditable else { return }
        for index in messages.indices {
            if let draftIndex = messages[index].drafts.firstIndex(where: { $0.id == draft.id }) {
                messages[index].drafts[draftIndex] = draft
            }
        }
        draftSaveTasks[draft.id]?.cancel()
        draftSaveTasks[draft.id] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            await self?.save(draftID: draft.id)
        }
    }

    private func save(draftID: String) async {
        draftSaveTasks[draftID] = nil
        guard let chatID, let client = mail.agentAPI, let draft = draft(draftID), draft.isEditable else { return }
        do {
            _ = try await client.updateAgentDraft(chatID: chatID, draftID: draftID, patch: AgentDraftPatch(
                from: draft.from, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func flushDraftEdits() async {
        let pending = Array(draftSaveTasks.keys)
        for id in pending {
            draftSaveTasks[id]?.cancel()
            await save(draftID: id)
        }
    }

    func discard(_ draft: AgentDraft) async {
        guard let chatID, let client = mail.agentAPI else { return }
        draftSaveTasks[draft.id]?.cancel()
        setStatus(.discarded, of: draft.id)
        do {
            _ = try await client.updateAgentDraft(chatID: chatID, draftID: draft.id, patch: AgentDraftPatch(status: .discarded))
        } catch {
            setStatus(.draft, of: draft.id)
            errorMessage = error.localizedDescription
        }
    }

    func restore(_ draft: AgentDraft) async {
        guard let chatID, let client = mail.agentAPI else { return }
        setStatus(.draft, of: draft.id)
        _ = try? await client.updateAgentDraft(chatID: chatID, draftID: draft.id, patch: AgentDraftPatch(status: .draft))
    }

    /// Sends a proposed email exactly as it stands. Call only after the owner confirmed it.
    func sendDraft(_ draft: AgentDraft) async throws {
        guard let chatID, let client = mail.agentAPI else { throw MailAPIError.invalidConfiguration }
        draftSaveTasks[draft.id]?.cancel()
        draftSaveTasks[draft.id] = nil
        sendingDraftIDs.insert(draft.id)
        defer { sendingDraftIDs.remove(draft.id) }
        let response = try await client.sendAgentDraft(chatID: chatID, draftID: draft.id, request: AgentDraftSendRequest(
            idempotencyKey: UUID(), from: draft.from, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body))
        guard response.sent == true || response.alreadySent == true else {
            throw MailAPIError.server(502, response.error ?? "The email was not sent.")
        }
        setStatus(.sent, of: draft.id)
        await mail.loadContacts(identity: draft.from)
    }
}
