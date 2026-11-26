import AppKit
import SwiftUI

struct MacRootView: View {
    @Environment(MailStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    @State private var selectedMailbox: Mailbox = .inbox
    @State private var selectedMessageID: String?
    @State private var search = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        Group {
            switch store.startupPresentation {
            case .mailbox: mailboxWindow
            case .signedOut: MacWelcomeView()
            case .restoringSession:
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Opening lmail")
            }
        }
        .frame(minWidth: 900, minHeight: 560)
        .environment(\.composeMessage, ComposeMessageAction { openWindow(value: $0) })
        .focusedSceneValue(\.mailCommandActions, store.configured ? commandActions : nil)
        .alert(store.errorTitle, isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.clearError() } }
        )) {
            Button("OK") { store.clearError() }
        } message: {
            Text(store.errorMessage ?? "")
        }
        .onChange(of: selectedMailbox) { _, _ in
            selectedMessageID = nil
            search = ""
        }
        .onChange(of: store.selectedInbox) { _, _ in selectedMessageID = nil }
        .onChange(of: store.messages.map(\.id)) { _, ids in
            guard let selectedMessageID, !ids.contains(selectedMessageID) else { return }
            self.selectedMessageID = nil
        }
        .onAppear {
            if let appearance = DemoLaunch.string("DemoAppearance") {
                NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
            }
        }
        .task(id: store.configured) {
            guard store.configured else { return }
            if let value = DemoLaunch.string("DemoMailbox"), let mailbox = Mailbox(rawValue: value) { selectedMailbox = mailbox }
            if let id = DemoLaunch.string("DemoMessage") {
                try? await Task.sleep(for: .milliseconds(300))
                selectedMessageID = id
            }
            switch DemoLaunch.string("DemoSheet") {
            case "compose": compose()
            case "settings": openSettings()
            default: break
            }
        }
    }

    private var mailboxWindow: some View {
        NavigationSplitView {
            MacMailboxSidebar(selection: $selectedMailbox)
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 280)
        } content: {
            MacMessageList(mailbox: selectedMailbox, selection: $selectedMessageID, search: search)
                .navigationSplitViewColumnWidth(min: 300, ideal: 370, max: 520)
                .toolbar {
                    ToolbarItemGroup(placement: .navigation) {
                        Button("Get New Mail", systemImage: "arrow.clockwise") {
                            Task { await store.refresh(mailbox: selectedMailbox, query: search) }
                        }
                        .help("Get New Mail")
                        Button("New Message", systemImage: "square.and.pencil", action: compose)
                            .help("New Message")
                    }
                }
        } detail: {
            if let selectedMessageID {
                MacMessageDetailView(messageID: selectedMessageID)
                    .id(selectedMessageID)
            } else {
                ContentUnavailableView {
                    Label(selectedMailbox == .drafts ? "No Draft Selected" : "No Message Selected",
                          systemImage: selectedMailbox == .drafts ? "doc" : "envelope")
                } description: {
                    Text(selectedMailbox == .drafts ? "Double-click a draft to continue writing." : "Select a message to read it.")
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .searchable(text: $search, placement: .toolbar, prompt: "Search \(selectedMailbox.title)")
        .searchFocused($searchFocused)
        .toolbar { messageToolbar }
    }

    // MARK: Message toolbar

    @ToolbarContentBuilder
    private var messageToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if selectedMailbox == .archive || selectedMailbox == .trash {
                Button("Move to Inbox", systemImage: "tray.and.arrow.down") { Task { await moveSelected(to: "inbox") } }
                    .help("Move to Inbox")
                    .disabled(selectedMessage == nil)
            } else {
                Button("Archive", systemImage: "archivebox") { Task { await moveSelected(to: "archive") } }
                    .help("Archive")
                    .disabled(selectedMessage == nil)
            }
            Button("Move to Trash", systemImage: "trash") { Task { await moveSelected(to: "trash") } }
                .help("Move to Trash")
                .disabled(selectedMessage == nil || selectedMailbox == .trash)
        }
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItemGroup(placement: .primaryAction) {
            Button("Reply", systemImage: "arrowshape.turn.up.left") { reply() }
                .help("Reply")
                .disabled(selectedDetail == nil)
            Button("Reply All", systemImage: "arrowshape.turn.up.left.2") { replyAll() }
                .help("Reply All")
                .disabled(selectedDetail == nil)
            Button("Forward", systemImage: "arrowshape.turn.up.right") { forward() }
                .help("Forward")
                .disabled(selectedDetail == nil)
        }
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) {
            Button(selectedMessage?.starred == true ? "Remove Star" : "Star",
                   systemImage: selectedMessage?.starred == true ? "star.fill" : "star") {
                Task { await toggleStarSelected() }
            }
            .help(selectedMessage?.starred == true ? "Remove Star" : "Star")
            .disabled(selectedMessage == nil)
        }
    }

    private var commandActions: MacMailCommandActions {
        let hasMessage = selectedMessage != nil
        let hasDetail = selectedDetail != nil
        let canArchive = hasMessage && selectedMailbox != .archive && selectedMailbox != .trash
        let canRestore = hasMessage && (selectedMailbox == .archive || selectedMailbox == .trash)
        let canTrash = hasMessage && selectedMailbox != .trash
        var actions = MacMailCommandActions(
            compose: compose,
            focusSearch: { searchFocused = true },
            refresh: { Task { await store.refresh(mailbox: selectedMailbox, query: search) } },
            showMailbox: { selectedMailbox = $0 }
        )
        if hasDetail {
            actions.reply = reply
            actions.replyAll = replyAll
            actions.forward = forward
        }
        if canArchive { actions.archive = { Task { await moveSelected(to: "archive") } } }
        if canRestore { actions.moveToInbox = { Task { await moveSelected(to: "inbox") } } }
        if canTrash { actions.moveToTrash = { Task { await moveSelected(to: "trash") } } }
        if hasMessage {
            actions.toggleRead = { Task { await toggleReadSelected() } }
            actions.toggleStar = { Task { await toggleStarSelected() } }
        }
        actions.isUnread = selectedMessage?.unread ?? false
        actions.isStarred = selectedMessage?.starred ?? false
        return actions
    }

    private var selectedMessage: MailMessage? {
        guard let selectedMessageID else { return nil }
        return store.messages.first { $0.id == selectedMessageID }
    }

    private var selectedDetail: MailDetail? {
        guard let detail = store.detail, detail.id == selectedMessageID else { return nil }
        return detail
    }

    private func compose() {
        openWindow(value: Draft.compose(from: store.selectedInbox))
    }

    private func reply() {
        guard let detail = selectedDetail else { return }
        openWindow(value: Draft.reply(to: detail, from: store.selectedInbox))
    }

    private func replyAll() {
        guard let detail = selectedDetail else { return }
        openWindow(value: Draft.replyAll(to: detail, from: store.selectedInbox, ownAddresses: Set(store.identities.map(\.address))))
    }

    private func forward() {
        guard let detail = selectedDetail else { return }
        openWindow(value: Draft.forward(detail, from: store.selectedInbox))
    }

    private func moveSelected(to folder: String) async {
        guard let id = selectedMessageID else { return }
        if await store.update(id: id, update: MessageUpdate(folder: folder), removeFromCurrentList: true) {
            selectedMessageID = nil
        }
    }

    private func toggleReadSelected() async {
        guard let message = selectedMessage else { return }
        await store.update(id: message.id, update: MessageUpdate(unread: !message.unread))
    }

    private func toggleStarSelected() async {
        guard let message = selectedMessage else { return }
        await store.update(id: message.id, update: MessageUpdate(starred: !message.starred))
    }
}

