import SwiftUI

private enum AppTab: Hashable {
    case home
    case account
}

// Replaces the old direct GameListView root once logged in: a bottom tab
// bar with Home (the game list) and Account (the logged-in user's own
// profile) — icon-only per request, no text labels. GameListView keeps its
// own NavigationStack/navigation logic untouched; this just hosts it as one
// tab among two.
struct MainTabView: View {
    @Environment(SessionStore.self) private var session
    @Environment(DeepLinkRouter.self) private var deepLinkRouter
    @State private var selectedTab: AppTab = .home
    // A /profile/<id> universal link can point at someone else's profile,
    // not just the signed-in user's own — pushed on top of the Account
    // tab's own (self) profile root via the same item-based navigation
    // pattern GameListView uses for game ids.
    @State private var linkedProfileId: String?

    var body: some View {
        TabView(selection: $selectedTab) {
            GameListView(isActiveTab: selectedTab == .home)
                .tabItem { Image(systemName: "house") }
                .tag(AppTab.home)

            NavigationStack {
                Group {
                    if let myId = session.currentUser?.id {
                        ProfileView(userId: myId)
                    }
                }
                .navigationDestination(item: $linkedProfileId) { id in
                    ProfileView(userId: id)
                }
            }
            .tabItem { Image(systemName: "person") }
            .tag(AppTab.account)
        }
        .task { consumeProfileDeepLink() }
        .onChange(of: deepLinkRouter.targetProfileId) { _, _ in consumeProfileDeepLink() }
        // GameListView (the Home tab) does the actual push onto its own
        // NavigationStack whenever targetGameId is set — but that stack is
        // invisible if Home isn't the selected tab (e.g. a push notification
        // tapped while sitting on Account/Profile), so this just makes sure
        // the tab bar actually shows it. Safe to run alongside GameListView's
        // own consumption of the same value: this only ever touches
        // selectedTab, never targetGameId itself.
        .onChange(of: deepLinkRouter.targetGameId) { _, newValue in
            if newValue != nil {
                selectedTab = .home
            }
        }
    }

    private func consumeProfileDeepLink() {
        guard let id = deepLinkRouter.targetProfileId else { return }
        deepLinkRouter.targetProfileId = nil
        selectedTab = .account
        linkedProfileId = id
    }
}
