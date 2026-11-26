import SwiftUI

struct MacMailboxSidebar: View {
    @Environment(MailStore.self) private var store
    @Binding var selection: Mailbox

    var body: some View {
        List(selection: $selection) {
            Section("Favorites") {
                row(.inbox, count: store.summary?.unread)
                row(.starred, count: nil)
                row(.sent, count: nil)
                row(.drafts, count: store.summary?.drafts)
            }
            Section("Mailboxes") {
                row(.archive, count: nil)
                row(.trash, count: nil)
            }
            if store.identities.count > 1 {
                Section("Accounts") {
                    Picker("Account", selection: Binding(
                        get: { store.selectedInbox },
                        set: { address in Task { await store.selectInbox(address) } }
                    )) {
                        ForEach(store.identities) { identity in
                            Text(identity.address).tag(identity.address)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Mailboxes")
        .safeAreaBar(edge: .bottom) {
            if let message = store.connectionStatus.message {
                Label(message, systemImage: store.connectionStatus.systemImage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
        }
    }

    private func row(_ mailbox: Mailbox, count: Int?) -> some View {
        Label(mailbox.title, systemImage: mailbox.symbolName)
            .badge(count ?? 0)
            .tag(mailbox)
    }
}
