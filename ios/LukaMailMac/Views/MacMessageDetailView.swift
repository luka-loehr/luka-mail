import AppKit
import QuickLook
import SwiftUI

struct MacMessageDetailView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.composeMessage) private var compose

    let messageID: String

    @State private var displayedMessageID: String
    @State private var inlineImages: [String: String] = [:]
    @State private var previewURL: URL?
    @State private var downloading: String?
    @State private var localError: String?

    private static let padding: CGFloat = 24

    init(messageID: String) {
        self.messageID = messageID
        _displayedMessageID = State(initialValue: messageID)
    }

    private var message: MailDetail? {
        guard let detail = store.detail, detail.id == displayedMessageID else { return nil }
        return detail
    }

    var body: some View {
        Group {
            if let message {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(message)
                            .padding(.horizontal, Self.padding)
                        Divider()
                            .padding(.horizontal, Self.padding)
                        MessageBodyView(message: message, inlineImages: inlineImages, horizontalPadding: Self.padding)
                        if message.thread.count > 1 {
                            conversation(message)
                                .padding(.horizontal, Self.padding)
                        }
                    }
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .task(id: message.id) { inlineImages = await store.inlineImageData(for: message.attachments) }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .task(id: displayedMessageID) {
            inlineImages = [:]
            await store.loadDetail(id: displayedMessageID)
        }
        .onChange(of: messageID) { _, newValue in displayedMessageID = newValue }
        .quickLookPreview($previewURL)
        .alert("Couldn’t Open File", isPresented: Binding(
            get: { localError != nil },
            set: { if !$0 { localError = nil } }
        )) {
            Button("OK") { localError = nil }
        } message: {
            Text(localError ?? "")
        }
    }

    private func header(_ message: MailDetail) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                MacSenderAvatar(name: message.sender.label, address: message.sender.address,
                                avatarColor: message.sender.avatarColor,
                                messageID: message.isOutbound ? nil : message.id, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(message.sender.label).font(.headline)
                        Text(message.sender.address).foregroundStyle(.secondary)
                        Spacer(minLength: 16)
                        Text(message.date.formatted(date: .abbreviated, time: .shortened))
                            .foregroundStyle(.secondary)
                    }
                    if !message.recipients.isEmpty {
                        Text("To: \(message.recipients.map(\.label).joined(separator: ", "))")
                            .foregroundStyle(.secondary)
                    }
                    if !message.cc.isEmpty {
                        Text("Cc: \(message.cc.map(\.label).joined(separator: ", "))")
                            .foregroundStyle(.secondary)
                    }
                }
                .textSelection(.enabled)
                Menu("More", systemImage: "ellipsis") {
                    Button(message.unread ? "Mark as Read" : "Mark as Unread") {
                        Task { await store.update(id: message.id, update: MessageUpdate(unread: !message.unread)) }
                    }
                    ShareLink(item: message.shareText) { Text("Share…") }
                    Divider()
                    Button("Show Original Message") { Task { await previewOriginal(message) } }
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .labelStyle(.iconOnly)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("More Actions")
            }

            Text(message.displaySubject)
                .font(.title2.bold())
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)

            let files = message.attachments.filter { $0.disposition != "inline" || $0.contentId == nil }
            if !files.isEmpty { attachments(files) }
            if message.attachmentsTruncated == true {
                Label("Showing \(message.storedAttachmentCount ?? message.attachments.count) of \(message.attachmentCount ?? message.attachments.count) attachments. Show the original message for the complete content.",
                      systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func attachments(_ attachments: [MailAttachment]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    Button { Task { await preview(attachment) } } label: {
                        HStack(spacing: 8) {
                            Group {
                                if downloading == attachment.id {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: attachment.symbolName).foregroundStyle(.tint)
                                }
                            }
                            .frame(width: 18)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(attachment.filename).lineLimit(1)
                                Text(attachment.formattedSize).font(.caption).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: 200, alignment: .leading)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.fill.tertiary, in: .rect(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(downloading != nil)
                    .help("Quick Look \(attachment.filename)")
                    .accessibilityLabel("\(attachment.filename), \(attachment.formattedSize)")
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func conversation(_ message: MailDetail) -> some View {
        DisclosureGroup("Conversation (\(message.thread.count))") {
            VStack(spacing: 0) {
                ForEach(message.thread.filter { $0.id != message.id }.suffix(10)) { related in
                    Button {
                        displayedMessageID = related.id
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: related.isOutbound ? "paperplane" : "envelope")
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                            Text(related.isOutbound ? "To: \(related.correspondent.label)" : related.sender.label)
                                .fontWeight(.medium)
                                .lineLimit(1)
                            Text(related.preview).foregroundStyle(.secondary).lineLimit(1)
                            Spacer(minLength: 8)
                            Text(MailDateFormatting.listLabel(for: related.date))
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 5)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        }
    }

    private func preview(_ attachment: MailAttachment) async {
        downloading = attachment.id
        defer { downloading = nil }
        do {
            let data = try await store.attachmentData(id: attachment.id)
            let url = attachment.temporaryFileURL()
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            previewURL = url
        } catch {
            localError = error.localizedDescription
        }
    }

    private func previewOriginal(_ message: MailDetail) async {
        downloading = "raw-message"
        defer { downloading = nil }
        do {
            let data = try await store.rawMessageData(id: message.id)
            let directory = FileManager.default.temporaryDirectory.appending(path: "LukaMail", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appending(path: "\(message.id).eml")
            try data.write(to: url, options: [.atomic])
            previewURL = url
        } catch {
            localError = error.localizedDescription
        }
    }
}
