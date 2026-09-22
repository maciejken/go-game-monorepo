import SwiftUI

private enum AppTab: Hashable {
    case home
    case account
}

// Replaces the old direct GameListView root once logged in: a bottom tab
// bar with Home (the game list) and Account (the logged-in user's own
// profile) — icon-only per request, no text labels. Favourites had a tab
// of its own until they became a tag: the star beside the list's title
// filters by it, which is a filter on the list rather than a second list.
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
        // The app's one shake detector. GameBoardView listens for the same
        // notification to open its Title & tags sheet; the two never
        // collide, since this one stands down while a board is open.
        .shakeSource()
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
