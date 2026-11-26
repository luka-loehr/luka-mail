import SwiftUI

struct MacMessageList: View {
    @Environment(MailStore.self) private var store
    @Environment(\.composeMessage) private var compose
    let mailbox: Mailbox
    @Binding var selection: String?
    let search: String

    @State private var selectedDraftID: String?

    private var term: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// The store holds one message list; only show it when it belongs to this mailbox and query.
    private var isCurrent: Bool { store.mailbox == mailbox && store.search == term }
    private var messages: [MailMessage] { isCurrent ? store.messages : [] }

    var body: some View {
        Group {
            if mailbox == .drafts {
                draftList
            } else {
                messageList
            }
        }
        .navigationTitle(mailbox.title)
        .navigationSubtitle(subtitle)
        .task(id: "\(mailbox.rawValue)|\(term)|\(store.selectedInbox)") {
            if mailbox == .drafts {
                await store.refresh(mailbox: .drafts, query: "")
                return
            }
            if !term.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await store.refresh(mailbox: mailbox, query: term)
        }
    }

    private var subtitle: String {
        if let message = store.connectionStatus.message { return message }
        if mailbox == .inbox, let unread = store.summary?.unread, unread > 0 { return "\(unread) unread" }
        return store.identities.count > 1 ? store.selectedInbox : ""
    }

    private var messageList: some View {
        List(selection: $selection) {
            ForEach(messages) { message in
                MacMessageRow(message: message)
                    .tag(message.id)
                    .swipeActions(edge: .leading) {
                        Button(message.unread ? "Mark as Read" : "Mark as Unread",
                               systemImage: message.unread ? "envelope.open" : "envelope.badge") {
                            update(message, MessageUpdate(unread: !message.unread))
                        }
                        .tint(.blue)
                    }
                    .swipeActions(edge: .trailing) {
                        if mailbox != .trash {
                            Button("Trash", systemImage: "trash", role: .destructive) { move(message, to: "trash") }
                        }
                        if mailbox != .archive && mailbox != .trash {
                            Button("Archive", systemImage: "archivebox") { move(message, to: "archive") }
                                .tint(.indigo)
                        }
                    }
                    .contextMenu { contextMenu(for: message) }
                    .onAppear {
                        guard message.id == messages.last?.id else { return }
                        Task { await store.loadMoreIfNeeded(after: message) }
                    }
            }
            if isCurrent, store.loadingMore {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
            }
        }
        .listStyle(.inset)
        .overlay {
            if messages.isEmpty {
                if !isCurrent || store.loading {
                    ProgressView()
                } else if !term.isEmpty {
                    ContentUnavailableView.search(text: term)
                } else if store.connectionStatus != .online, let message = store.connectionStatus.message {
                    ContentUnavailableView {
                        Label("Can’t Load Mail", systemImage: store.connectionStatus.systemImage)
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await store.refresh(mailbox: mailbox, query: "") } }
                    }
                } else {
                    ContentUnavailableView(mailbox.emptyTitle, systemImage: mailbox.symbolName,
                                           description: Text(mailbox.emptyDescription))
                }
            }
        }
    }

    @ViewBuilder
    private func contextMenu(for message: MailMessage) -> some View {
        Button(message.unread ? "Mark as Read" : "Mark as Unread") { update(message, MessageUpdate(unread: !message.unread)) }
        Button(message.starred ? "Remove Star" : "Star") { update(message, MessageUpdate(starred: !message.starred)) }
        Divider()
        if mailbox == .archive || mailbox == .trash {
            Button("Move to Inbox") { move(message, to: "inbox") }
        } else {
            Button("Archive") { move(message, to: "archive") }
        }
        if mailbox != .trash {
            Divider()
            Button("Move to Trash", role: .destructive) { move(message, to: "trash") }
        }
    }

    private var visibleDrafts: [Draft] {
        guard !term.isEmpty else { return store.drafts }
        return store.drafts.filter { draft in
            draft.subject.localizedCaseInsensitiveContains(term)
                || draft.text.localizedCaseInsensitiveContains(term)
                || draft.to.contains { $0.localizedCaseInsensitiveContains(term) }
        }
    }

    private var draftList: some View {
        List(selection: $selectedDraftID) {
            ForEach(visibleDrafts, id: \.id) { draft in
                MacDraftRow(draft: draft)
                    .tag(draft.id ?? "")
            }
        }
        .listStyle(.inset)
        .contextMenu(forSelectionType: String.self) { ids in
            if let draft = draft(for: ids) {
                Button("Open Draft") { compose(draft) }
                Divider()
                Button("Delete Draft", role: .destructive) { Task { await store.deleteDraft(draft) } }
            }
        } primaryAction: { ids in
            if let draft = draft(for: ids) { compose(draft) }
        }
        .overlay {
            if visibleDrafts.isEmpty {
                if store.loading {
                    ProgressView()
                } else if !term.isEmpty {
                    ContentUnavailableView.search(text: term)
                } else {
                    ContentUnavailableView(Mailbox.drafts.emptyTitle, systemImage: Mailbox.drafts.symbolName,
                                           description: Text(Mailbox.drafts.emptyDescription))
                }
            }
        }
    }

    private func draft(for ids: Set<String>) -> Draft? {
        guard let id = ids.first else { return nil }
        return store.drafts.first { $0.id == id }
    }

    private func update(_ message: MailMessage, _ update: MessageUpdate) {
        Task { await store.update(id: message.id, update: update) }
    }

    private func move(_ message: MailMessage, to folder: String) {
        Task {
            if await store.update(id: message.id, update: MessageUpdate(folder: folder), removeFromCurrentList: true),
               selection == message.id {
                selection = nil
            }
        }
    }
}

private struct MacMessageRow: View {
    let message: MailMessage

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(message.unread ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear))
                .frame(width: 8, height: 8)
                .padding(.top, 5)
            MacSenderAvatar(name: message.correspondent.label, address: message.correspondent.address,
                            avatarColor: message.correspondent.avatarColor,
                            messageID: message.isOutbound ? nil : message.id, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(message.isOutbound ? "To: \(message.correspondent.label)" : message.correspondent.label)
                        .font(.headline)
                        .fontWeight(message.unread ? .bold : .semibold)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(MailDateFormatting.listLabel(for: message.date))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                HStack(spacing: 4) {
                    Text(message.displaySubject)
                        .fontWeight(message.unread ? .semibold : .regular)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if message.hasAttachments { Image(systemName: "paperclip").foregroundStyle(.secondary) }
                    if message.starred { Image(systemName: "star.fill").foregroundStyle(.yellow) }
                }
                Text(message.preview)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(message.accessibilitySummary)
    }
}

private struct MacDraftRow: View {
    let draft: Draft

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(draft.to.isEmpty ? "No Recipients" : draft.to.joined(separator: ", "))
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let updated = draft.updatedAt.flatMap(MailDate.parse) {
                    Text(MailDateFormatting.listLabel(for: updated))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            Text(draft.subject.isEmpty ? "No Subject" : draft.subject).lineLimit(1)
            if !draft.text.isEmpty {
                Text(draft.text).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
