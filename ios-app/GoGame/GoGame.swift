import SwiftUI

@main
struct GoGameApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var deepLinkRouter = DeepLinkRouter()

    var body: some Scene {
        WindowGroup {
            RootView()
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
