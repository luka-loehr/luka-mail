import SwiftUI

/// The Agent tab: chat with the mail agent about your mail. The app opens here.
struct AgentTab: View {
    @Environment(MailStore.self) private var store
    @Environment(AgentStore.self) private var agent
    @State private var path: [MailRoute] = []
    @State private var showsChats = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack(path: $path) {
            AgentChatScreen(showsChats: $showsChats)
                .navigationDestination(for: MailRoute.self) { MailRouteDestination(route: $0) }
        }
        .environment(\.openMailRoute, OpenMailRouteAction { path.append($0) })
        .environment(\.showSettings, { showSettings = true })
        .sheet(isPresented: $showsChats) { AgentChatsSheet() }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .task(id: store.configured) {
            guard store.configured else {
                agent.newChat()
                return
            }
            await agent.loadChats()
            if let id = DemoLaunch.string("DemoAgentChat") { await agent.open(chatID: id) }
            if DemoLaunch.string("DemoSheet") == "chats" { showsChats = true }
            if let prompt = DemoLaunch.string("DemoAgentAsk") { agent.ask(prompt) }
        }
    }
}

private struct AgentChatScreen: View {
    @Environment(AgentStore.self) private var agent
    @Binding var showsChats: Bool
    @State private var input = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if agent.isEmpty && !agent.loadingChat {
                    AgentEmptyState { prompt in send(prompt) }
                        .padding(.horizontal, 20)
                        .containerRelativeFrame(.vertical, alignment: .center)
                } else {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(agent.messages) { message in
                            AgentMessageRow(message: message, isLatest: message.id == agent.messages.last?.id)
                                .id(message.id)
                        }
                        Color.clear.frame(height: 1).id(bottomID)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 8)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
            }
            .overlay {
                if agent.loadingChat { ProgressView() }
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(DemoLaunch.string("DemoAgentAnchor") == "top" ? .top : .bottom)
            .onChange(of: agent.messages.count) {
                guard DemoLaunch.string("DemoAgentAnchor") != "top" else { return }
                withAnimation(.snappy) { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
            .onChange(of: agent.messages.last?.content.count) {
                guard agent.streaming else { return }
                proxy.scrollTo(bottomID, anchor: .bottom)
            }
        }
        .safeAreaBar(edge: .bottom) {
            AgentComposer(text: $input, focused: $composerFocused) { send(input) }
                .frame(maxWidth: 760)
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
        }
        .navigationTitle(agent.isEmpty ? "Agent" : agent.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Chats", systemImage: "line.3.horizontal") { showsChats = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("New Chat", systemImage: "square.and.pencil") {
                    agent.newChat()
                    composerFocused = true
                }
                .disabled(agent.isEmpty)
            }
        }
        .alert("Agent", isPresented: Binding(get: { agent.errorMessage != nil }, set: { if !$0 { agent.clearError() } })) {
            Button("OK") { agent.clearError() }
        } message: {
            Text(agent.errorMessage ?? "")
        }
    }

    private let bottomID = "agent-bottom"

    private func send(_ text: String) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !agent.streaming else { return }
        agent.ask(prompt)
        input = ""
    }
}

/// The message field: grows with the text, sends with the arrow, stops a running answer with the square.
private struct AgentComposer: View {
    @Environment(AgentStore.self) private var agent
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask about your mail", text: $text, axis: .vertical)
                .focused(focused)
                .lineLimit(1...6)
                .submitLabel(.send)
                .onSubmit { if canSend { onSend() } }
                .padding(.leading, 18)
                .padding(.vertical, 12)
            Group {
                if agent.streaming {
                    Button { agent.stop() } label: {
                        Image(systemName: "stop.fill")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(Color(uiColor: .label)))
                    }
                    .accessibilityLabel("Stop")
                } else {
                    Button(action: onSend) {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(canSend ? Color.accentColor : Color(uiColor: .systemGray3)))
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("Send")
                }
            }
            .padding(.trailing, 7)
            .padding(.bottom, 7)
            .animation(.snappy, value: agent.streaming)
        }
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
    }
}

