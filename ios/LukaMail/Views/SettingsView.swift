import SwiftUI

/// App settings, presented as a sheet from the Mailboxes tab. Changes apply immediately.
struct SettingsView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var loggingOut = false
    @State private var clearingCache = false
    @State private var confirmsLogout = false
    @State private var confirmsClearCache = false
    @State private var cacheCleared = false
    @State private var showsContacts = false
    @State private var localError: String?

    private var selectedIdentity: MailIdentity? {
        store.identities.first { $0.address == store.selectedInbox }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) {
                        MonogramAvatar(name: selectedIdentity?.displayName ?? store.selectedInbox,
                                       address: store.selectedInbox,
                                       avatarColor: selectedIdentity?.avatarColor, size: 56)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(selectedIdentity?.displayName ?? store.selectedInbox)
                                .font(.title3.weight(.semibold))
                            Text(store.connectionLabel)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }

                Section {
                    LabeledContent("Status") { statusLabel }
                    LabeledContent("Server", value: store.serverHost)
                    LabeledContent("Sign-In Method", value: store.isDemoMode ? "Demo Mode" : "Passkey")
                } header: {
                    Text("Account")
                } footer: {
                    if store.isDemoMode {
                        Text("You’re exploring sample messages on this device. No account or server connection is used.")
                    } else {
                        Text("Your 30-day session is kept in this device’s Keychain and is never shown in the app.")
                    }
                }

                Section("Sending") {
                    if store.identities.count > 1 {
                        Picker("Default Sender", selection: Binding(
                            get: { store.identity },
                            set: { store.setIdentity($0) }
                        )) {
                            ForEach(store.identities) { identity in
                                Text(identity.address).tag(identity.address)
                            }
                        }
                    }
                    NavigationLink {
                        ContactsView(identity: store.selectedInbox)
                    } label: {
                        Label("Contacts", systemImage: "person.crop.circle")
                    }
                }

                Section {
                    Toggle("Load Remote Images", isOn: Binding(get: { store.loadRemoteImages }, set: { store.setRemoteImages($0) }))
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("Remote images are off by default so senders can’t see when you open a message. Images attached to a message always appear.")
                }

                Section {
                    Button {
                        confirmsClearCache = true
                    } label: {
                        HStack {
                            Text("Clear Downloaded Mail")
                            Spacer()
                            if clearingCache {
                                ProgressView()
                            } else if cacheCleared {
                                Label("Cleared", systemImage: "checkmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .disabled(clearingCache || loggingOut)
                    .confirmationDialog("Clear Downloaded Mail?", isPresented: $confirmsClearCache, titleVisibility: .visible) {
                        Button("Clear Downloaded Mail", role: .destructive) { Task { await clearCache() } }
                    } message: {
                        Text("Saved messages and sender images are removed from this device and download again when needed. You stay signed in.")
                    }
                } header: {
                    Text("Storage")
                } footer: {
                    if let localError {
                        Label(localError, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: "\(AppBuildInfo.version) (\(AppBuildInfo.build))")
                    LabeledContent("Commit") {
                        Text(AppBuildInfo.gitCommit).monospaced().textSelection(.enabled)
                    }
                }

                Section {
                    Button(role: .destructive) {
                        confirmsLogout = true
                    } label: {
                        HStack {
                            Text(store.isDemoMode ? "Exit Demo Mode" : "Sign Out")
                            Spacer()
                            if loggingOut { ProgressView() }
                        }
                    }
                    .disabled(loggingOut || clearingCache)
                    .confirmationDialog(store.isDemoMode ? "Exit Demo Mode?" : "Sign Out of lmail?",
                                        isPresented: $confirmsLogout, titleVisibility: .visible) {
                        Button(store.isDemoMode ? "Exit Demo Mode" : "Sign Out", role: .destructive) { Task { await logout() } }
                    } message: {
                        if store.isDemoMode {
                            Text("Returns to the welcome screen so you can sign in to your own mail server.")
                        } else {
                            Text("This ends your session and removes downloaded mail from this device.")
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $showsContacts) { ContactsView(identity: store.selectedInbox) }
            .onAppear {
                if ["contacts", "contact"].contains(DemoLaunch.string("DemoSheet")) { showsContacts = true }
                if DemoLaunch.string("DemoConfirm") == "signout" { confirmsLogout = true }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .sensoryFeedback(.success, trigger: cacheCleared) { _, cleared in cleared }
    }

    private var statusLabel: some View {
        Group {
            if let message = store.connectionStatus.message {
                Label(message, systemImage: store.connectionStatus.systemImage)
                    .foregroundStyle(.orange)
            } else {
                Label("Connected", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
        }
        .labelStyle(.titleAndIcon)
        .multilineTextAlignment(.trailing)
    }

    private func logout() async {
        loggingOut = true
        localError = nil
        defer { loggingOut = false }
        do {
            try await store.logout()
            dismiss()
        } catch {
            localError = error.localizedDescription
        }
    }

    private func clearCache() async {
        clearingCache = true
        localError = nil
        cacheCleared = false
        defer { clearingCache = false }
        do {
            try await store.clearLocalCache()
            cacheCleared = true
        } catch {
            localError = error.localizedDescription
        }
    }
}

private struct ContactsView: View {
    @Environment(MailStore.self) private var store
    let identity: String
    @State private var query = ""
    @State private var editing: ContactEditorTarget?

    private var visibleContacts: [MailContact] {
        store.contacts.filter { $0.identityAddress == identity && $0.matches(query) }
    }

    var body: some View {
        List {
            Section {
                ForEach(visibleContacts) { contact in
                    Button { editing = .existing(contact) } label: { row(contact) }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Delete", systemImage: "trash", role: .destructive) { delete(contact) }
                        }
                        .contextMenu {
                            Button("Edit Name…", systemImage: "pencil") { editing = .existing(contact) }
                            Button("Delete", systemImage: "trash", role: .destructive) { delete(contact) }
                        }
                }
            } footer: {
                if !visibleContacts.isEmpty {
                    Text("People you send mail to are remembered automatically and suggested first when you address a message.")
                }
            }
        }
        .overlay {
            if visibleContacts.isEmpty {
                if query.isEmpty {
                    ContentUnavailableView {
                        Label("No Contacts", systemImage: "person.crop.circle")
                    } description: {
                        Text("People you send mail to appear here. You can also add a contact yourself.")
                    } actions: {
                        Button("Add Contact") { editing = .new }
                            .buttonStyle(.bordered)
                    }
                } else {
                    ContentUnavailableView.search(text: query)
                }
            }
        }
        .navigationTitle("Contacts")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Name or Email Address")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add Contact", systemImage: "plus") { editing = .new }
            }
        }
        .sheet(item: $editing) { target in
            ContactEditorView(identity: identity, contact: target.contact)
        }
        .task(id: identity) { await store.loadContacts(identity: identity) }
        .onAppear { if DemoLaunch.string("DemoSheet") == "contact" { editing = .new } }
        .refreshable { await store.loadContacts(identity: identity) }
    }

    private func row(_ contact: MailContact) -> some View {
        HStack(spacing: 12) {
            MonogramAvatar(name: contact.label, address: contact.address, avatarColor: contact.avatarColor, size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(contact.label).lineLimit(1)
                if contact.displayName != nil {
                    Text(contact.address).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Edits this contact")
    }

    private func delete(_ contact: MailContact) {
        Task { try? await store.removeContact(address: contact.address, identity: identity) }
    }
}

private enum ContactEditorTarget: Identifiable {
    case new
    case existing(MailContact)

    var id: String {
        switch self {
        case .new: "new"
        case .existing(let contact): contact.id
        }
    }

    var contact: MailContact? {
        if case .existing(let contact) = self { return contact }
        return nil
    }
}

private struct ContactEditorView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let identity: String
    let contact: MailContact?
    @State private var address: String
    @State private var name: String
    @State private var saving = false
    @State private var errorMessage: String?

    init(identity: String, contact: MailContact?) {
        self.identity = identity
        self.contact = contact
        _address = State(initialValue: contact?.address ?? "")
        _name = State(initialValue: contact?.displayName ?? "")
    }

    private var isValid: Bool { RecipientParser.addresses(address).count == 1 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if contact == nil {
                        TextField("Email Address", text: $address)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else {
                        LabeledContent("Email Address", value: address)
                    }
                    TextField("Name (Optional)", text: $name)
                        .textContentType(.name)
                } footer: {
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    }
                }
                if let contact {
                    Section {
                        Button("Delete Contact", role: .destructive) {
                            Task {
                                try? await store.removeContact(address: contact.address, identity: identity)
                                dismiss()
                            }
                        }
                    }
                }
            }
            .navigationTitle(contact == nil ? "New Contact" : "Edit Contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(contact == nil ? "Add" : "Save") { Task { await save() } }
                        .disabled(saving || !isValid)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(saving)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            if contact == nil {
                _ = try await store.addContact(address: address, displayName: name, identity: identity)
            } else {
                _ = try await store.renameContact(address: address, displayName: name, identity: identity)
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
