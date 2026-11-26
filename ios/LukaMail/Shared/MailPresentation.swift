import SwiftUI

enum MailDesign {
    /// Minimum hit target for interactive rows and chips (HIG: 44 x 44 pt).
    static let minimumHitTarget: CGFloat = 44
    static let chipCornerRadius: CGFloat = 12
}

enum AppBuildInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
    }

    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
    }

    static var gitCommit: String {
        Bundle.main.object(forInfoDictionaryKey: "GitCommitSHA") as? String ?? "Unknown"
    }
}

/// Opens the compose UI for a draft: a sheet on iOS, a window on macOS.
struct ComposeMessageAction {
    let handler: (Draft) -> Void
    func callAsFunction(_ draft: Draft) { handler(draft) }
}

extension EnvironmentValues {
    @Entry var composeMessage = ComposeMessageAction { _ in }
}

extension Mailbox {
    /// Outline symbol; tab bars and sidebars choose the fill variant themselves.
    var symbolName: String {
        switch self {
        case .inbox: "tray"
        case .starred: "star"
        case .sent: "paperplane"
        case .drafts: "doc"
        case .archive: "archivebox"
        case .trash: "trash"
        }
    }

    var emptyTitle: String {
        switch self {
        case .inbox: "No Mail"
        case .starred: "No Starred Mail"
        case .sent: "No Sent Mail"
        case .drafts: "No Drafts"
        case .archive: "No Archived Mail"
        case .trash: "Trash Is Empty"
        }
    }

    var emptyDescription: String {
        switch self {
        case .inbox: "New messages you receive appear here."
        case .starred: "Star a message to keep it here for quick access."
        case .sent: "Messages you send appear here."
        case .drafts: "Messages you start but don’t send are saved here."
        case .archive: "Archive messages to clear your inbox without deleting them."
        case .trash: "Messages you delete appear here."
        }
    }
}

extension MailMessage {
    var isOutbound: Bool { direction == "outbound" }

    /// The other party: the first recipient for sent mail, otherwise the sender.
    var correspondent: MailAddress { isOutbound ? recipients.first ?? sender : sender }

    var accessibilitySummary: String {
        var parts: [String] = []
        if unread { parts.append("Unread") }
        if starred { parts.append("Starred") }
        parts.append(isOutbound ? "To \(correspondent.label)" : "From \(correspondent.label)")
        parts.append(displaySubject)
        parts.append(MailDateFormatting.listLabel(for: date))
        if hasAttachments { parts.append("Has attachments") }
        parts.append(preview)
        return parts.joined(separator: ", ")
    }
}

extension MailDetail {
    var isOutbound: Bool { direction == "outbound" }

    var bodySource: MailBodySource {
        if let html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .html(html) }
        return .plainText(text ?? preview)
    }

    var shareText: String {
        "\(displaySubject)\n\nFrom: \(sender.label) <\(sender.address)>\n\n\(text ?? preview)"
    }
}

enum MailDateFormatting {
    /// Mail-style list date: time today, "Yesterday", weekday within a week, otherwise a short date.
    static func listLabel(for date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) {
            return String(localized: "Yesterday")
        }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day,
           days > 0, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(date: .numeric, time: .omitted)
    }
}

extension Draft {
    static func reply(to message: MailDetail, from identity: String) -> Draft {
        let recipient = message.isOutbound ? message.recipients.first?.address ?? "" : message.sender.address
        return Draft(id: nil, from: identity, replyToMessageId: message.id, to: [recipient], cc: [], bcc: [],
                     subject: prefixed("Re:", message.subject), text: "", updatedAt: nil)
    }

    static func replyAll(to message: MailDetail, from identity: String, ownAddresses: Set<String>) -> Draft {
        let own = Set(ownAddresses.map { $0.lowercased() } + [identity.lowercased()])
        let primary = message.isOutbound ? message.recipients.map(\.address) : [message.sender.address]
        let others = (message.isOutbound ? [] : message.recipients.map(\.address)) + message.cc.map(\.address)
        var seen = Set<String>()
        func unique(_ list: [String]) -> [String] {
            list.filter { address in
                let key = address.lowercased()
                guard !own.contains(key), !seen.contains(key) else { return false }
                seen.insert(key)
                return true
            }
        }
        let to = unique(primary)
        let cc = unique(others)
        return Draft(id: nil, from: identity, replyToMessageId: message.id, to: to.isEmpty ? cc : to,
                     cc: to.isEmpty ? [] : cc, bcc: [], subject: prefixed("Re:", message.subject), text: "", updatedAt: nil)
    }

    static func forward(_ message: MailDetail, from identity: String) -> Draft {
        let date = message.date.formatted(date: .abbreviated, time: .shortened)
        let quoted = "\n\n---------- Forwarded message ----------\nFrom: \(message.sender.label) <\(message.sender.address)>\nDate: \(date)\nSubject: \(message.subject)\n\n\(message.text ?? message.preview)"
        return Draft(id: nil, from: identity, replyToMessageId: nil, to: [], cc: [], bcc: [],
                     subject: prefixed("Fwd:", message.subject), text: quoted, updatedAt: nil)
    }

