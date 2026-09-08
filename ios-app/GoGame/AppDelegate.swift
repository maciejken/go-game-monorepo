import UIKit
import UserNotifications

// SwiftUI's App protocol has no hooks for the remote-notification
// registration callbacks below — they're AppDelegate-only, hence this small
// adapter (wired in via @UIApplicationDelegateAdaptor in GoGame.swift).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
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

    // Without this, iOS silently swallows a notification's alert/sound
    // while the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }
}
