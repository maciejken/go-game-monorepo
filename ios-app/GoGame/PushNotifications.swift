import UIKit
import UserNotifications

// Called once the user is authenticated (see SessionStore). Best-effort:
// silently does nothing if the user declines the permission prompt, and the
// resulting device-token registration is itself a no-op server-side until
// APNs credentials are configured (server/src/apns.ts) — there's nothing
// meaningful to surface to the user either way, so failures are swallowed.
enum PushNotifications {
    static func requestAuthorizationAndRegister() {
        Task {
            // This fires right as SessionStore resolves its session check —
            // exactly when RootView is swapping to GameListView and its
            // NavigationStack is first mounting. Presenting the system
            // permission alert in that same moment can race the
            // NavigationStack's own initial setup (UIKit logs
            // "_applyViewControllers ... while an existing transition or
            // presentation is occurring; the navigation stack will not be
            // updated" and, worse, leaves it silently swallowing all touches
            // for the rest of the session). A short delay lets the initial
            // view hierarchy finish settling first.
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else { return }
            await MainActor.run {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
}