private struct MacWelcomeView: View {
    @Environment(MailStore.self) private var store
    @State private var serverAddress = ServerEndpoint.saved().map { ServerEndpoint.displayHost(for: $0.absoluteString) } ?? ""
    @State private var signingIn = false
    @State private var enteringDemo = false
    @State private var errorMessage: String?

    private var normalizedServer: URL? { ServerEndpoint.normalize(serverAddress) }

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 12) {
                Image(systemName: "envelope.badge.shield.half.filled")
                    .font(.system(size: 56))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text("Welcome to lmail")
                    .font(.largeTitle.bold())
                Text("Connect to your self-hosted lmail server.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 14) {
                feature("person.badge.key", "Sign in with a passkey. There’s no password to remember.")
                feature("lock.shield", "Your 30-day session is stored in your Keychain.")
                feature("eye.slash", "Remote images stay blocked until you allow them.")
            }

            VStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Server Address")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                    TextField("mail.example.com", text: $serverAddress)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.large)
                        .disabled(signingIn || enteringDemo)
                        .onSubmit {
                            guard normalizedServer != nil else { return }
                            Task { await signIn() }
                        }
                }
                .frame(width: 320)

                Button {
                    Task { await signIn() }
                } label: {
                    HStack(spacing: 8) {
                        if signingIn { ProgressView().controlSize(.small) }
                        Text(signingIn ? "Waiting for Passkey…" : "Continue with Passkey")
                    }
                    .frame(minWidth: 220)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.extraLarge)
                .keyboardShortcut(.defaultAction)
                .disabled(signingIn || enteringDemo || normalizedServer == nil)

                Button {
                    Task { await startDemo() }
                } label: {
                    HStack(spacing: 8) {
                        if enteringDemo { ProgressView().controlSize(.small) }
                        Text(enteringDemo ? "Opening Demo…" : "Try Demo Mailbox")
                    }
                    .frame(minWidth: 220)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(signingIn || enteringDemo)

                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 420)
                }
            }
        }
        .padding(48)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func feature(_ symbol: String, _ text: LocalizedStringKey) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol).foregroundStyle(.tint)
        }
        .font(.body)
    }

    private func signIn() async {
        signingIn = true
        errorMessage = nil
        defer { signingIn = false }
        do {
            try await store.signIn(serverAddress: serverAddress, platform: .macos)
        } catch {
            if let authError = error as? NativeAuthError, case .cancelled = authError { return }
            errorMessage = error.localizedDescription
        }
    }

    private func startDemo() async {
        enteringDemo = true
        errorMessage = nil
        defer { enteringDemo = false }
        await store.enterDemoMode()
    }
}
