import SwiftUI

/// The dedicated search tab. The scope bar picks the mailbox to search.
struct SearchTab: View {
    @Environment(MailStore.self) private var store
    @State private var path: [MailRoute] = []
    @State private var query = DemoLaunch.string("DemoSearch") ?? ""
    @State private var scope: Mailbox = .inbox

    private static let scopes: [Mailbox] = [.inbox, .starred, .sent, .archive, .trash]

    private var term: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isCurrent: Bool { !term.isEmpty && store.mailbox == scope && store.search == term }
    private var results: [MailMessage] { isCurrent ? store.messages : [] }

    private struct SearchKey: Hashable {
        let term: String
        let scope: Mailbox
        let identity: String
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if term.isEmpty {
                    ContentUnavailableView {
                        Label("Search Mail", systemImage: "magnifyingglass")
                    } description: {
                        Text("Find messages by sender, subject, or text. Choose a mailbox to search above the results.")
                    }
                } else if results.isEmpty, !isCurrent || store.loading {
                    ProgressView()
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: term)
                } else {
                    List(results) { message in
                        NavigationLink(value: MailRoute.message(message.id)) {
                            MessageRow(message: message)
                        }
                        .contextMenu { MessageContextMenu(message: message, mailbox: scope) }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Search")
            .navigationDestination(for: MailRoute.self) { MailRouteDestination(route: $0) }
        }
        .searchable(text: $query, prompt: "Sender, Subject, or Text")
        .searchScopes($scope, activation: .onSearchPresentation) {
            ForEach(Self.scopes) { mailbox in
                Text(mailbox.title).tag(mailbox)
            }
        }
        .task(id: SearchKey(term: term, scope: scope, identity: store.selectedInbox)) {
            guard !term.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await store.refresh(mailbox: scope, query: term)
        }
    }
}
