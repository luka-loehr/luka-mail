import Foundation

enum Mailbox: String, CaseIterable, Codable, Identifiable, Sendable {
    case inbox, starred, sent, drafts, archive, trash

    var id: String { rawValue }
    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .starred: "Starred"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .archive: "Archive"
        case .trash: "Trash"
        }
    }
    var apiFolder: String { self == .drafts ? "inbox" : rawValue }
}

struct MailboxState: Codable, Sendable {
    let revision: String
    let changed: Bool
}

struct MailboxSnapshot: Codable, Sendable {
    let revision: String
    let summary: MailSummary
    let messages: [MailMessage]
    let nextCursor: String?
    let drafts: [Draft]
    let addresses: [MailIdentity]?
}

struct MailboxDelta: Codable, Sendable {
    let identity: String?
    let fromRevision: String
    let revision: String
    let changes: [MailboxChange]
    let summary: MailSummary?
    let hasMore: Bool
    let nextCursor: String?
    let resetRequired: Bool
    let reason: String?
}

struct MailboxChange: Codable, Sendable {
    let revision: String
    let kind: String
    let id: String
    let operation: String
    let threadId: String?
    let previousFolder: String?
    let message: MailMessage?
    let draft: Draft?
}

struct MailNotificationTarget: Hashable, Sendable {
    let messageID: String
    let identity: String
}

struct PushDeviceRequest: Codable, Sendable {
    let deviceToken: String
    let environment: String
    let identities: [String]
}

struct PushDeviceResponse: Codable, Sendable {
    let registered: Bool
    let identities: [String]
}

struct PushDeviceRemovalRequest: Encodable, Sendable {
    let deviceToken: String
    let environment: String
}

struct PushDeviceRemovalResponse: Codable, Sendable {
    let removed: Bool
}

struct MailAddress: Codable, Hashable, Sendable {
    var name: String?
    var address: String
    var avatarColor: String?

    init(name: String? = nil, address: String, avatarColor: String? = nil) {
        self.name = name
        self.address = address
        self.avatarColor = avatarColor
    }

    init(from decoder: Decoder) throws {
        if let value = try? decoder.singleValueContainer().decode(String.self) {
            name = nil
            address = value
            avatarColor = nil
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        address = try container.decode(String.self, forKey: .address)
        avatarColor = try container.decodeIfPresent(String.self, forKey: .avatarColor)
    }

    var label: String {
        guard let name, !name.isEmpty else { return address }
        return name
    }
}

struct MailMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let threadId: String
    let direction: String
    var folder: String
    let subject: String
    let sender: MailAddress
    let recipients: [MailAddress]
    let preview: String
    let receivedAt: String
    var unread: Bool
    var starred: Bool
    let hasAttachments: Bool
    let attachmentCount: Int?
    let storedAttachmentCount: Int?
    let attachmentsTruncated: Bool?
    let size: Int
    var spam: Bool? = nil

    var displaySubject: String { subject.isEmpty ? "No Subject" : subject }
    var date: Date { MailDate.parse(receivedAt) ?? .distantPast }
}

struct MailAttachment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let filename: String
    let contentType: String
    let contentId: String?
    let size: Int
    let disposition: String
}

struct MailDetail: Codable, Identifiable, Sendable {
    let id: String
    let threadId: String
    let direction: String
    var folder: String
    let subject: String
    let sender: MailAddress
    let recipients: [MailAddress]
    let preview: String
    let receivedAt: String
    var unread: Bool
    var starred: Bool
    let hasAttachments: Bool
    let attachmentCount: Int?
    let storedAttachmentCount: Int?
    let attachmentsTruncated: Bool?
    let size: Int
    let messageId: String?
    let inReplyTo: String?
    let cc: [MailAddress]
    let text: String?
    let html: String?
    let attachments: [MailAttachment]
    let thread: [MailMessage]
    let threadTruncated: Bool

    var displaySubject: String { subject.isEmpty ? "No Subject" : subject }
    var date: Date { MailDate.parse(receivedAt) ?? .distantPast }
}

struct MessagePage: Codable, Sendable {
    let messages: [MailMessage]
    let nextCursor: String?
}

struct LogoBackfillPage: Codable, Sendable {
    let processed: Int
    let nextCursor: String?
}

struct MailSummary: Codable, Sendable {
    let unread: Int
    let inbox: Int
    let sent: Int
    let starred: Int
    let archive: Int
    let trash: Int
    let drafts: Int
}

