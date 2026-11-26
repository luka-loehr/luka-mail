import SwiftUI

@main
struct LukaMailMacApp: App {
    @State private var store = MailStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        Window("lmail", id: "main") {
            MacRootView()
                .environment(store)
                .task { await store.bootstrap() }
                .task(id: "\(store.configured)-\(scenePhase)") {
                    guard store.configured, scenePhase == .active else { return }
                    await store.watchMailboxChanges()
                }
        }
        .defaultSize(width: 1_180, height: 760)
        .windowResizability(.contentMinSize)
        .commands {
            MacMailCommands()
        }

        WindowGroup("New Message", for: Draft.self) { $draft in
            if let draft {
                MacComposeView(initialDraft: draft)
                    .environment(store)
            }
        }
        .defaultSize(width: 720, height: 640)
        .windowResizability(.contentMinSize)

        Settings {
            MacSettingsView()
                .environment(store)
        }
    }
}

/// Actions the menu bar can perform on the focused main window.
struct MacMailCommandActions {
    var compose: () -> Void
    var focusSearch: () -> Void
    var refresh: () -> Void
    var showMailbox: (Mailbox) -> Void
    var reply: (() -> Void)? = nil
    var replyAll: (() -> Void)? = nil
    var forward: (() -> Void)? = nil
    var archive: (() -> Void)? = nil
    var moveToInbox: (() -> Void)? = nil
    var moveToTrash: (() -> Void)? = nil
    var toggleRead: (() -> Void)? = nil
    var toggleStar: (() -> Void)? = nil
    var isUnread = false
    var isStarred = false
}

extension FocusedValues {
    @Entry var mailCommandActions: MacMailCommandActions?
}

struct MacMailCommands: Commands {
    @FocusedValue(\.mailCommandActions) private var actions

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Message") { actions?.compose() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(actions == nil)
        }

        CommandGroup(after: .textEditing) {
            Divider()
            Button("Find Mail") { actions?.focusSearch() }
                .keyboardShortcut("f", modifiers: [.command, .option])
                .disabled(actions == nil)
        }

        CommandMenu("Mailbox") {
            Button("Get New Mail") { actions?.refresh() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(actions == nil)
            Divider()
            ForEach(Array(Mailbox.allCases.enumerated()), id: \.element) { index, mailbox in
                Button("Go to \(mailbox.title)") { actions?.showMailbox(mailbox) }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                    .disabled(actions == nil)
            }
        }

        CommandMenu("Message") {
            Button("Reply") { actions?.reply?() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(actions?.reply == nil)
            Button("Reply All") { actions?.replyAll?() }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(actions?.replyAll == nil)
            Button("Forward") { actions?.forward?() }
                .keyboardShortcut("f", modifiers: [.command, .shift])
                .disabled(actions?.forward == nil)
            Divider()
            Button(actions?.isUnread == true ? "Mark as Read" : "Mark as Unread") { actions?.toggleRead?() }
                .keyboardShortcut("u", modifiers: [.command, .shift])
                .disabled(actions?.toggleRead == nil)
            Button(actions?.isStarred == true ? "Remove Star" : "Star") { actions?.toggleStar?() }
                .keyboardShortcut("l", modifiers: [.command, .shift])
                .disabled(actions?.toggleStar == nil)
            Divider()
            Button("Archive") { actions?.archive?() }
                .keyboardShortcut("a", modifiers: [.command, .control])
                .disabled(actions?.archive == nil)
            Button("Move to Inbox") { actions?.moveToInbox?() }
                .disabled(actions?.moveToInbox == nil)
            Button("Move to Trash") { actions?.moveToTrash?() }
                .keyboardShortcut(.delete, modifiers: .command)
                .disabled(actions?.moveToTrash == nil)
        }
    }
}
