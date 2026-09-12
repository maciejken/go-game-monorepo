import UIKit
import UserNotifications

// SwiftUI's App protocol has no hooks for the remote-notification
// registration callbacks below — they're AppDelegate-only, hence this small
// adapter (wired in via @UIApplicationDelegateAdaptor in GoGame.swift).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    // Set once by GoGame.swift's .onAppear. A notification tap on a cold
    // launch can be delivered to didReceive(response:) before that runs —
    // exactly the same "target might arrive before a consumer exists" case
    // DeepLinkRouter itself is built around — so a tap arriving that early
    // is buffered here and flushed the moment the router is actually set.
    var deepLinkRouter: DeepLinkRouter? {
        didSet {
            if let gameId = pendingGameId {
                deepLinkRouter?.targetGameId = gameId
                pendingGameId = nil
            }
        }
    }
    private var pendingGameId: String?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            try? await APIClient.registerDeviceToken(token)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Expected until the user's Apple Developer account + APNs
        // credentials exist (see server/src/apns.ts's isApnsConfigured) —
        // nothing actionable client-side, just don't crash or retry-loop.
        print("Remote notification registration failed: \(error)")
    }

    // This delegate method only ever fires while the app is actually
    // foregrounded and running — a backgrounded or killed app never reaches
    // this code at all, iOS presents the notification itself. Suppressing
    // it here means no banner/sound while foregrounded: the live socket
    // (LiveSocket.swift) already refreshes whatever's on screen in real
    // time, so a system notification on top of that would just be a
    // redundant, noisier version of an update the user is already seeing.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }

    // Fires when the user actually taps the notification (background,
    // foreground, or a cold launch — iOS delivers this once the delegate
    // above is set regardless of which). gameId is the custom payload data
    // server.ts's pushToUser attaches alongside aps.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let gameId = response.notification.request.content.userInfo["gameId"] as? String else {
            return
        }
        if let deepLinkRouter {
            deepLinkRouter.targetGameId = gameId
        } else {
            pendingGameId = gameId
        }
    }
}
