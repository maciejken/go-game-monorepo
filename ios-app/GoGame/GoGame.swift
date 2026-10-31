import SwiftUI

@main
struct GoGameApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var deepLinkRouter = DeepLinkRouter()

    init() {
        // Before any tab bar exists: an appearance proxy set later does
        // not reach a bar that has already been built.
        TabSelectionTint.configureAppearance()
        Igo5.configureSegmentedAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                // Every Toggle in the app, set once here.
                .toggleStyle(.igo5Switch)
                .environment(deepLinkRouter)
                .onOpenURL { url in
                    deepLinkRouter.handle(url)
                }
                .onAppear {
                    appDelegate.deepLinkRouter = deepLinkRouter
                }
        }
    }
}
