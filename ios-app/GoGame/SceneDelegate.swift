import UIKit

// Exists for one reason: a home-screen quick action is delivered to a
// scene delegate, and a SwiftUI app has none until you ask for one (see
// AppDelegate's configurationForConnecting).
//
// Asking for one replaces the delegate SwiftUI would otherwise install,
// so this also forwards the two things that delegate was carrying —
// opened URLs and the browsing activity a Universal Link arrives as.
// Handling them here rather than trusting .onOpenURL to still fire makes
// the path explicit, and routing the same URL twice is harmless: it sets
// the same target to the same value.
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    private var appDelegate: AppDelegate? {
        UIApplication.shared.delegate as? AppDelegate
    }

    // Cold launch: whatever started the app is in here, and all of it
    // arrives long before any view can act on it.
    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        if let shortcutItem = connectionOptions.shortcutItem {
            appDelegate?.handle(shortcutItem)
        }
        connectionOptions.userActivities.forEach(route)
        route(connectionOptions.urlContexts)
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        appDelegate?.handle(shortcutItem)
        completionHandler(true)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        route(userActivity)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        route(URLContexts)
    }

    private func route(_ userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL else { return }
        appDelegate?.handle(url)
    }

    private func route(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts {
            appDelegate?.handle(context.url)
        }
    }
}
