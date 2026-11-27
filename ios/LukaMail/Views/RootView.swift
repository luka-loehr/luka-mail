import SwiftUI

enum AppTab: String, Hashable {
    case inbox, starred, sent, search
}

/// A destination pushed onto a tab's navigation stack.
enum MailRoute: Hashable {
    case message(String)
    case mailbox(Mailbox)
}

/// Pushes a route onto the navigation stack of the tab that provides it.
struct OpenMailRouteAction {
    let handler: (MailRoute) -> Void
    func callAsFunction(_ route: MailRoute) { handler(route) }
}

struct ShowSettingsAction {
    let handler: () -> Void
    func callAsFunction() { handler() }
}

extension EnvironmentValues {
    @Entry var openMailRoute = OpenMailRouteAction { _ in }
    @Entry var showSettings = ShowSettingsAction {}
}

struct RootView: View {
    @Environment(MailStore.self) private var store
    @SceneStorage("selectedTab.v3") private var tab: AppTab = .inbox
    @State private var inboxPath: [MailRoute] = []
    @State private var composeDraft: Draft?

    var body: some View {
        Group {
            switch store.startupPresentation {
            case .mailbox: tabs
            case .signedOut: WelcomeView()
            case .restoringSession: SessionRestoringView()
            }
        }
        .environment(\.composeMessage, ComposeMessageAction { composeDraft = $0 })
        .sheet(item: $composeDraft) { draft in ComposeView(initialDraft: draft) }
        .alert(store.errorTitle, isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.clearError() } })) {
            Button("OK") { store.clearError() }
        } message: {
            Text(store.errorMessage ?? "")
        }
        .onChange(of: store.pendingNotificationTarget) { _, target in
            if let target { open(target) }
        }
        .onAppear {
            if let target = store.pendingNotificationTarget { open(target) }
        }
        .task(id: store.configured) {
            guard store.configured else { return }
            if let value = DemoLaunch.string("DemoTab"), let demoTab = AppTab(rawValue: value) { tab = demoTab }
            if let id = DemoLaunch.string("DemoMessage") { tab = .inbox; inboxPath = [.message(id)] }
            switch DemoLaunch.string("DemoSheet") {
            case "compose": composeDraft = .compose(from: store.selectedInbox)
            case "reply":
                composeDraft = Draft(id: nil, from: store.selectedInbox, replyToMessageId: "plain", to: ["sam@example.com"],
                                     cc: [], bcc: [], subject: "Re: Server move this weekend", text: "Perfect, see you then!",
                                     updatedAt: nil)
            default: break
            }
        }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("Inbox", systemImage: Mailbox.inbox.symbolName, value: AppTab.inbox) {
                MailboxTab(mailbox: .inbox, path: $inboxPath)
            }
            .badge(store.summary?.unread ?? 0)

            Tab("Starred", systemImage: Mailbox.starred.symbolName, value: AppTab.starred) {
                MailboxTab(mailbox: .starred)
            }

            Tab("Sent", systemImage: Mailbox.sent.symbolName, value: AppTab.sent) {
                MailboxTab(mailbox: .sent)
            }

            Tab(value: AppTab.search, role: .search) {
                SearchTab()
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewSearchActivation(.searchTabSelection)
        .tabViewStyle(.sidebarAdaptable)
    }

    private func open(_ target: MailNotificationTarget) {
        tab = .inbox
        inboxPath = [.message(target.messageID)]
        store.consumeNotification(target)
    }
}

/// Resolves pushed routes for every tab's navigation stack.
struct MailRouteDestination: View {
    let route: MailRoute

    var body: some View {
        switch route {
        case .message(let id): MessageDetailView(messageID: id)
        case .mailbox(.drafts): DraftsScreen()
        case .mailbox(let mailbox): MailboxScreen(mailbox: mailbox)
        }
    }
}

/// A tab showing one mailbox at the root of its own navigation stack.
private struct MailboxTab: View {
    let mailbox: Mailbox
    private let externalPath: Binding<[MailRoute]>?
    @State private var localPath: [MailRoute] = []
    @State private var showSettings = false

    init(mailbox: Mailbox, path: Binding<[MailRoute]>? = nil) {
        self.mailbox = mailbox
        externalPath = path
    }

