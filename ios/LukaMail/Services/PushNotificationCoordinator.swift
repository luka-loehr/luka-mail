#if os(iOS)
import Observation
import UIKit
@preconcurrency import UserNotifications

@MainActor
@Observable
final class PushNotificationCoordinator {
    static let shared = PushNotificationCoordinator()

    private(set) var deviceToken: String?
    private(set) var target: MailNotificationTarget?
    private(set) var authorizationDenied = false

    #if DEBUG
    static let environment = "development"
    #else
    static let environment = "production"
    #endif

    private init() {}

    func requestAuthorizationAndRegistration() async {
        do {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            let authorized: Bool
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                authorized = true
            case .notDetermined:
                authorized = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            case .denied:
                authorized = false
            @unknown default:
                authorized = false
            }
            authorizationDenied = !authorized
            if authorized { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            authorizationDenied = true
        }
    }

    func received(deviceToken data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
    }

    func receivedRegistrationError() {
        deviceToken = nil
    }

    func received(userInfo: [AnyHashable: Any]) {
        guard let target = Self.target(from: userInfo) else { return }
        self.target = target
    }

    /// Notification response delegates can be invoked while UIKit is restoring a
    /// scene. Deferring the observable state mutation until the scene is active
    /// avoids modifying application state inside that restoration transaction.
    func restorePendingTap() {
        guard let target = PendingNotificationTap.take() else { return }
        self.target = target
    }

    func consume(_ consumed: MailNotificationTarget) {
        if target == consumed { target = nil }
    }

    nonisolated static func target(from userInfo: [AnyHashable: Any]) -> MailNotificationTarget? {
        guard let messageID = userInfo["messageId"] as? String,
              let identity = userInfo["identity"] as? String,
              !messageID.isEmpty, !identity.isEmpty else { return nil }
        return MailNotificationTarget(messageID: messageID, identity: identity)
    }
}

private enum PendingNotificationTap {
    private static let messageIDKey = "pendingPushNotificationMessageID"
    private static let identityKey = "pendingPushNotificationIdentity"

    static func store(_ target: MailNotificationTarget) {
        UserDefaults.standard.set(target.messageID, forKey: messageIDKey)
        UserDefaults.standard.set(target.identity, forKey: identityKey)
    }

    static func take() -> MailNotificationTarget? {
        defer {
            UserDefaults.standard.removeObject(forKey: messageIDKey)
            UserDefaults.standard.removeObject(forKey: identityKey)
        }
        guard let messageID = UserDefaults.standard.string(forKey: messageIDKey),
              let identity = UserDefaults.standard.string(forKey: identityKey),
              !messageID.isEmpty, !identity.isEmpty else { return nil }
        return MailNotificationTarget(messageID: messageID, identity: identity)
    }
}

@MainActor
final class LukaMailAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotificationCoordinator.shared.received(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushNotificationCoordinator.shared.receivedRegistrationError()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        guard let target = PushNotificationCoordinator.target(from: userInfo) else { return }
        // UIKit invokes this callback during scene restoration for a notification
        // launch. Do not hop to the main actor or touch UIKit/SwiftUI here: doing
        // so mutates the state-restoration transaction and UIKit aborts the app.
        // The active SwiftUI scene drains this persisted payload shortly after it
        // becomes active.
        PendingNotificationTap.store(target)
    }
}
#endif
