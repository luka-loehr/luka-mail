import SwiftUI

/// The message list for one mailbox, with multi-select editing and swipe actions.
struct MailboxScreen: View {
    @Environment(MailStore.self) private var store
    @Environment(\.composeMessage) private var compose
    let mailbox: Mailbox
    var showsAccountMenu = false
    @State private var selection: Set<String> = []
    @State private var editMode: EditMode = .inactive

    /// The store holds one message list; only show it when it belongs to this mailbox.
    private var isCurrent: Bool { store.mailbox == mailbox && store.search.isEmpty }
    private var messages: [MailMessage] { isCurrent ? store.messages : [] }
    private var selectedMessages: [MailMessage] { messages.filter { selection.contains($0.id) } }

    var body: some View {
        List(selection: $selection) {
            ForEach(messages) { message in
                NavigationLink(value: MailRoute.message(message.id)) {
                    MessageRow(message: message)
                }
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    MessageReadToggle(message: message)
                        .tint(.blue)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    MessageMoveActions(message: message, mailbox: mailbox)
                }
                .contextMenu {
                    MessageContextMenu(message: message, mailbox: mailbox)
                }
                .onAppear {
                    guard message.id == messages.last?.id else { return }
                    Task { await store.loadMoreIfNeeded(after: message) }
                }
            }
            if isCurrent, store.loadingMore {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .overlay { emptyState }
        .navigationTitle(editMode.isEditing ? (selection.isEmpty ? "Select Messages" : "\(selection.count) Selected") : mailbox.title)
        .navigationSubtitle(MailboxSubtitle.text(for: mailbox, store: store))
        .toolbar { toolbar }
        .environment(\.editMode, $editMode)
        .toolbarVisibility(editMode.isEditing ? .hidden : .automatic, for: .tabBar)
        .animation(.snappy, value: editMode.isEditing)
        .refreshable { await store.refresh(mailbox: mailbox, query: "") }
        .task { await store.refresh(mailbox: mailbox, query: "") }
        .onChange(of: store.selectedInbox) { _, _ in selection.removeAll() }
        .task(id: messages.first?.id) {
            if DemoLaunch.flag("DemoEditing"), !editMode.isEditing, let first = messages.first {
                editMode = .active
                selection = [first.id]
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if messages.isEmpty {
            if !isCurrent || store.loading {
                ProgressView()
            } else if store.connectionStatus != .online, let message = store.connectionStatus.message {
                ContentUnavailableView {
                    Label("Can’t Load Mail", systemImage: store.connectionStatus.systemImage)
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await store.refresh(mailbox: mailbox, query: "") } }
                        .buttonStyle(.bordered)
                }
            } else {
                ContentUnavailableView(mailbox.emptyTitle, systemImage: mailbox.symbolName,
                                       description: Text(mailbox.emptyDescription))
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if !messages.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
                Button(editMode.isEditing ? "Done" : "Select") {
                    withAnimation(.snappy) {
                        editMode = editMode.isEditing ? .inactive : .active
                        selection.removeAll()
                    }
                }
            }
        }
        if !editMode.isEditing {
            if showsAccountMenu {
                ToolbarItem(placement: .topBarLeading) { AccountMenu() }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                Button("New Message", systemImage: "square.and.pencil") {
                    compose(.compose(from: store.selectedInbox))
                }
            }
        } else {
            ToolbarItem(placement: .bottomBar) {
                Menu("Mark") {
                    Button("Mark as Read", systemImage: "envelope.open") { apply(MessageUpdate(unread: false)) }
                    Button("Mark as Unread", systemImage: "envelope.badge") { apply(MessageUpdate(unread: true)) }
                    Divider()
                    Button("Star", systemImage: "star") { apply(MessageUpdate(starred: true)) }
                    Button("Remove Star", systemImage: "star.slash") { apply(MessageUpdate(starred: false)) }
                }
                .disabled(selection.isEmpty)
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItemGroup(placement: .bottomBar) {
                if mailbox == .archive || mailbox == .trash {
                    Button("Move to Inbox", systemImage: "tray.and.arrow.down") { move(to: "inbox") }
                        .disabled(selection.isEmpty)
                } else {
                    Button("Archive", systemImage: "archivebox") { move(to: "archive") }
                        .disabled(selection.isEmpty)
                }
                if mailbox != .trash {
                    Button("Trash", systemImage: "trash") { move(to: "trash") }
                        .disabled(selection.isEmpty)
                }
            }
        }
    }

    private func apply(_ update: MessageUpdate) {
        let ids = selectedMessages.map(\.id)
        Task {
            for id in ids { await store.update(id: id, update: update) }
        }
        endEditing()
    }

    private func move(to folder: String) {
        let ids = selectedMessages.map(\.id)
        Task {
            for id in ids {
                await store.update(id: id, update: MessageUpdate(folder: folder), removeFromCurrentList: true)
            }
        }
        endEditing()
    }

    private func endEditing() {
        withAnimation(.snappy) {
            selection.removeAll()
            editMode = .inactive
        }
    }
}

enum MailboxSubtitle {
    /// Connection problems first, then the unread count and the account when several exist.
    @MainActor
    static func text(for mailbox: Mailbox, store: MailStore) -> String {
        if let message = store.connectionStatus.message { return message }
        var parts: [String] = []
        if store.identities.count > 1 { parts.append(store.selectedInbox) }
        if mailbox == .inbox, let unread = store.summary?.unread, unread > 0 { parts.append("\(unread) Unread") }
        return parts.joined(separator: " · ")
    }
}

struct MessageRow: View {
    let message: MailMessage
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.editMode) private var editMode
    @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 40

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if !dynamicTypeSize.isAccessibilitySize {
                SenderAvatar(name: message.correspondent.label, address: message.correspondent.address,
                             avatarColor: message.correspondent.avatarColor,
                             messageID: message.isOutbound ? nil : message.id,
                             size: min(avatarSize, 56))
            }
            VStack(alignment: .leading, spacing: 2) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        correspondent
                        Spacer(minLength: 0)
                        dateLabel
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        correspondent
                        dateLabel
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(message.displaySubject)
                        .font(.subheadline)
                        .fontWeight(message.unread ? .semibold : .regular)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    Spacer(minLength: 0)
                    if message.hasAttachments {
                        Image(systemName: "paperclip").font(.footnote).foregroundStyle(.secondary)
                    }
                    if message.starred {
                        Image(systemName: "star.fill").font(.footnote).foregroundStyle(.yellow)
                    }
                }
                Text(message.preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .topLeading) {
            if message.unread, editMode?.wrappedValue.isEditing != true {
                Circle()
                    .fill(.tint)
                    .frame(width: 10, height: 10)
                    .offset(x: -15, y: 6)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(message.accessibilitySummary)
    }

    private var correspondent: some View {
        Text(message.isOutbound ? "To: \(message.correspondent.label)" : message.correspondent.label)
            .font(.headline)
            .fontWeight(message.unread ? .bold : .semibold)
            .lineLimit(1)
    }

    private var dateLabel: some View {
        Text(MailDateFormatting.listLabel(for: message.date))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .monospacedDigit()
    }
}

// MARK: - Message actions shared by swipe actions and context menus

struct MessageReadToggle: View {
    @Environment(MailStore.self) private var store
    let message: MailMessage