struct MailIdentity: Codable, Identifiable, Hashable, Sendable {
    let address: String
    let displayName: String
    let avatarColor: String?

    init(address: String, displayName: String, avatarColor: String? = nil) {
        self.address = address
        self.displayName = displayName
        self.avatarColor = avatarColor
    }

    var id: String { address }
}

struct IdentityResponse: Codable, Sendable {
    let addresses: [MailIdentity]
}

struct MailContact: Codable, Identifiable, Hashable, Sendable {
    let identityAddress: String
    let address: String
    let displayName: String?
    let avatarColor: String
    let source: String
    let sendCount: Int
    let firstSentAt: String?
    let lastSentAt: String?
    let createdAt: String
    let updatedAt: String

    var id: String { "\(identityAddress):\(address)" }
    var label: String {
        guard let displayName, !displayName.isEmpty else { return address }
        return displayName
    }

    func matches(_ query: String) -> Bool {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.isEmpty || address.lowercased().contains(normalized)
            || displayName?.lowercased().contains(normalized) == true
    }
}

struct ContactResponse: Codable, Sendable { let contacts: [MailContact] }
struct ContactMutationResponse: Codable, Sendable {
    let contact: MailContact
}
struct ContactMutationRequest: Encodable, Sendable {
    let identity: String
    let address: String?
    let displayName: String
}
struct DeletedContact: Codable, Sendable { let deleted: Bool }

struct Draft: Codable, Identifiable, Hashable, Sendable {
    var id: String?
    var from: String
    var replyToMessageId: String?
    var to: [String]
    var cc: [String]
    var bcc: [String]
    var subject: String
    var text: String
    var updatedAt: String?
    var localAttachments: [OutboundAttachment]? = nil

    init(id: String?, from: String, replyToMessageId: String?, to: [String], cc: [String], bcc: [String],
         subject: String, text: String, updatedAt: String?, localAttachments: [OutboundAttachment]? = nil) {
        self.id = id
        self.from = from
        self.replyToMessageId = replyToMessageId
        self.to = to
        self.cc = cc
        self.bcc = bcc
        self.subject = subject
        self.text = text
        self.updatedAt = updatedAt
        self.localAttachments = localAttachments
    }

    private enum CodingKeys: String, CodingKey {
        case id, from, replyToMessageId, to, cc, bcc, subject, text, updatedAt
    }

    static func compose(from: String) -> Draft {
        Draft(id: nil, from: from, replyToMessageId: nil, to: [], cc: [], bcc: [], subject: "", text: "", updatedAt: nil)
    }
}

struct DraftResponse: Codable, Sendable { let drafts: [Draft] }
struct SavedDraft: Codable, Sendable { let saved: Bool; let id: String }
struct SentMessage: Codable, Sendable {
    let sent: Bool
    let id: String
    let messageId: String
    let status: String?
}
struct UpdatedMessage: Codable, Sendable { let updated: Bool }
struct DeletedDraft: Codable, Sendable { let deleted: Bool }

struct OutboundAttachment: Encodable, Identifiable, Hashable, Sendable {
    let id: UUID
    let filename: String
    let contentType: String
    let data: String
    let size: Int

    enum CodingKeys: String, CodingKey { case filename, contentType, data }

    init(id: UUID = UUID(), filename: String, contentType: String, data: String, size: Int) {
        self.id = id
        self.filename = filename
        self.contentType = contentType
        self.data = data
        self.size = size
    }

}

struct SendRequest: Encodable, Sendable {
    let idempotencyKey: UUID
    let from: String
    let to: [String]
    let cc: [String]
    let bcc: [String]
    let subject: String
    let text: String
    let html: String?
    let replyToMessageId: String?
    let attachments: [OutboundAttachment]
}

struct MessageUpdate: Codable, Sendable {
    var unread: Bool?
    var starred: Bool?
    var folder: String?
}

struct WhoAmI: Codable, Sendable {
    struct Principal: Codable, Sendable {
        let keyId: String
        let name: String
        let scopes: [String]
        let allowedIdentities: [String]?
    }
    let principal: Principal
    let owner: String
}

enum MailDate {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let standard = Date.ISO8601FormatStyle()

    static func parse(_ rawValue: String) -> Date? {
        if let date = try? fractional.parse(rawValue) { return date }
        return try? standard.parse(rawValue)
    }
}