    static func compose(_ link: MailtoLink, from identity: String) -> Draft {
        Draft(id: nil, from: identity, replyToMessageId: nil, to: link.to, cc: link.cc, bcc: link.bcc,
              subject: link.subject, text: link.body, updatedAt: nil)
    }

    var hasContent: Bool {
        !to.isEmpty || !cc.isEmpty || !bcc.isEmpty
            || !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func prefixed(_ prefix: String, _ subject: String) -> String {
        subject.lowercased().hasPrefix(prefix.lowercased()) ? subject : "\(prefix) \(subject)"
    }
}

extension MailAttachment {
    var symbolName: String {
        if contentType.hasPrefix("image/") { return "photo" }
        if contentType == "application/pdf" { return "doc.richtext" }
        if contentType.hasPrefix("audio/") { return "waveform" }
        if contentType.hasPrefix("video/") { return "film" }
        if contentType.contains("zip") || contentType.contains("compressed") { return "doc.zipper" }
        return "doc"
    }

    var formattedSize: String {
        Int64(size).formatted(.byteCount(style: .file))
    }

    /// A temporary file URL for Quick Look; the filename is sanitized to a single path component.
    func temporaryFileURL() -> URL {
        let directory = FileManager.default.temporaryDirectory.appending(path: "LukaMail", directoryHint: .isDirectory)
        let sanitized = URL(fileURLWithPath: filename.replacingOccurrences(of: "\\", with: "_")).lastPathComponent
        return directory.appending(path: "\(id)-\(sanitized.isEmpty ? "Attachment" : sanitized)")
    }
}

extension OutboundAttachment {
    /// Raw bytes per message; base64 encoding keeps the request under the server's 4.5 MB limit.
    static let sendingBudget = 3_200_000
}

/// Address parsing shared by both compose views.
enum RecipientParser {
    static func candidates(_ value: String) -> [String] {
        value
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" })
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func addresses(_ value: String) -> [String] {
        candidates(value).compactMap { candidate in
            let address: String
            if let opening = candidate.lastIndex(of: "<"), let closing = candidate.lastIndex(of: ">"), opening < closing {
                address = String(candidate[candidate.index(after: opening)..<closing])
            } else {
                address = candidate
            }
            let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let pieces = trimmed.split(separator: "@", omittingEmptySubsequences: false)
            guard pieces.count == 2, !pieces[0].isEmpty, pieces[1].contains("."),
                  !trimmed.contains(where: { $0.isWhitespace }) else { return nil }
            return trimmed
        }
    }

    static func activeFragment(_ value: String) -> String {
        let start = value.lastIndex(where: { $0 == "," || $0 == ";" || $0 == "\n" })
            .map { value.index(after: $0) } ?? value.startIndex
        return String(value[start...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func replacingActiveFragment(in value: String, with address: String) -> String {
        guard let separator = value.lastIndex(where: { $0 == "," || $0 == ";" || $0 == "\n" }) else {
            return "\(address), "
        }
        return "\(value[...separator]) \(address), "
    }

    /// Validates all three fields; returns an error message, or nil when every address is valid.
    static func validationError(to: String, cc: String, bcc: String) -> (title: String, message: String)? {
        for (label, value) in [("To", to), ("Cc", cc), ("Bcc", bcc)]
            where addresses(value).count != candidates(value).count {
            return ("Check Recipients", "One or more addresses in \(label) aren’t valid. Separate addresses with commas.")
        }
        if Set(addresses(to) + addresses(cc) + addresses(bcc)).count > 20 {
            return ("Too Many Recipients", "A message can have at most 20 unique recipients.")
        }
        return nil
    }
}

extension Color {
    static func avatar(hex: String?, fallbackFor value: String) -> Color {
        if let hex, let color = Color(avatarHex: hex) { return color }

        let colors: [Color] = [.blue, .cyan, .indigo, .teal, .pink, .purple]
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.lowercased().utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return colors[Int(hash % UInt64(colors.count))]
    }

    init?(avatarHex value: String) {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard value.count == 6 || value.count == 8,
              let raw = UInt64(value, radix: 16) else { return nil }

        let hasAlpha = value.count == 8
        let red = Double((raw >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let green = Double((raw >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let blue = Double((raw >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let alpha = hasAlpha ? Double(raw & 0xff) / 255 : 1
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
}

/// Initial-letter avatar used when no sender logo is available, and for contacts.
struct MonogramAvatar: View {
    let name: String
    let address: String
    let avatarColor: String?
    let size: CGFloat

    var body: some View {
        Circle()
            .fill(Color.avatar(hex: avatarColor, fallbackFor: address).gradient)
            .overlay {
                Text(name.prefix(1).uppercased())
                    .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Status line for the connection, always symbol plus text (never color alone).
struct ConnectionStatusLabel: View {
    let status: MailConnectionStatus

    var body: some View {
        if let message = status.message {
            Label(message, systemImage: status.systemImage)
        }
    }
}
