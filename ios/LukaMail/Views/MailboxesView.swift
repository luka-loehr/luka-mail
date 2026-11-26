import SwiftUI

/// The top-left dropdown: switch accounts, open the other mailboxes, or open Settings.
struct AccountMenu: View {
    @Environment(MailStore.self) private var store
    @Environment(\.openMailRoute) private var openRoute
    @Environment(\.showSettings) private var showSettings

    private var selectedIdentity: MailIdentity? {
        store.identities.first { $0.address == store.selectedInbox }
    }

    var body: some View {
        Menu {
            if store.identities.count > 1 {
                Picker("Account", selection: Binding(
                    get: { store.selectedInbox },
                    set: { address in Task { await store.selectInbox(address) } }
                )) {
                    ForEach(store.identities) { identity in
                        Text(identity.displayName == identity.address ? identity.address
                             : "\(identity.displayName)\n\(identity.address)")
                            .tag(identity.address)
                    }
                }
                .pickerStyle(.inline)
            }

            Section {
                ForEach([Mailbox.drafts, .archive, .trash]) { mailbox in
                    Button(mailbox.title, systemImage: mailbox.symbolName) { openRoute(.mailbox(mailbox)) }
                        .badge(mailbox == .drafts ? store.summary?.drafts ?? 0 : 0)
                }
            }

            Section {
                Button("Settings", systemImage: "gearshape") { showSettings() }
            }
        } label: {
            HStack(spacing: 6) {
                MonogramAvatar(name: selectedIdentity?.displayName ?? store.selectedInbox,
                               address: store.selectedInbox,
                               avatarColor: selectedIdentity?.avatarColor, size: 28)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Account and Mailboxes")
        .accessibilityValue(store.selectedInbox)
    }
}

struct DraftsScreen: View {
    @Environment(MailStore.self) private var store
    @Environment(\.composeMessage) private var compose

    private var isCurrent: Bool { store.mailbox == .drafts && store.search.isEmpty }

    var body: some View {
        List {
            ForEach(store.drafts) { draft in
                Button { compose(draft) } label: { DraftRow(draft: draft) }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            Task { await store.deleteDraft(draft) }
                        }
                    }
                    .contextMenu {
                        Button("Open Draft", systemImage: "square.and.pencil") { compose(draft) }
                        Button("Delete Draft", systemImage: "trash", role: .destructive) {
                            Task { await store.deleteDraft(draft) }
                        }
                    }
            }
        }
        .listStyle(.plain)
        .overlay {
            if store.drafts.isEmpty {
                if !isCurrent || store.loading {
                    ProgressView()
                } else {
                    ContentUnavailableView(Mailbox.drafts.emptyTitle, systemImage: Mailbox.drafts.symbolName,
                                           description: Text(Mailbox.drafts.emptyDescription))
                }
            }
        }
        .navigationTitle("Drafts")
        .navigationSubtitle(store.identities.count > 1 ? store.selectedInbox : "")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New Message", systemImage: "square.and.pencil") {
                    compose(.compose(from: store.selectedInbox))
                }
            }
        }
        .refreshable { await store.refresh(mailbox: .drafts, query: "") }
        .task { await store.refresh(mailbox: .drafts, query: "") }
    }
}

private struct DraftRow: View {
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
            Text(draft.subject.isEmpty ? "No Subject" : draft.subject)
                .font(.subheadline)
                .lineLimit(1)
            if !draft.text.isEmpty {
                Text(draft.text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }
}
