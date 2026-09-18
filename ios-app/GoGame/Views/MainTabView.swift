import SwiftUI

private enum AppTab: Hashable {
    case home
    case favourites
    case account
}

// Replaces the old direct GameListView root once logged in: a bottom tab
// bar with Home (the game list), Favourites (the games you starred) and
// Account (the logged-in user's own profile) — icon-only per request, no
// text labels. GameListView keeps its own NavigationStack/navigation logic
// untouched; this just hosts two differently-scoped copies of it plus the
// profile.
struct MainTabView: View {
    @Environment(SessionStore.self) private var session
    @Environment(DeepLinkRouter.self) private var deepLinkRouter
    @State private var selectedTab: AppTab = .home
    // A /profile/<id> universal link can point at someone else's profile,
    // not just the signed-in user's own — pushed on top of the Account
    // tab's own (self) profile root via the same item-based navigation
    // pattern GameListView uses for game ids.
    @State private var linkedProfileId: String?
    @State private var quickGame = QuickGameStore()
    @State private var quickGameError: String?
    @State private var isCreatingQuickGame = false

    var body: some View {
        TabView(selection: $selectedTab) {
            GameListView(isActiveTab: selectedTab == .home)
                .tabItem { Image(systemName: "house") }
                .tag(AppTab.home)

            GameListView(isActiveTab: selectedTab == .favourites, scope: "starred")
                .tabItem { Image(systemName: "star") }
                .tag(AppTab.favourites)

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
        .environment(quickGame)
        // Shake to play: creates a game from the saved preset and opens
        // it. Attached here rather than per-screen so it works from any
        // tab, and gated below on no board being open.
        .onShake { Task { await startQuickGame() } }
        .task { await quickGame.load() }
        .alert(
            "Couldn't start a game",
            isPresented: Binding(get: { quickGameError != nil }, set: { if !$0 { quickGameError = nil } })
        ) {
            Button("OK") { quickGameError = nil }
        } message: {
            Text(quickGameError ?? "")
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

    // The one-open-short-game limits, GNU Go's availability and whether
    // the saved opponent still accepts invitations are all decided by the
    // create endpoint, so a shake can legitimately fail — hence the alert
    // rather than silence. Routing through deepLinkRouter reuses the same
    // path a game link takes, including its pop-then-push handling.
    private func startQuickGame() async {
        guard quickGame.isShakeEnabled, !quickGame.isBoardOpen, !isCreatingQuickGame else { return }
        guard let preset = quickGame.preset else { return }
        isCreatingQuickGame = true
        defer { isCreatingQuickGame = false }
        do {
            deepLinkRouter.targetGameId = try await APIClient.createGame(from: preset)
        } catch {
            quickGameError = error.localizedDescription
        }
    }

    private func consumeProfileDeepLink() {
        guard let id = deepLinkRouter.targetProfileId else { return }
        deepLinkRouter.targetProfileId = nil
        selectedTab = .account
        linkedProfileId = id
    }
}
