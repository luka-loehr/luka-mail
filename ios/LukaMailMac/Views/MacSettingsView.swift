import AppKit
import SwiftUI

struct MacSettingsView: View {
    @Environment(MailStore.self) private var store

    var body: some View {
        TabView {
            MacAccountSettingsPane()
                .tabItem { Label("Account", systemImage: "at") }

            MacPrivacySettingsPane()
                .tabItem { Label("Privacy", systemImage: "hand.raised") }

            MacAboutSettingsPane()
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(width: 620, height: 480)
    }
}

private struct MacAccountSettingsPane: View {
    @Environment(MailStore.self) private var store

    @State private var identity = ""
    @State private var serverAddress = ServerEndpoint.saved().map { ServerEndpoint.displayHost(for: $0.absoluteString) } ?? ""
    @State private var authenticating = false
    @State private var localError: String?
    @State private var showContacts = false
    @State private var confirmLogout = false

    private var normalizedServer: URL? { ServerEndpoint.normalize(serverAddress) }

    var body: some View {
        Form {
            Section {
                if store.configured {
                    LabeledContent("Server", value: store.serverHost)
                } else {
                    TextField("Server", text: $serverAddress, prompt: Text("mail.example.com"))
                        .disabled(authenticating)
                }

                LabeledContent("Status") {
                    if !store.configured {
                        Label("Not Signed In", systemImage: "person.crop.circle.badge.xmark")
                    } else if let message = store.connectionStatus.message {
                        Label(message, systemImage: store.connectionStatus.systemImage)
                            .foregroundStyle(.orange)
                    } else {
                        Label(store.connectionLabel, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }

                if store.configured {
                    LabeledContent("Sign-In Method", value: store.isDemoMode ? "Demo Mode" : "Passkey")
                }
            } header: {
                Text("Connection")
            } footer: {
                if store.isDemoMode {
                    Text("You’re exploring sample messages on this Mac. No account or server connection is used.")
                } else {
                    Text("Sign-in is confirmed with your passkey. The 30-day access token is kept in your Login Keychain and never shown in the app.")
                }
            }

            if store.configured {
                Section("Sending") {
                    Picker("Default Sender", selection: $identity) {
                        ForEach(store.identities) { item in
                            Text(item.displayName == item.address
                                ? item.address
                                : "\(item.displayName) <\(item.address)>")
                                .tag(item.address)
                        }
                    }
                    .onChange(of: identity) { _, address in
                        guard store.identities.contains(where: { $0.address == address }) else { return }
                        store.setIdentity(address)
                    }

                    LabeledContent("Contacts") {
                        Button("Manage Contacts…") { showContacts = true }
                    }
                }
            }

            if let localError {
                Section {
                    Label(localError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }

            Section {
                HStack {
                    if store.configured {
                        Button(role: .destructive) {
                            confirmLogout = true
                        } label: {
                            if authenticating {
                                HStack(spacing: 7) {
                                    ProgressView().controlSize(.small)
                                    Text("Signing Out…")
                                }
                            } else {
                                Text(store.isDemoMode ? "Exit Demo Mode" : "Sign Out")
                            }
                        }
                        .disabled(authenticating)
                    }
                    Spacer()
                    if !store.configured {
                        Button {
                            Task { await signIn() }
                        } label: {
                            if authenticating {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(width: 148)
                            } else {
                                Label("Continue with Passkey", systemImage: "person.badge.key.fill")
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(authenticating || normalizedServer == nil)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding(.top, 8)
        .onAppear {
            identity = store.identity
            if serverAddress.isEmpty { serverAddress = ServerEndpoint.saved().map { ServerEndpoint.displayHost(for: $0.absoluteString) } ?? "" }
        }
        .onChange(of: store.identity) { _, newIdentity in
            identity = newIdentity
        }
        .sheet(isPresented: $showContacts) {
            MacContactsView(identity: store.selectedInbox)
                .frame(minWidth: 540, minHeight: 440)
        }
        .confirmationDialog(store.isDemoMode ? "Exit Demo Mode?" : "Sign Out of lmail?", isPresented: $confirmLogout) {
            Button(store.isDemoMode ? "Exit Demo Mode" : "Sign Out", role: .destructive) { Task { await logout() } }
        } message: {
            if store.isDemoMode {
                Text("Returns to the welcome screen so you can sign in to your own mail server.")
            } else {
                Text("This ends your session and removes downloaded mail from this Mac.")
            }
        }
    }

    private func signIn() async {
        authenticating = true
        localError = nil
        defer { authenticating = false }
        do {
            try await store.signIn(serverAddress: serverAddress, platform: .macos)
            identity = store.identity
        } catch {
            if let authError = error as? NativeAuthError, case .cancelled = authError { return }
            localError = error.localizedDescription
        }
    }

    private func logout() async {
        authenticating = true
        localError = nil
        defer { authenticating = false }
        do {
            try await store.logout()
            identity = ""
        } catch {
            localError = error.localizedDescription
        }
    }
}

private struct MacPrivacySettingsPane: View {
    @Environment(MailStore.self) private var store
    @State private var clearingCache = false
    @State private var cacheCleared = false
    @State private var cacheError: String?

    var body: some View {
        Form {
            Section {
                Toggle("Load Remote Images", isOn: Binding(
                    get: { store.loadRemoteImages },
                    set: { store.setRemoteImages($0) }
                ))
            } header: {
                Text("Message Content")
            } footer: {
                Text("Remote images are off by default so senders can’t see when you open a message. Images attached to a message always appear.")
            }

            Section("Local Data") {
                LabeledContent("Credentials", value: "Login Keychain")
                LabeledContent("Message cache", value: "Application Support")
                HStack {
                    Button("Clear Downloaded Mail") {
                        Task { await clearCache() }
                    }
                    .disabled(clearingCache)

                    if clearingCache {
                        ProgressView().controlSize(.small)
                    } else if cacheCleared {
                        Label("Cleared", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                Text("Saved messages and sender images are removed from this Mac and download again when needed. You stay signed in.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if let cacheError {
                    Label(cacheError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .padding(.top, 8)
    }

    private func clearCache() async {
        clearingCache = true
        cacheCleared = false
        cacheError = nil
        defer { clearingCache = false }
        do {
            try await store.clearLocalCache()
            cacheCleared = true
        } catch {
            cacheError = error.localizedDescription
        }
    }
}

private struct MacAboutSettingsPane: View {
    var body: some View {
        VStack(spacing: 18) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .scaledToFit()
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            VStack(spacing: 4) {
                Text("lmail").font(.title2.bold())
                Text("Version \(AppBuildInfo.version) (\(AppBuildInfo.build))")
                    .foregroundStyle(.secondary)
            }
            LabeledContent("Commit", value: AppBuildInfo.gitCommit)
                .frame(width: 300)
                .textSelection(.enabled)
            Text("A focused native mail client for your self-hosted lmail server.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(36)
    }
}

private struct MacContactsView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let identity: String
    @State private var query = ""
    @State private var editingContact: MailContact?
    @State private var showNewContact = false

    private var visibleContacts: [MailContact] {
        store.contacts.filter { $0.identityAddress == identity && $0.matches(query) }
    }

    var body: some View {
        NavigationStack {
            List(visibleContacts) { contact in
                Button { editingContact = contact } label: {
                    HStack(spacing: 10) {
                        MonogramAvatar(name: contact.label, address: contact.address,
                                       avatarColor: contact.avatarColor, size: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(contact.label).lineLimit(1)
                            if contact.displayName != nil {
                                Text(contact.address).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                        if contact.sendCount > 0 {
                            Text("\(contact.sendCount)×").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("Edit Name…") { editingContact = contact }
                    Button("Delete", role: .destructive) {
                        Task { try? await store.removeContact(address: contact.address, identity: identity) }
                    }
                }
            }
            .overlay {
                if visibleContacts.isEmpty {
                    ContentUnavailableView(
                        query.isEmpty ? "No Contacts" : "No Results",
                        systemImage: "person.crop.circle.dashed",
                        description: Text(query.isEmpty
                            ? "People you send mail to appear here."
                            : "Try another name or address.")
                    )
                }
            }
            .navigationTitle("Contacts")
            .searchable(text: $query, prompt: "Name or email")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { showNewContact = true } label: { Label("Add Contact", systemImage: "plus") }
                }
            }
        }
        .task(id: identity) { await store.loadContacts(identity: identity) }
        .sheet(isPresented: $showNewContact) {
            MacContactEditor(identity: identity, contact: nil)
        }
        .sheet(item: $editingContact) { contact in
            MacContactEditor(identity: identity, contact: contact)
        }
    }
}

private struct MacContactEditor: View {
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

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(contact == nil ? "New Contact" : "Edit Contact").font(.headline)
            Form {
                TextField("Email", text: $address)
                    .textContentType(.emailAddress)
                    .disabled(contact != nil)
                TextField("Name", text: $name, prompt: Text("Optional"))
                    .textContentType(.name)
            }
            .formStyle(.grouped)

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.red)
            }

            HStack {
                if let contact {
                    Button("Delete", role: .destructive) {
                        Task {
                            try? await store.removeContact(address: contact.address, identity: identity)
                            dismiss()
                        }
                    }
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(contact == nil ? "Add" : "Save") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || !address.contains("@"))
            }
        }
        .padding(24)
        .frame(width: 430, height: 280)
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
