import SwiftUI

struct GameListView: View {
    // Whether the Home tab is the one actually showing right now — a game
    // deep link must wait for this before pushing, otherwise the push
    // happens on an invisible NavigationStack (e.g. the app was
    // backgrounded on the Account tab and resumed via a push notification
    // tap) with nothing visible to show for it, and worse, pushing into a
    // NavigationStack that isn't part of the visible view hierarchy yet is
    // exactly the kind of state change that has corrupted this app's
    // navigation before. MainTabView passes this in and flips selectedTab
    // to .home whenever a game link arrives; that change flows down here
    // and re-triggers consumeDeepLink() once it's actually safe to push.
    let isActiveTab: Bool
    @Environment(SessionStore.self) private var session
    @Environment(DeepLinkRouter.self) private var deepLinkRouter
    @State private var games: [GameSummary] = []
    @State private var hasMore = false
    @State private var isLoadingMore = false
    @State private var errorMessage: String?
    @State private var showNewGame = false
    @State private var selectedGameId: String?
    @State private var pendingGameId: String?

    private static let pageSize = 20

    var body: some View {
        NavigationStack {
            // A plain Button (not NavigationLink) setting selectedGameId,
            // driving the same navigationDestination(item:) used for a
            // freshly created game — mixing NavigationLink's own push
            // mechanism with an item-based one on the same NavigationStack
            // is a known source of real instability (the stack repeatedly
            // appearing/disappearing right after a programmatic push/pop,
            // corrupting UIKit's navigation controller and silently
            // swallowing all touches on whatever's pushed next). One
            // mechanism for the whole stack avoids that entirely.
            //
            // The `selectedGameId == nil` guard additionally prevents a
            // second row's tap from starting a second push while the first
            // one is still mid-transition — device testing showed that
            // exact overlap (two navigation transitions colliding) is what
            // corrupts the stack, and RowButtonStyle's press feedback below
            // makes a first tap's success visible so there's less reason to
            // tap again while it's still animating.
            List(games) { game in
                Button {
                    guard selectedGameId == nil else { return }
                    selectedGameId = game.id
                } label: {
                    HStack {
                        GameRowView(game: game)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle())
                // Mirrors the web client's IntersectionObserver-on-a-
                // sentinel approach with the plain SwiftUI equivalent:
                // .onAppear on the last row fires exactly when it scrolls
                // into view, whether that's from scrolling or because the
                // page is short enough that it's already visible.
                .onAppear {
                    if game.id == games.last?.id {
                        Task { await loadMore() }
                    }
                }
            }
            .overlay {
                if games.isEmpty && errorMessage == nil {
                    ContentUnavailableView("No games yet", systemImage: "circle.grid.cross")
                }
            }
            .overlay(alignment: .bottomTrailing) {
                Group {
                    // Regular (non-prominent) glass rather than
                    // .glassProminent — prominent fills the shape with a
                    // solid tint (accentColor blue by default), which is
                    // exactly the opaque look being replaced; regular glass
                    // is the translucent one, adaptive in both themes with
                    // no color of its own beyond what shows through it.
                    if #available(iOS 26.0, *) {
                        Button {
                            showNewGame = true
                        } label: {
                            Image(systemName: "plus")
                                .font(.title2.weight(.semibold))
                                .foregroundStyle(.primary)
                                .frame(width: 56, height: 56)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                    } else {
                        Button {
                            showNewGame = true
                        } label: {
                            Image(systemName: "plus")
                                .font(.title2.weight(.semibold))
                                .foregroundStyle(.primary)
                                .frame(width: 56, height: 56)
                                .background(.ultraThinMaterial, in: Circle())
                                .overlay(Circle().stroke(Color.primary.opacity(0.2), lineWidth: 1))
                                .shadow(radius: 4, y: 2)
                        }
                    }
                }
                .padding(20)
            }
            .refreshable { await loadGames() }
            .task { await loadGames() }
            // Catches a universal-link target set before this view even
            // existed (cold launch, or arriving while the auth screen was
            // still showing) — a fresh GameListView only gets created once
            // the session check settles, so .task's one-time run at that
            // point is exactly when a link received earlier needs picking
            // up. .onChange below covers a link arriving after that.
            .task { consumeDeepLink() }
            .onChange(of: deepLinkRouter.targetGameId) { _, _ in consumeDeepLink() }
            .onChange(of: isActiveTab) { _, active in
                if active {
                    consumeDeepLink()
                }
            }
            // Gated on selectedGameId, pendingGameId, and showNewGame all
            // being clear: a state update on this root list — even just
            // re-assigning `games` — while a game is pushed, or anywhere in
            // the create-then-push sequence, can tear down/corrupt the
            // whole NavigationStack on iOS 26 (a documented SwiftUI
            // regression, confirmed on-device). Nothing is lost by skipping
            // it — the list isn't visible during any of this anyway.
            .task {
                await LiveSocket.listen(path: "/ws/games") {
                    // showNewGame is included because the server broadcasts
                    // games-list-updated as part of handling the create
                    // request itself — that push can reach this already-
                    // open socket before the HTTP response for our own
                    // createGame call comes back, i.e. before pendingGameId
                    // is even set. Gating on the sheet being open at all
                    // closes that gap: it's up for the request's entire
                    // in-flight duration, not just after it resolves.
                    // Confirmed on-device: the push consistently arrives
                    // while the sheet is still open, sometimes before the
                    // user even taps Start.
                    guard selectedGameId == nil, pendingGameId == nil, !showNewGame else { return }
                    await loadGames()
                }
            }
            .navigationTitle("Your Games")
            .navigationDestination(item: $selectedGameId) { gameId in
                GameBoardView(gameId: gameId)
            }
            // onDismiss defers navigating until the sheet's dismiss animation
            // has actually finished — setting selectedGameId in the same
            // tick as showNewGame = false races the sheet dismiss against
            // the navigationDestination(item:) push.
            .sheet(isPresented: $showNewGame, onDismiss: {
                if let pendingGameId {
                    selectedGameId = pendingGameId
                    self.pendingGameId = nil
                }
            }) {
                NewGameView { gameId in
                    pendingGameId = gameId
                    showNewGame = false
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Log Out") {
                        Task { await session.logout() }
                    }
                }
            }
            .alert(
                "Couldn't load games",
                isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
            ) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    // Resets back to page one — used for the initial load, pull-to-refresh,
    // and every live-socket-triggered reload. Simpler than merging updates
    // into whatever pages are currently loaded, at the cost of losing
    // scroll-loaded pages on those refreshes — mirrors Home.tsx's refresh.
    private func loadGames() async {
        do {
            let page = try await APIClient.games(limit: Self.pageSize, offset: 0)
            games = page.games
            hasMore = page.hasMore
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await APIClient.games(limit: Self.pageSize, offset: games.count)
            games.append(contentsOf: page.games)
            hasMore = page.hasMore
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // Same "list at rest" gate as the live-socket refresh above, for the
    // same reason: pushing into a deep-linked game while another push/pop
    // is already mid-flight is exactly the kind of overlap that corrupts
    // this NavigationStack. If a link arrives while a different game is
    // already open, it's simply not consumed here — left for a future
    // visit rather than risking that.
    private func consumeDeepLink() {
        guard let id = deepLinkRouter.targetGameId else { return }
        guard isActiveTab else { return }
        guard selectedGameId == nil, pendingGameId == nil, !showNewGame else { return }
        deepLinkRouter.targetGameId = nil
        selectedGameId = id
    }
}

// Gives a row a visible press highlight — .plain alone gives zero visual
// feedback on tap, which made it easy to tap twice (once out of
// uncertainty whether the first tap registered) and collide two navigation
// transitions together.
private struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.primary.opacity(0.08) : Color.clear)
    }
}