/// The first screen of a new chat: what the agent can do, as one-tap prompts.
private struct AgentEmptyState: View {
    @Environment(MailStore.self) private var store
    let onPrompt: (String) -> Void

    private let suggestions: [(symbol: String, title: String, prompt: String)] = [
        ("tray.full", "What needs my reply?", "Which mails are waiting for my reply? Show the most important first."),
        ("sun.max", "Summarize today", "Summarize what came in today in a few bullet points."),
        ("calendar", "Upcoming schedule", "What events or deadlines are coming up this week?"),
        ("exclamationmark.triangle", "Anything urgent?", "Is there anything urgent in my inbox I should act on?"),
    ]

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.system(size: 40, weight: .medium))
                    .foregroundStyle(.tint)
                    .symbolEffect(.breathe, options: .nonRepeating)
                Text(greeting)
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Text("Ask about your mail, or have a reply written in your style. Nothing is sent until you tap Send.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 340)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(suggestions, id: \.title) { suggestion in
                    Button { onPrompt(suggestion.prompt) } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Image(systemName: suggestion.symbol)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.tint)
                            Text(suggestion.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.leading)
                        }
                        .frame(maxWidth: .infinity, minHeight: 64, alignment: .topLeading)
                        .padding(14)
                        .background(.fill.tertiary, in: .rect(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: 520)
        }
        .padding(.vertical, 24)
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: .now)
        let part = hour < 5 ? "Hi" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
        if let displayName = store.identities.first(where: { $0.address == store.selectedInbox })?.displayName,
           !displayName.contains("@"),
           let firstName = displayName.split(separator: " ").first,
           !firstName.isEmpty {
            return "\(part), \(firstName)"
        }
        return part
    }
}

/// Saved chats, newest first, grouped by day.
struct AgentChatsSheet: View {
    @Environment(AgentStore.self) private var agent
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filtered: [AgentChatSummary] {
        guard !query.isEmpty else { return agent.chats }
        return agent.chats.filter { $0.title.localizedStandardContains(query) || $0.preview.localizedStandardContains(query) }
    }

    private var sections: [(title: String, chats: [AgentChatSummary])] {
        let calendar = Calendar.current
        let groups = Dictionary(grouping: filtered) { chat -> Int in
            guard let date = chat.updatedDate else { return 3 }
            if calendar.isDateInToday(date) { return 0 }
            if calendar.isDateInYesterday(date) { return 1 }
            return date > .now.addingTimeInterval(-7 * 86_400) ? 2 : 3
        }
        let titles = ["Today", "Yesterday", "Previous 7 Days", "Earlier"]
        return groups.keys.sorted().map { (titles[$0], groups[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections, id: \.title) { section in
                    Section(section.title) {
                        ForEach(section.chats) { chat in
                            Button {
                                Task { await agent.open(chat) }
                                dismiss()
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(chat.title).font(.body.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                                    if !chat.preview.isEmpty {
                                        Text(chat.preview.replacingOccurrences(of: "*", with: ""))
                                            .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                            .tint(.primary)
                            .listRowBackground(chat.id == agent.chatID ? Color.accentColor.opacity(0.12) : nil)
                            .swipeActions {
                                Button("Delete", systemImage: "trash", role: .destructive) { Task { await agent.delete(chat) } }
                            }
                        }
                    }
                }
            }
            .overlay {
                if agent.chats.isEmpty && !agent.loadingChats {
                    ContentUnavailableView("No Chats Yet", systemImage: "bubble.left.and.text.bubble.right",
                                           description: Text("Your conversations with the agent appear here."))
                } else if filtered.isEmpty && !query.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .searchable(text: $query, prompt: "Search Chats")
            .refreshable { await agent.loadChats() }
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("New Chat", systemImage: "square.and.pencil") {
                        agent.newChat()
                        dismiss()
                    }
                }
            }
            .task { await agent.loadChats() }
        }
        .presentationDetents([.large])
    }
}
