import Foundation

/// A saved conversation with the mail agent, as listed in the chat history.
struct AgentChatSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    let identity: String?
    var preview: String
    let createdAt: String
    var updatedAt: String

    var updatedDate: Date? { MailDate.parse(updatedAt) }
}

struct AgentChatList: Codable, Sendable { let chats: [AgentChatSummary] }

struct AgentChatDetail: Codable, Sendable {
    let chat: AgentChatSummary
    let messages: [AgentChatMessage]
}

/// One step the agent took, worded for people ("Searched mail for “Förderverein”").
struct AgentActivity: Codable, Hashable, Sendable {
    let tool: String
    let label: String
}

/// A message the agent looked at while answering.
struct AgentSource: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let subject: String
    let from: String
    let receivedAt: String
    let identity: String?
    var read: Bool

    var senderName: String {
        if let open = from.firstIndex(of: "<"), open > from.startIndex {
            return from[..<open].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }
        return from
    }

    var senderAddress: String {
        guard let open = from.firstIndex(of: "<"), let close = from.lastIndex(of: ">"), open < close else { return from }
        return String(from[from.index(after: open)..<close])
    }
}

/// An email the agent proposed. The agent cannot send: the owner edits it here and sends it himself.
struct AgentDraft: Codable, Hashable, Identifiable, Sendable {
    enum Status: String, Codable, Sendable {
        case draft, sent, superseded, discarded
    }

    let id: String
    var from: String
    var to: [String]
    var cc: [String]
    var subject: String
    var body: String
    let replyToMessageId: String?
    var status: Status
    var revisesDraftId: String?

    var isEditable: Bool { status == .draft }
}

struct AgentChatMessage: Codable, Identifiable, Hashable, Sendable {
    enum Role: String, Codable, Sendable { case user, assistant }

    var id: String
    let role: Role
    var content: String
    var createdAt: String?
    var error: String?
    var activity: [AgentActivity]
    var sources: [AgentSource]
    var drafts: [AgentDraft]

    init(id: String, role: Role, content: String, createdAt: String? = nil, error: String? = nil,
         activity: [AgentActivity] = [], sources: [AgentSource] = [], drafts: [AgentDraft] = []) {
        self.id = id
        self.role = role
        self.content = content
        self.createdAt = createdAt
        self.error = error
        self.activity = activity
        self.sources = sources
        self.drafts = drafts
    }
}

/// One line of the NDJSON stream a chat turn answers with.
enum AgentStreamEvent: Sendable {
    case chat(chatID: String, userMessageID: String, assistantMessageID: String)
    case reasoning(String)
    case text(String)
    case toolCall(AgentActivity)
    case draft(AgentDraft)
    case sources([AgentSource])
    case title(String)
    case finish
    case error(String)
    case other

    private struct Line: Decodable {
        let type: String
        let chatId: String?
        let userMessageId: String?
        let assistantMessageId: String?
        let text: String?
        let tool: String?
        let label: String?
        let draft: AgentDraft?
        let messages: [AgentSource]?
        let title: String?
        let message: String?
    }

    static func decode(_ line: String) -> AgentStreamEvent? {
        guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(Line.self, from: data) else { return nil }
        switch event.type {
        case "chat":
            guard let chat = event.chatId, let user = event.userMessageId, let assistant = event.assistantMessageId else { return .other }
            return .chat(chatID: chat, userMessageID: user, assistantMessageID: assistant)
        case "reasoning": return .reasoning(event.text ?? "")
        case "text": return .text(event.text ?? "")
        case "tool-call": return .toolCall(AgentActivity(tool: event.tool ?? "", label: event.label ?? event.tool ?? "Working"))
        case "draft": return event.draft.map(AgentStreamEvent.draft) ?? .other
        case "sources": return .sources(event.messages ?? [])
        case "title": return event.title.map(AgentStreamEvent.title) ?? .other
        case "finish": return .finish
        case "error": return .error(event.message ?? "The agent stopped unexpectedly.")
        default: return .other
        }
    }
}

struct AgentTurnRequest: Encodable, Sendable {
    let chatId: String?
    let text: String
}

struct AgentDraftPatch: Encodable, Sendable {
    var from: String?
    var to: [String]?
    var cc: [String]?
    var subject: String?
    var body: String?
    var status: AgentDraft.Status?
}

struct AgentDraftSendRequest: Encodable, Sendable {
    let idempotencyKey: UUID
    let from: String
    let to: [String]
    let cc: [String]
    let subject: String
    let body: String
}

struct AgentDraftSendResponse: Decodable, Sendable {
    let sent: Bool?
    let alreadySent: Bool?
    let error: String?
    let draft: AgentDraft?
}

struct AgentDraftResponse: Decodable, Sendable { let draft: AgentDraft }
struct AgentChatDeleted: Decodable, Sendable { let deleted: Bool }
