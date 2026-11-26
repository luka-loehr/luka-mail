import SwiftUI
import UniformTypeIdentifiers

struct ComposeView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    private let initialDraft: Draft
    @State private var draft: Draft
    @State private var to: String
    @State private var cc: String
    @State private var bcc: String
    @State private var attachments: [OutboundAttachment]
    @State private var showsCcBcc: Bool
    @State private var showsImporter = false
    @State private var confirmsCancel = false
    @State private var sending = false
    @State private var errorMessage: String?
    @State private var errorTitle = "Couldn’t Send Message"
    @State private var suppressSuggestions = false
    @FocusState private var focus: Field?

    private enum Field: Hashable { case to, cc, bcc, subject, body }

    init(initialDraft: Draft) {
        self.initialDraft = initialDraft
        _draft = State(initialValue: initialDraft)
        _to = State(initialValue: initialDraft.to.joined(separator: ", "))
        _cc = State(initialValue: initialDraft.cc.joined(separator: ", "))
        _bcc = State(initialValue: initialDraft.bcc.joined(separator: ", "))
        _attachments = State(initialValue: initialDraft.localAttachments ?? [])
        _showsCcBcc = State(initialValue: !initialDraft.cc.isEmpty || !initialDraft.bcc.isEmpty)
    }

    private var title: String {
        if !draft.subject.trimmingCharacters(in: .whitespaces).isEmpty { return draft.subject }
        return draft.replyToMessageId == nil ? "New Message" : "Reply"
    }

    private var hasChanges: Bool {
        to != initialDraft.to.joined(separator: ", ") || cc != initialDraft.cc.joined(separator: ", ")
            || bcc != initialDraft.bcc.joined(separator: ", ") || draft.subject != initialDraft.subject
            || draft.text != initialDraft.text || draft.from != initialDraft.from
            || attachments.map(\.id) != (initialDraft.localAttachments ?? []).map(\.id)
    }

    private var canSend: Bool { !RecipientParser.addresses(to).isEmpty && !sending }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    addressRow("To:", text: $to, field: .to)
                    Divider()
                    if showsCcBcc {
                        addressRow("Cc:", text: $cc, field: .cc)
                        Divider()
                        addressRow("Bcc:", text: $bcc, field: .bcc)
                        Divider()
                        fromRow
                    } else {
                        Button {
                            withAnimation(.snappy) { showsCcBcc = true }
                        } label: {
                            fieldRow("Cc/Bcc, From:") {
                                Text(draft.from).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Divider()
                    fieldRow("Subject:") {
                        TextField("Subject", text: $draft.subject, prompt: Text(""))
                            .focused($focus, equals: .subject)
                            .submitLabel(.next)
                            .onSubmit { focus = .body }
                    }
                    Divider()
                    if !attachments.isEmpty {
                        attachmentStrip
                        Divider()
                    }
                    TextField("Message", text: $draft.text, prompt: Text("Write a message"), axis: .vertical)
                        .focused($focus, equals: .body)
                        .frame(maxWidth: .infinity, minHeight: 240, alignment: .topLeading)
                        .padding(16)
                        .accessibilityLabel("Message")
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .fileImporter(isPresented: $showsImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): importFiles(urls)
                case .failure(let error): show("Couldn’t Attach File", error.localizedDescription)
                }
            }
            .alert(errorTitle, isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .task(id: draft.from) { await store.loadContacts(identity: draft.from) }
            .onChange(of: focus) { _, _ in suppressSuggestions = false }
            .onAppear {
                if to.isEmpty { focus = .to } else if draft.replyToMessageId != nil { focus = .body }
                if DemoLaunch.string("DemoConfirm") == "cancel" { confirmsCancel = true }
            }
        }
        .interactiveDismissDisabled(hasChanges || sending)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", systemImage: "xmark", role: .cancel) {
                if hasChanges { confirmsCancel = true } else { dismiss() }
            }
            .disabled(sending)
            .confirmationDialog("Save this message as a draft?", isPresented: $confirmsCancel, titleVisibility: .hidden) {
                Button(draft.id == nil ? "Delete Draft" : "Discard Changes", role: .destructive) { dismiss() }
                Button("Save Draft") { Task { await saveAndDismiss() } }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Add Attachment", systemImage: "paperclip") { showsImporter = true }
                .disabled(sending || attachments.count >= 10)
        }
        ToolbarSpacer(.fixed, placement: .topBarTrailing)
        ToolbarItem(placement: .confirmationAction) {
            Button {
                Task { await send() }
            } label: {
                if sending {
                    ProgressView()
                } else {
                    Label("Send", systemImage: "arrow.up")
                }
            }
            .buttonStyle(.glassProminent)
            .disabled(!canSend)
        }
    }

    // MARK: Fields

    private func fieldRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .foregroundStyle(.secondary)
                .fixedSize()
                .accessibilityHidden(true)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: MailDesign.minimumHitTarget)
        .contentShape(.rect)
    }

    private var fromRow: some View {
        fieldRow("From:") {
            Picker("From", selection: $draft.from) {
                ForEach(store.identities.isEmpty ? [MailIdentity(address: store.identity, displayName: store.identity)] : store.identities) {
                    Text($0.address).tag($0.address)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
        }
    }

    private func addressRow(_ label: String, text: Binding<String>, field: Field) -> some View {
        VStack(spacing: 0) {
            fieldRow(label) {
                TextField(String(label.dropLast()), text: Binding(
                    get: { text.wrappedValue },
                    set: { value in
                        text.wrappedValue = value
                        suppressSuggestions = false
                    }
                ), prompt: Text(""))
                .focused($focus, equals: field)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .onSubmit { focus = .subject }
            }
            let matches = contactSuggestions(for: text.wrappedValue)
            if focus == field, !suppressSuggestions, !matches.isEmpty {
                suggestionList(matches, field: field)
            }
        }
    }

    private func suggestionList(_ contacts: [MailContact], field: Field) -> some View {
        VStack(spacing: 0) {
            ForEach(contacts) { contact in
                Divider().padding(.leading, 58)
                Button { select(contact, for: field) } label: {
                    HStack(spacing: 12) {
                        MonogramAvatar(name: contact.label, address: contact.address,
                                       avatarColor: contact.avatarColor, size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(contact.label).lineLimit(1)
                            if contact.displayName != nil {
                                Text(contact.address).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: MailDesign.minimumHitTarget + 8)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Adds this recipient")
            }
        }
        .background(.background.secondary)
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    HStack(spacing: 8) {
                        Image(systemName: "doc").foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(attachment.filename).font(.subheadline).lineLimit(1)
                            Text(Int64(attachment.size).formatted(.byteCount(style: .file)))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: 160, alignment: .leading)
                        Button("Remove \(attachment.filename)", systemImage: "xmark.circle.fill") {
                            attachments.removeAll { $0.id == attachment.id }
                        }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .buttonStyle(.plain)
                        .frame(minWidth: 32, minHeight: MailDesign.minimumHitTarget)
                        .contentShape(.rect)
                    }
                    .padding(.leading, 12)
                    .padding(.trailing, 4)
                    .background(.fill.tertiary, in: .rect(cornerRadius: MailDesign.chipCornerRadius, style: .continuous))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Logic

    private func contactSuggestions(for value: String) -> [MailContact] {
        let fragment = RecipientParser.activeFragment(value)
        guard !fragment.isEmpty else { return [] }
        let selected = Set((RecipientParser.addresses(to) + RecipientParser.addresses(cc) + RecipientParser.addresses(bcc)))
        return Array(store.contacts.lazy
            .filter { !selected.contains($0.address.lowercased()) && $0.matches(fragment) }
            .prefix(5))
    }

    private func select(_ contact: MailContact, for field: Field) {
        switch field {
        case .to: to = RecipientParser.replacingActiveFragment(in: to, with: contact.address)
        case .cc: cc = RecipientParser.replacingActiveFragment(in: cc, with: contact.address)
        case .bcc: bcc = RecipientParser.replacingActiveFragment(in: bcc, with: contact.address)
        default: break
        }
        suppressSuggestions = true
    }

    private func applyRecipients() -> Bool {
        if let error = RecipientParser.validationError(to: to, cc: cc, bcc: bcc) {
            show(error.title, error.message)
            return false
        }
        draft.to = RecipientParser.addresses(to)
        draft.cc = RecipientParser.addresses(cc)
        draft.bcc = RecipientParser.addresses(bcc)
        return true
    }

    private func show(_ title: String, _ message: String) {
        errorTitle = title
        errorMessage = message
    }

    private func send() async {
        guard applyRecipients() else { return }
        sending = true
        defer { sending = false }
        do {
            try await store.send(draft, attachments: attachments)
            dismiss()
        } catch {
            show("Couldn’t Send Message", error.localizedDescription)
        }
    }

    private func saveAndDismiss() async {
        guard applyRecipients() else { return }
        draft.localAttachments = attachments.isEmpty ? nil : attachments
        do {
            _ = try await store.saveDraft(draft)
            dismiss()
        } catch {
            show("Couldn’t Save Draft", error.localizedDescription)
        }
    }

    private func importFiles(_ urls: [URL]) {
        for url in urls.prefix(max(0, 10 - attachments.count)) {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                show("Couldn’t Attach File", "“\(url.lastPathComponent)” couldn’t be read.")
                continue
            }
            let total = attachments.reduce(0) { $0 + $1.size } + data.count
            guard total <= OutboundAttachment.sendingBudget else {
                show("Attachment Too Large", "Attachments can total at most \(Int64(OutboundAttachment.sendingBudget).formatted(.byteCount(style: .file))) per message.")
                continue
            }
            let contentType = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)?.preferredMIMEType
                ?? "application/octet-stream"
            attachments.append(OutboundAttachment(filename: url.lastPathComponent, contentType: contentType,
                                                  data: data.base64EncodedString(), size: data.count))
        }
    }
}
