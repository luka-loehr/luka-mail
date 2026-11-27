import QuickLook
import SwiftUI

struct MessageDetailView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.composeMessage) private var compose
    let messageID: String
    @State private var inlineImages: [String: String] = [:]
    @State private var previewURL: URL?
    @State private var downloading: String?
    @State private var localError: String?
    @State private var showsDetails = DemoLaunch.flag("DemoDetails")

    private static let padding: CGFloat = 16

    private var message: MailDetail? {
        guard let detail = store.detail, detail.id == messageID else { return nil }
        return detail
    }

    var body: some View {
        Group {
            if let message {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(message)
                            .padding(.horizontal, Self.padding)
                        MessageBodyView(message: message, inlineImages: inlineImages, horizontalPadding: Self.padding)
                        if message.thread.count > 1 {
                            conversation(message)
                                .padding(.horizontal, Self.padding)
                        }
                    }
                    .padding(.vertical, 12)
                }
                .task(id: message.id) { inlineImages = await store.inlineImageData(for: message.attachments) }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .toolbarVisibility(.hidden, for: .tabBar)
        .task(id: messageID) {
            guard store.detail?.id != messageID else { return }
            await store.loadDetail(id: messageID)
        }
        .quickLookPreview($previewURL)
        .alert("Couldn’t Open File", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
            Button("OK") { localError = nil }
        } message: {
            Text(localError ?? "")
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if let message {
            ToolbarItem(placement: .topBarTrailing) {
                Button(message.starred ? "Remove Star" : "Star", systemImage: message.starred ? "star.fill" : "star") {
                    Task { await store.update(id: message.id, update: MessageUpdate(starred: !message.starred)) }
                }
                .contentTransition(.symbolEffect(.replace))
                .sensoryFeedback(.selection, trigger: message.starred)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu("More", systemImage: "ellipsis") {
                    Button("Mark as Unread", systemImage: "envelope.badge") {
                        Task { await store.update(id: message.id, update: MessageUpdate(unread: true)) }
                    }
                    ShareLink(item: message.shareText, subject: Text(message.displaySubject)) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    Divider()
                    Button("Show Original Message", systemImage: "doc.text.magnifyingglass") {
                        Task { await previewOriginal(message) }
                    }
                }
            }

            ToolbarItemGroup(placement: .bottomBar) {
                if message.folder != "trash" {
                    Button("Trash", systemImage: "trash") { Task { await move(message, to: "trash") } }
                }
                if message.folder == "archive" || message.folder == "trash" {
                    Button("Move to Inbox", systemImage: "tray.and.arrow.down") { Task { await move(message, to: "inbox") } }
                } else {
                    Button("Archive", systemImage: "archivebox") { Task { await move(message, to: "archive") } }
                }
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Menu {
                    Button("Reply", systemImage: "arrowshape.turn.up.left") { reply(message) }
                    Button("Reply All", systemImage: "arrowshape.turn.up.left.2") { replyAll(message) }
                    Button("Forward", systemImage: "arrowshape.turn.up.right") { forward(message) }
                } label: {
                    Label("Reply", systemImage: "arrowshape.turn.up.left")
                } primaryAction: {
                    reply(message)
                }
                .menuOrder(.fixed)
            }
            ToolbarSpacer(.fixed, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button("New Message", systemImage: "square.and.pencil") { compose(.compose(from: store.selectedInbox)) }
            }
        }
    }

    // MARK: Header

    private func header(_ message: MailDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                SenderAvatar(name: message.sender.label, address: message.sender.address,
                             avatarColor: message.sender.avatarColor,
                             messageID: message.isOutbound ? nil : message.id, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) {
                            senderName(message)
                            Spacer(minLength: 8)
                            dateText(message)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            senderName(message)
                            dateText(message)
                        }
                    }
                    Button {
                        withAnimation(.snappy) { showsDetails.toggle() }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(recipientSummary(message)).lineLimit(showsDetails ? nil : 1)
                            Image(systemName: "chevron.down")
                                .font(.caption.weight(.semibold))
                                .rotationEffect(.degrees(showsDetails ? 180 : 0))
                        }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(showsDetails ? "Hide Details" : "Show Details")
                    .accessibilityValue(recipientSummary(message))
                }
            }
            if showsDetails { addressDetails(message) }

            Text(message.displaySubject)
                .font(.title2.bold())
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)

            let files = message.attachments.filter { $0.disposition != "inline" || $0.contentId == nil }
            if !files.isEmpty { attachments(files) }
            if message.attachmentsTruncated == true {
                Label("Showing \(message.storedAttachmentCount ?? message.attachments.count) of \(message.attachmentCount ?? message.attachments.count) attachments. Show the original message for the complete content.",
                      systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func senderName(_ message: MailDetail) -> some View {
        Text(message.sender.label)
            .font(.headline)
            .textSelection(.enabled)
    }

    private func dateText(_ message: MailDetail) -> some View {
        Text(MailDateFormatting.listLabel(for: message.date))
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    private func recipientSummary(_ message: MailDetail) -> String {
        let names = (message.recipients + message.cc).map(\.label)
        return names.isEmpty ? "No Recipients" : "To: \(names.joined(separator: ", "))"
    }

    private func addressDetails(_ message: MailDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("From", value: "\(message.sender.label) <\(message.sender.address)>")
            if !message.recipients.isEmpty {
                LabeledContent("To", value: message.recipients.map(\.address).joined(separator: ", "))
            }
            if !message.cc.isEmpty {
                LabeledContent("Cc", value: message.cc.map(\.address).joined(separator: ", "))
            }
            LabeledContent("Date", value: message.date.formatted(date: .complete, time: .shortened))
        }
        .labeledContentStyle(AddressDetailStyle())
        .font(.subheadline)
        .textSelection(.enabled)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.tertiary, in: .rect(cornerRadius: MailDesign.chipCornerRadius, style: .continuous))
    }

    private func attachments(_ attachments: [MailAttachment]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    Button { Task { await preview(attachment) } } label: {
                        HStack(spacing: 8) {
                            Group {
                                if downloading == attachment.id {
                                    ProgressView()
                                } else {
                                    Image(systemName: attachment.symbolName)
                                        .foregroundStyle(.tint)
                                }
                            }
                            .frame(width: 24)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(attachment.filename).font(.subheadline).lineLimit(1)
                                Text(attachment.formattedSize).font(.caption).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: 180, alignment: .leading)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: MailDesign.minimumHitTarget + 4)
                        .background(.fill.tertiary, in: .rect(cornerRadius: MailDesign.chipCornerRadius, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(downloading != nil)
                    .accessibilityLabel("\(attachment.filename), \(attachment.formattedSize)")
                    .accessibilityHint("Opens a preview")
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func conversation(_ message: MailDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider().padding(.bottom, 8)
            Text("Conversation")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            ForEach(message.thread.filter { $0.id != message.id }.suffix(10)) { related in
                NavigationLink(value: MailRoute.message(related.id)) {
                    HStack(spacing: 12) {
                        Image(systemName: related.isOutbound ? "paperplane" : "envelope")
                            .foregroundStyle(.secondary)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(related.isOutbound ? "To: \(related.correspondent.label)" : related.sender.label)
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                            Text(related.preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text(MailDateFormatting.listLabel(for: related.date))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.forward")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(minHeight: MailDesign.minimumHitTarget)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            if message.thread.count > 11 || message.threadTruncated {
                Text("Older messages in this conversation aren’t shown.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Actions

    private func reply(_ message: MailDetail) {
        compose(.reply(to: message, from: store.selectedInbox))
    }

    private func replyAll(_ message: MailDetail) {
        compose(.replyAll(to: message, from: store.selectedInbox, ownAddresses: Set(store.identities.map(\.address))))
    }

    private func forward(_ message: MailDetail) {
        compose(.forward(message, from: store.selectedInbox))
    }

    private func move(_ message: MailDetail, to folder: String) async {
        if await store.update(id: message.id, update: MessageUpdate(folder: folder), removeFromCurrentList: true) {
            dismiss()
        }
    }

    private func preview(_ attachment: MailAttachment) async {
        downloading = attachment.id
        defer { downloading = nil }
        do {
            let data = try await store.attachmentData(id: attachment.id)
            let url = attachment.temporaryFileURL()
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
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
            let url = directory.appending(path: "\(MailSafeFilename.token(message.id, fallback: "message")).eml")
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            previewURL = url
        } catch {
            localError = error.localizedDescription
        }
    }
}

/// Compact "Label  value" rows for the expanded address details.
private struct AddressDetailStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            configuration.label
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, alignment: .leading)
            configuration.content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
