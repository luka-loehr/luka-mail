import SwiftUI
import UniformTypeIdentifiers

struct MacComposeView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private let initialDraft: Draft
    @State private var draft: Draft
    @State private var to: String
    @State private var cc: String
    @State private var bcc: String
    @State private var attachments: [OutboundAttachment]
    @State private var showCcBcc: Bool
    @State private var showImporter = false
    @State private var sending = false
    @State private var errorMessage: String?
    @State private var errorTitle = "Couldn’t Send Message"
    @State private var suppressSuggestions = false
    @State private var finished = false
    @State private var confirmsDiscard = false
    @FocusState private var focusedRecipient: RecipientField?

    private enum RecipientField: Hashable { case to, cc, bcc }

    init(initialDraft: Draft) {
        self.initialDraft = initialDraft
        _draft = State(initialValue: initialDraft)
        _to = State(initialValue: initialDraft.to.joined(separator: ", "))
        _cc = State(initialValue: initialDraft.cc.joined(separator: ", "))
        _bcc = State(initialValue: initialDraft.bcc.joined(separator: ", "))
        _attachments = State(initialValue: initialDraft.localAttachments ?? [])
        _showCcBcc = State(initialValue: !initialDraft.cc.isEmpty || !initialDraft.bcc.isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            addressing
            Divider()
            editor
        }
        .frame(minWidth: 620, idealWidth: 760, minHeight: 500, idealHeight: 680)
        .background(Color(nsColor: .textBackgroundColor))
        .navigationTitle(draft.subject.trimmingCharacters(in: .whitespaces).isEmpty
            ? (draft.replyToMessageId == nil ? "New Message" : "Reply") : draft.subject)
        .toolbar { toolbar }
        .onDisappear {
            // Closing the window keeps unsent work as a draft, like Mail.
            guard !finished, hasChanges else { return }
            Task { await saveDraft() }
        }
        .confirmationDialog("Discard this message?", isPresented: $confirmsDiscard) {
            Button("Discard", role: .destructive) {
                finished = true
                dismiss()
            }
        } message: {
            Text("Your changes since the draft was last saved will be lost.")
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): importFiles(urls)
            case .failure(let error):
                errorTitle = "Couldn’t Attach File"
                errorMessage = error.localizedDescription
            }
        }
        .alert(errorTitle, isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Unknown error")
        }
        .task(id: draft.from) { await store.loadContacts(identity: draft.from) }
        .onChange(of: focusedRecipient) { _, _ in suppressSuggestions = false }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                Task { await send() }
            } label: {
                if sending {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Send", systemImage: "paperplane")
                }
            }
            .buttonStyle(.glassProminent)
            .keyboardShortcut("d", modifiers: [.command, .shift])
            .help("Send (⇧⌘D)")
            .disabled(!canSend || sending)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button("Attach Files", systemImage: "paperclip") { showImporter = true }
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .help("Attach Files (⇧⌘A)")
                .disabled(sending || attachments.count >= 10)
            Button("Discard", systemImage: "trash") {
                if hasChanges { confirmsDiscard = true } else { finished = true; dismiss() }
            }
            .help("Discard Message")
            .disabled(sending)
        }
    }

    private var hasChanges: Bool {
        to != initialDraft.to.joined(separator: ", ") || cc != initialDraft.cc.joined(separator: ", ")
            || bcc != initialDraft.bcc.joined(separator: ", ") || draft.subject != initialDraft.subject
            || draft.text != initialDraft.text || draft.from != initialDraft.from
            || attachments.map(\.id) != (initialDraft.localAttachments ?? []).map(\.id)
    }

    private var addressing: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                fieldLabel("From")
                Picker("From", selection: $draft.from) {
                    ForEach(availableIdentities) { identity in
                        Text(identity.displayName == identity.address
                            ? identity.address
                            : "\(identity.displayName) <\(identity.address)>")
                            .tag(identity.address)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 40)

            Divider().padding(.leading, 76)
            addressRow("To", placeholder: "Name or email address", text: $to, field: .to)

            if showCcBcc {
                Divider().padding(.leading, 76)
                addressRow("Cc", placeholder: "Optional", text: $cc, field: .cc)
                Divider().padding(.leading, 76)
                addressRow("Bcc", placeholder: "Optional", text: $bcc, field: .bcc)
            } else {
                Button("Add Cc and Bcc") { withAnimation(.snappy) { showCcBcc = true } }
                    .buttonStyle(.link)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 5)
            }

            Divider().padding(.leading, 76)
            HStack(spacing: 10) {
                fieldLabel("Subject")
                TextField("Subject", text: $draft.subject)
                    .textFieldStyle(.plain)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 40)

            if !attachments.isEmpty {
                Divider()
                attachmentStrip
            }
        }

    }

    private var editor: some View {
        TextEditor(text: $draft.text)
            .font(.body)
            .scrollContentBackground(.hidden)
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topLeading) {
                if draft.text.isEmpty {
                    Text("Write a message…")
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 21)
                        .padding(.vertical, 24)
                        .allowsHitTesting(false)
                }
            }
    }

    @ViewBuilder
    private func addressRow(_ label: String, placeholder: String, text: Binding<String>, field: RecipientField) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                fieldLabel(label)
                TextField(placeholder, text: Binding(
                    get: { text.wrappedValue },
                    set: { value in
                        text.wrappedValue = value
                        suppressSuggestions = false
                    }
                ))
                .textFieldStyle(.plain)
                .focused($focusedRecipient, equals: field)
                .autocorrectionDisabled()
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 40)

            let matches = contactSuggestions(for: text.wrappedValue)
            if focusedRecipient == field, !suppressSuggestions, !matches.isEmpty {
                suggestionList(matches, field: field)
            }
        }
    }

    private func suggestionList(_ contacts: [MailContact], field: RecipientField) -> some View {
        VStack(spacing: 0) {
            Divider()
            ForEach(contacts) { contact in
                Button { select(contact, for: field) } label: {
                    HStack(spacing: 10) {
                        MonogramAvatar(name: contact.label, address: contact.address,
                                       avatarColor: contact.avatarColor, size: 24)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(contact.label).fontWeight(contact.displayName == nil ? .regular : .medium)
                            if contact.displayName != nil {
                                Text(contact.address).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                    .padding(.leading, 76)
                    .padding(.trailing, 16)
                    .frame(minHeight: 36)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .background(.background.secondary)
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    HStack(spacing: 7) {
                        Image(systemName: "doc.fill").foregroundStyle(.blue)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(attachment.filename).lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Button {
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(attachment.filename)")
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 38)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 8, style: .continuous))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private var availableIdentities: [MailIdentity] {
        store.identities.isEmpty
            ? [MailIdentity(address: store.identity, displayName: store.identity)]
            : store.identities
    }

    private func fieldLabel(_ value: String) -> some View {
        Text(value)
            .foregroundStyle(.secondary)
            .frame(width: 50, alignment: .trailing)
    }

    private var canSend: Bool { !RecipientParser.addresses(to).isEmpty }

    private func contactSuggestions(for value: String) -> [MailContact] {
        let fragment = RecipientParser.activeFragment(value)
        guard !fragment.isEmpty else { return [] }
        let selected = Set(RecipientParser.addresses(to) + RecipientParser.addresses(cc) + RecipientParser.addresses(bcc))
        return Array(store.contacts.lazy
            .filter { !selected.contains($0.address.lowercased()) && $0.matches(fragment) }
            .prefix(6))
    }

    private func select(_ contact: MailContact, for field: RecipientField) {
        switch field {
        case .to: to = RecipientParser.replacingActiveFragment(in: to, with: contact.address)
        case .cc: cc = RecipientParser.replacingActiveFragment(in: cc, with: contact.address)
        case .bcc: bcc = RecipientParser.replacingActiveFragment(in: bcc, with: contact.address)
        }
        suppressSuggestions = true
    }

    private func applyRecipients() -> Bool {
        if let error = RecipientParser.validationError(to: to, cc: cc, bcc: bcc) {
            errorTitle = error.title
            errorMessage = error.message
            return false
        }
        draft.to = RecipientParser.addresses(to)
        draft.cc = RecipientParser.addresses(cc)
        draft.bcc = RecipientParser.addresses(bcc)
        return true
    }

    private func send() async {
        guard applyRecipients() else { return }
        sending = true
        defer { sending = false }
        do {
            try await store.send(draft, attachments: attachments)
            finished = true
            dismiss()
        } catch {
            errorTitle = "Couldn’t Send Message"
            errorMessage = error.localizedDescription
        }
    }

    private func saveDraft() async {
        guard applyRecipients() else { return }
        draft.localAttachments = attachments.isEmpty ? nil : attachments
        _ = try? await store.saveDraft(draft)
    }

    private func importFiles(_ urls: [URL]) {
        for url in urls.prefix(max(0, 10 - attachments.count)) {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url), data.count <= OutboundAttachment.sendingBudget else {
                errorTitle = "Attachment Too Large"
                errorMessage = "Attachments can total at most \(Int64(OutboundAttachment.sendingBudget).formatted(.byteCount(style: .file))) per message."
                continue
            }
            guard attachments.reduce(0, { $0 + $1.size }) + data.count <= OutboundAttachment.sendingBudget else {
                errorTitle = "Attachment Too Large"
                errorMessage = "Attachments can total at most \(Int64(OutboundAttachment.sendingBudget).formatted(.byteCount(style: .file))) per message."
                continue
            }
            let contentType = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)?.preferredMIMEType
                ?? "application/octet-stream"
            attachments.append(OutboundAttachment(
                id: UUID(), filename: url.lastPathComponent, contentType: contentType,
                data: data.base64EncodedString(), size: data.count
            ))
        }
    }
}
