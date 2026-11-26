import SwiftUI

/// An email the agent proposed, as an editable card. Edits are saved as you
/// type; sending always asks for confirmation first, and the agent itself
/// has no way to send.
struct AgentDraftCard: View {
    @Environment(MailStore.self) private var mail
    @Environment(AgentStore.self) private var agent
    @Environment(\.composeMessage) private var composeMessage
    let draft: AgentDraft
    var showsRevisions = true

    @State private var to: String
    @State private var cc: String
    @State private var subject: String
    @State private var bodyText: String
    @State private var showsCc: Bool
    @State private var confirmsSend = false
    @State private var sendError: String?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case to, cc, subject, body }

    init(draft: AgentDraft, showsRevisions: Bool = true) {
        self.draft = draft
        self.showsRevisions = showsRevisions
        _to = State(initialValue: draft.to.joined(separator: ", "))
        _cc = State(initialValue: draft.cc.joined(separator: ", "))
        _subject = State(initialValue: draft.subject)
        _bodyText = State(initialValue: draft.body)
        _showsCc = State(initialValue: !draft.cc.isEmpty)
    }

    private var sending: Bool { agent.sendingDraftIDs.contains(draft.id) }
    private var editable: Bool { draft.isEditable && !sending }
    private var recipients: [String] { RecipientParser.addresses(to) }
    private var canSend: Bool { editable && !recipients.isEmpty && !agent.streaming }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 10)
            Divider()
            fromRow
            Divider().padding(.leading, 16)
            field("To", text: $to, field: .to, keyboard: .emailAddress)
            if showsCc {
                Divider().padding(.leading, 16)
                field("Cc", text: $cc, field: .cc, keyboard: .emailAddress)
            }
            Divider().padding(.leading, 16)
            field("Subject", text: $subject, field: .subject, keyboard: .default)
            Divider()
            TextField("Message", text: $bodyText, axis: .vertical)
                .focused($focus, equals: .body)
                .lineLimit(3...)
                .font(.body)
                .disabled(!editable)
                .padding(16)
            if draft.isEditable {
                Divider()
                actions
                    .padding(12)
            }
        }
        .background(.background.secondary, in: .rect(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .strokeBorder(draft.status == .sent ? Color.green.opacity(0.45) : Color.primary.opacity(0.08), lineWidth: 1)
        }
        .opacity(draft.status == .discarded ? 0.55 : 1)
        .onChange(of: to) { save() }
        .onChange(of: cc) { save() }
        .onChange(of: subject) { save() }
        .onChange(of: bodyText) { save() }
        .alert("Send this email?", isPresented: $confirmsSend) {
            Button("Cancel", role: .cancel) {}
            Button("Send") { Task { await send() } }
                .keyboardShortcut(.defaultAction)
        } message: {
            Text("To \(recipients.joined(separator: ", "))\(cc.isEmpty ? "" : "\nCc \(RecipientParser.addresses(cc).joined(separator: ", "))")\n“\(subject.isEmpty ? "No Subject" : subject)”")
        }
        .alert("Couldn’t Send Email", isPresented: Binding(get: { sendError != nil }, set: { if !$0 { sendError = nil } })) {
            Button("OK") { sendError = nil }
        } message: {
            Text(sendError ?? "")
        }
        .onAppear {
            if DemoLaunch.string("DemoConfirm") == "send", draft.isEditable { confirmsSend = true }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: draft.status == .sent ? "checkmark.circle.fill" : "envelope.fill")
                .foregroundStyle(draft.status == .sent ? .green : .accentColor)
            Text(draft.replyToMessageId == nil ? "New Email" : "Reply")
                .font(.subheadline.weight(.semibold))
            Spacer(minLength: 8)
            statusBadge
            if draft.isEditable { moreMenu }
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch draft.status {
        case .sent:
            Text("Sent").font(.caption.weight(.semibold)).foregroundStyle(.green)
        case .discarded:
            Button("Discarded · Restore") { Task { await agent.restore(draft) } }
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderless)
        case .superseded:
            Text("Replaced").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        case .draft:
            if sending {
                ProgressView().controlSize(.small)
            } else {
                Text("Not sent").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var moreMenu: some View {
        Menu {
            Button("Open in Composer", systemImage: "square.and.pencil") {
                composeMessage(Draft(id: nil, from: draft.from, replyToMessageId: draft.replyToMessageId, to: recipients,
                                     cc: RecipientParser.addresses(cc), bcc: [], subject: subject, text: bodyText, updatedAt: nil))
            }
            Button("Copy Text", systemImage: "doc.on.doc") { UIPasteboard.general.string = bodyText }
            if !showsCc { Button("Add Cc", systemImage: "person.badge.plus") { showsCc = true; focus = .cc } }
            Divider()
            Button("Discard", systemImage: "trash", role: .destructive) { Task { await agent.discard(draft) } }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 28)
                .contentShape(.rect)
        }
        .accessibilityLabel("More")
    }

    private var fromRow: some View {
        HStack(spacing: 8) {
            Text("From").foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
            if editable, mail.identities.count > 1, draft.replyToMessageId == nil {
                Menu {
                    ForEach(mail.identities) { identity in
                        Button(identity.address) {
                            var changed = current
                            changed.from = identity.address
                            agent.edit(changed)
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(draft.from).lineLimit(1).truncationMode(.middle)
                        Image(systemName: "chevron.up.chevron.down").font(.caption2)
                    }
                    .foregroundStyle(.primary)
                }
            } else {
                Text(draft.from).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .font(.subheadline)
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
    }

    private func field(_ label: String, text: Binding<String>, field: Field, keyboard: UIKeyboardType) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
            TextField(label, text: text, axis: .vertical)
                .focused($focus, equals: field)
                .keyboardType(keyboard)
                .textInputAutocapitalization(field == .subject ? .sentences : .never)
                .autocorrectionDisabled(field != .subject)
                .disabled(!editable)
                .fontWeight(field == .subject ? .semibold : .regular)
        }
        .font(.subheadline)
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsRevisions {
                FlowLayout(spacing: 8) {
                    ForEach(Self.revisions(for: bodyText), id: \.label) { revision in
                        Button(revision.label) { revise(revision.instruction) }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                            .disabled(agent.streaming)
                    }
                }
            }
            Button {
                focus = nil
                confirmsSend = true
            } label: {
                Label(sending ? "Sending…" : "Send", systemImage: "paperplane.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(!canSend)
        }
    }

    private var current: AgentDraft {
        var edited = draft
        edited.to = RecipientParser.addresses(to)
        edited.cc = RecipientParser.addresses(cc)
        edited.subject = subject
        edited.body = bodyText
        return edited
    }

    private func save() {
        guard draft.isEditable, current != draft else { return }
        agent.edit(current)
    }

    private func revise(_ instruction: String) {
        save()
        agent.ask(instruction)
    }

    private func send() async {
        do {
            try await agent.sendDraft(current)
        } catch {
            sendError = error.localizedDescription
        }
    }

    /// One-tap revisions; the agent answers with a new version of the email.
    static func revisions(for body: String) -> [(label: String, instruction: String)] {
        let german = body.range(of: #"\b(und|ich|Sie|Grüße|bitte|danke)\b"#, options: .regularExpression) != nil
        return [
            ("Shorter", "Make this email shorter."),
            ("More formal", "Make this email more formal."),
            ("Friendlier", "Make this email warmer and friendlier."),
            german ? ("In English", "Rewrite this email in English.") : ("Auf Deutsch", "Schreib diese Mail auf Deutsch."),
        ]
    }
}

/// Lays its children out in rows, wrapping to the next row when one is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(for: subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(for: subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func rows(for subviews: Subviews, width: CGFloat) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (indices: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.indices.isEmpty {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.indices + [index], needed, max(current.height, size.height))
            }
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
