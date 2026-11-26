import SwiftUI

@main
struct LukaMailApp: App {
    @UIApplicationDelegateAdaptor(LukaMailAppDelegate.self) private var appDelegate
    @State private var store: MailStore
    @State private var agent: AgentStore
    @State private var pushNotifications = PushNotificationCoordinator.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let store = MailStore()
        _store = State(initialValue: store)
        _agent = State(initialValue: AgentStore(mail: store))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(agent)
                .task { await store.bootstrap() }
                .task(id: "\(store.configured)-\(scenePhase)") {
                    guard store.configured, scenePhase == .active else { return }
                    await store.watchMailboxChanges()
                }
                .task(id: "push-permission-\(store.configured)-\(store.isDemoMode)") {
                    guard store.configured, !store.isDemoMode else { return }
                    await pushNotifications.requestAuthorizationAndRegistration()
                }
                .task(id: "push-tap-drain-\(store.configured)-\(scenePhase)") {
                    guard store.configured, scenePhase == .active else { return }
                    // The app delegate only persists notification responses. Drain
                    // them from a fully active SwiftUI scene, including banner taps
                    // while the app is already foregrounded.
                    while !Task.isCancelled {
                        pushNotifications.restorePendingTap()
                        try? await Task.sleep(for: .seconds(1))
                    }
                }
                .task(id: "push-token-\(store.configured)-\(scenePhase)-\(pushNotifications.deviceToken ?? "")-\(store.identities.map(\.address).joined(separator: ","))") {
                    guard store.configured, scenePhase == .active,
                          let token = pushNotifications.deviceToken else { return }
                    await store.registerPushDevice(token: token, environment: PushNotificationCoordinator.environment)
                }
                .task(id: "push-target-\(store.configured)-\(pushNotifications.target?.messageID ?? "")") {
                    guard store.configured, let target = pushNotifications.target else { return }
                    if await store.openNotification(target) { pushNotifications.consume(target) }
                }
        }
    }
}