    var body: some View {
        Button(message.unread ? "Mark as Read" : "Mark as Unread",
               systemImage: message.unread ? "envelope.open" : "envelope.badge") {
            Task { await store.update(id: message.id, update: MessageUpdate(unread: !message.unread)) }
        }
    }
}

struct MessageStarToggle: View {
    @Environment(MailStore.self) private var store
    let message: MailMessage

    var body: some View {
        Button(message.starred ? "Remove Star" : "Star", systemImage: message.starred ? "star.slash" : "star") {
            Task { await store.update(id: message.id, update: MessageUpdate(starred: !message.starred)) }
        }
    }
}

/// Trash plus Archive or Move to Inbox, as trailing swipe actions.
struct MessageMoveActions: View {
    @Environment(MailStore.self) private var store
    let message: MailMessage
    let mailbox: Mailbox

    var body: some View {
        if mailbox != .trash {
            Button("Trash", systemImage: "trash", role: .destructive) { move(to: "trash") }
        }
        if mailbox == .archive || mailbox == .trash {
            Button("Move to Inbox", systemImage: "tray.and.arrow.down") { move(to: "inbox") }
                .tint(.blue)
        } else {
            Button("Archive", systemImage: "archivebox") { move(to: "archive") }
                .tint(.indigo)
        }
    }

    private func move(to folder: String) {
        Task { await store.update(id: message.id, update: MessageUpdate(folder: folder), removeFromCurrentList: true) }
    }
}

struct MessageContextMenu: View {
    @Environment(MailStore.self) private var store
    let message: MailMessage
    let mailbox: Mailbox

    var body: some View {
        Section {
            MessageReadToggle(message: message)
            MessageStarToggle(message: message)
        }
        Section {
            if mailbox == .archive || mailbox == .trash {
                Button("Move to Inbox", systemImage: "tray.and.arrow.down") { move(to: "inbox") }
            } else {
                Button("Archive", systemImage: "archivebox") { move(to: "archive") }
            }
        }
        if mailbox != .trash {
            Button("Move to Trash", systemImage: "trash", role: .destructive) { move(to: "trash") }
        }
    }

    private func move(to folder: String) {
        Task { await store.update(id: message.id, update: MessageUpdate(folder: folder), removeFromCurrentList: true) }
    }
}