    var body: some View {
        let path = externalPath ?? $localPath
        NavigationStack(path: path) {
            MailboxScreen(mailbox: mailbox, showsAccountMenu: true)
                .navigationDestination(for: MailRoute.self) { MailRouteDestination(route: $0) }
        }
        .environment(\.openMailRoute, OpenMailRouteAction { path.wrappedValue.append($0) })
        .environment(\.showSettings, ShowSettingsAction { showSettings = true })
        .sheet(isPresented: $showSettings) { SettingsView() }
        .onAppear {
            guard mailbox == .inbox else { return }
            if let value = DemoLaunch.string("DemoMailbox"), let demo = Mailbox(rawValue: value) { path.wrappedValue = [.mailbox(demo)] }
            if ["settings", "contacts", "contact"].contains(DemoLaunch.string("DemoSheet")) { showSettings = true }
        }
    }
}

/// Shown while the saved session is restored; mirrors the first screen instead of a splash.
private struct SessionRestoringView: View {
    var body: some View {
        ProgressView()
            .controlSize(.large)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
            .accessibilityLabel("Opening lmail")
    }
}

private struct WelcomeView: View {
    @Environment(MailStore.self) private var store
    @ScaledMetric(relativeTo: .largeTitle) private var symbolSize: CGFloat = 64
    @State private var serverAddress = ServerEndpoint.saved().map { ServerEndpoint.displayHost(for: $0.absoluteString) } ?? ""
    @State private var authenticating = false
    @State private var enteringDemo = false
    @State private var localError: String?

    private var normalizedServer: URL? { ServerEndpoint.normalize(serverAddress) }

    var body: some View {
        ScrollView {
            VStack(spacing: 36) {
                VStack(spacing: 16) {
                    Image(systemName: "envelope.badge.shield.half.filled")
                        .font(.system(size: symbolSize))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    Text("Welcome to lmail")
                        .font(.largeTitle.bold())
                        .multilineTextAlignment(.center)
                }

                VStack(alignment: .leading, spacing: 24) {
                    feature("person.badge.key", "Sign In with a Passkey",
                            "Confirm with Face ID, Touch ID, or your device passcode. There’s no password to remember.")
                    feature("lock.shield", "Private by Design",
                            "Your session is stored in this device’s Keychain, and remote images stay blocked until you allow them.")
                    feature("clock.badge.checkmark", "Stay Signed In",
                            "Your session lasts 30 days, so lmail opens straight to your inbox.")
                }
            }
            .padding(.horizontal, 32)
            .padding(.top, 56)
            .padding(.bottom, 24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaBar(edge: .bottom) {
            VStack(spacing: 12) {
                if let localError {
                    Label(localError, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                HStack(spacing: 10) {
                    Image(systemName: "globe")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    TextField("mail.example.com", text: $serverAddress)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.continue)
                        .disabled(authenticating || enteringDemo)
                        .onSubmit {
                            guard normalizedServer != nil else { return }
                            Task { await signIn() }
                        }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(.fill.tertiary, in: .rect(cornerRadius: 12))

                Button {
                    Task { await signIn() }
                } label: {
                    HStack(spacing: 8) {
                        if authenticating { ProgressView() }
                        Text(authenticating ? "Signing In…" : "Continue with Passkey")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .disabled(authenticating || enteringDemo || normalizedServer == nil)

                Button {
                    Task { await startDemo() }
                } label: {
                    HStack(spacing: 8) {
                        if enteringDemo { ProgressView() }
                        Text(enteringDemo ? "Opening Demo…" : "Try Demo Mailbox")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .disabled(authenticating || enteringDemo)

                Group {
                    if let endpoint = normalizedServer {
                        Text("You’ll confirm your passkey on \(ServerEndpoint.displayHost(for: endpoint.absoluteString)).")
                    } else {
                        Text("Enter your lmail server address to sign in, or explore the demo mailbox.")
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }
            .frame(maxWidth: 480)
            .padding(.horizontal, 24)
            .padding(.bottom, 8)
        }
    }

    private func feature(_ symbol: String, _ title: LocalizedStringKey, _ detail: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private func signIn() async {
        authenticating = true
        localError = nil
        defer { authenticating = false }
        do {
            try await store.signIn(serverAddress: serverAddress, platform: .ios)
        } catch NativeAuthError.cancelled {
            // Cancelling the system sign-in sheet is an intentional exit.
        } catch {
            localError = error.localizedDescription
        }
    }

    private func startDemo() async {
        enteringDemo = true
        localError = nil
        defer { enteringDemo = false }
        await store.enterDemoMode()
    }
}
