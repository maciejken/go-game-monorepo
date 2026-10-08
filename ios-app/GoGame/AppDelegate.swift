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
            if let pendingAction {
                deepLinkRouter?.pendingAction = pendingAction
                self.pendingAction = nil
            }
            if let pendingURL {
                deepLinkRouter?.handle(pendingURL)
                self.pendingURL = nil
            }
        }
    }
    // SceneDelegate needs this object, and cannot find it the obvious
    // way: UIApplication.shared.delegate is not this instance. SwiftUI's
    // @UIApplicationDelegateAdaptor forwards the delegate callbacks here
    // while something of its own answers as the application's delegate,
    // so the usual `as? AppDelegate` cast quietly yields nil — which is
    // what made a quick action arrive and go nowhere.
    static private(set) weak var shared: AppDelegate?

    private var pendingGameId: String?
    private var pendingAction: DeepLinkRouter.QuickAction?
    private var pendingURL: URL?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Self.shared = self
        UNUserNotificationCenter.current().delegate = self
        // Built here rather than declared in Info.plist so the titles come
        // from the string catalogue like every other piece of text in the
        // app — static shortcut items are only translatable through
        // InfoPlist.strings, which nothing else here uses. The cost is
        // that they appear after the first launch rather than straight
        // after installing.
        application.shortcutItems = [
            UIApplicationShortcutItem(
                type: DeepLinkRouter.QuickAction.newGame.rawValue,
                localizedTitle: String(localized: "New game"),
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "plus")
            ),
            UIApplicationShortcutItem(
                type: DeepLinkRouter.QuickAction.quickGame.rawValue,
                localizedTitle: String(localized: "New quick game"),
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "bolt.fill")
            ),
        ]
        return true
    }

    // Scenes are what deliver a quick action, and a SwiftUI app has no
    // scene delegate of its own to receive one — hence this, which exists
    // only to hand the action back to this object.
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    // A URL from SceneDelegate — an opened link, or the page a Universal
    // Link was following. Buffered like everything else that can arrive
    // before there is a router to put it in.
    func handle(_ url: URL) {
        if let deepLinkRouter {
            deepLinkRouter.handle(url)
        } else {
            pendingURL = url
        }
    }

    // Same buffering as a notification tap: on a cold launch this runs
    // long before RootView has handed us the router.
    func handle(_ shortcutItem: UIApplicationShortcutItem) {
        guard let action = DeepLinkRouter.QuickAction(rawValue: shortcutItem.type) else { return }
        if let deepLinkRouter {
            deepLinkRouter.pendingAction = action
        } else {
            pendingAction = action
        }
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
