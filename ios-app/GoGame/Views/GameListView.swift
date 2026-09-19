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
    // Which server-side list this tab shows: "mine" (games you play in or
    // starred) for Home, "starred" for Favourites. Only the Home tab
    // creates games and consumes game deep links; everything else here is
    // the same list behaviour either way.
    var scope: String = "mine"
    @Environment(DeepLinkRouter.self) private var deepLinkRouter
    // Favourites' own button starts a game from the shake-to-play preset,
    // whether or not the gesture itself is switched on — tapping is an
    // explicit ask, where a shake is one you might not have meant.
    @Environment(QuickGameStore.self) private var quickGame
    @State private var games: [GameSummary] = []
    @State private var hasMore = false
    @State private var isLoadingMore = false
    @State private var errorMessage: String?
    @State private var showNewGame = false
    @State private var selectedGameId: String?
    @State private var pendingGameId: String?
    @State private var searchText = ""
    // The debounced, long-enough-to-use form of searchText — what actually
    // gets sent. Keeping it separate means typing doesn't refetch on every
    // keystroke, and a 1-2 character query cleanly means "no filter"
    // rather than a request the server would ignore anyway.
    @State private var appliedSearch = ""
    @State private var isStartingQuickGame = false

    private var isHome: Bool { scope == "mine" }

    private static let pageSize = 20
    // Matches the server's own floor for ?q=.
    private static let minSearchLength = 3

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
                    if !appliedSearch.isEmpty {
                        ContentUnavailableView.search(text: appliedSearch)
                    } else if isHome {
                        ContentUnavailableView("No games yet", systemImage: "circle.grid.cross")
                    } else {
                        ContentUnavailableView(
                            "No favourites yet",
                            systemImage: "star",
                            description: Text("Star a game from its Title & tags sheet to keep it here.")
                        )
                    }
                }
            }
            .overlay(alignment: .bottomTrailing) {
                Group {
                    // Home composes a new game; Favourites starts the one
                    // the preset already describes. Same slot either way,
                    // so whichever tab you're on, the button that starts a
                    // game is under the same thumb.
                    if !isHome {
                        quickGameButton
                    } else {
                        // Regular (non-prominent) glass rather than
                        // .glassProminent — prominent fills the shape with a
                        // solid tint (accentColor blue by default), which is
                        // exactly the opaque look being replaced; regular
                        // glass is the translucent one, adaptive in both
                        // themes with no color of its own beyond what shows
                        // through it.
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
                }
                .padding(20)
            }
            .refreshable { await loadGames() }
            .task { await loadGames() }
            .searchable(text: $searchText, prompt: "Search titles, players, tags")
            // A magnifying glass in the header rather than a field of its
            // own: the field scrolls away with the list, while the button
            // stays reachable at any scroll position.
            .modifier(MinimizedSearchField())
            // Debounced the same way the web client's search input is: the
            // task restarts on every keystroke, and only the last one
            // survives the sleep to actually apply the query.
            .task(id: searchText) {
                let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                let next = query.count >= Self.minSearchLength ? query : ""
                guard next != appliedSearch else { return }
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                appliedSearch = next
                await loadGames()
            }
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
            // No live socket here on purpose: this list used to hold one on
            // /ws/games, but re-assigning `games` while a game was pushed,
            // a sheet was open, or a create was mid-flight could tear down
            // the whole NavigationStack (an iOS 26 SwiftUI regression,
            // confirmed on-device), so it had to be gated into skipping
            // exactly the moments anything was happening. What was left
            // only refreshed a list nobody was looking away from anyway —
            // .task on appear plus pull-to-refresh cover that case without
            // the socket's reconnect churn or its navigation hazard.
            .navigationTitle(isHome ? "Your Games" : "Favourites")
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

    // Mirrors the new-game button's glass treatment exactly — the two are
    // the same control in the same place, differing only in what they
    // start.
    @ViewBuilder
    private var quickGameButton: some View {
        let icon = Image(systemName: "bolt.fill")
            .font(.title2.weight(.semibold))
            .foregroundStyle(.primary)
            .frame(width: 56, height: 56)
        if #available(iOS 26.0, *) {
            Button { Task { await startQuickGame() } } label: { icon }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .disabled(isStartingQuickGame)
        } else {
            Button { Task { await startQuickGame() } } label: {
                icon
                    .background(.ultraThinMaterial, in: Circle())
                    .overlay(Circle().stroke(Color.primary.opacity(0.2), lineWidth: 1))
                    .shadow(radius: 4, y: 2)
            }
            .disabled(isStartingQuickGame)
        }
    }

    // Pushes onto this tab's own stack rather than routing through the
    // deep-link router as a shake does: the tap happened here, so there's
    // no reason to move the user to Home first.
    private func startQuickGame() async {
        guard !isStartingQuickGame else { return }
        isStartingQuickGame = true
        defer { isStartingQuickGame = false }
        if quickGame.preset == nil {
            await quickGame.load()
        }
        guard let preset = quickGame.preset else {
            errorMessage = "Couldn't load your quick game preset."
            return
        }
        do {
            let gameId = try await APIClient.createGame(from: preset)
            await loadGames()
            selectedGameId = gameId
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // Resets back to page one — used for the initial load, pull-to-refresh,
    // and every live-socket-triggered reload. Simpler than merging updates
    // into whatever pages are currently loaded, at the cost of losing
    // scroll-loaded pages on those refreshes — mirrors Home.tsx's refresh.
    private func loadGames() async {
        do {
            // withRetry absorbs a transient failure (e.g. the network still
            // recovering right after resuming from background, which a
            // push-notification-driven open makes fairly common) instead of
            // flashing this screen's error alert for something that
            // resolves itself a couple of seconds later.
            let page = try await APIClient.withRetry {
                try await APIClient.games(scope: scope, limit: Self.pageSize, offset: 0, query: appliedSearch)
            }
            games = page.games
            hasMore = page.hasMore
            errorMessage = nil
        } catch {
            // Leaving this screen mid-load cancels the task; the cancelled
            // request isn't something to alert anyone about.
            guard !APIClient.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await APIClient.games(
                scope: scope, limit: Self.pageSize, offset: games.count, query: appliedSearch
            )
            games.append(contentsOf: page.games)
            hasMore = page.hasMore
        } catch {
            guard !APIClient.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    // pendingGameId/showNewGame still gate this — pushing into a deep-linked
    // game while the create-game flow is mid-flight is exactly the kind of
    // overlapping push that corrupts this NavigationStack. A game already
    // open (selectedGameId non-nil) is handled by popping it first and
    // pushing the new id after a short delay, rather than assigning the new
    // id directly: confirmed on-device that navigationDestination(item:)
    // does NOT refresh its pushed content for a non-nil-to-different-non-nil
    // change — selectedGameId updates correctly (visible in logging) but the
    // screen keeps showing the old game. Popping to nil first forces an
    // actual pop; the delay stands in for the "wait until the transition
    // has actually finished" a sheet's onDismiss gives for free but a plain
    // stack pop has no equivalent callback for.
    private func consumeDeepLink() {
        guard let id = deepLinkRouter.targetGameId else { return }
        // MainTabView switches to Home for a game link, so only that tab's
        // list ever consumes one — isActiveTab alone would already be
        // false here, but saying so directly makes it obvious why the
        // Favourites tab never pushes.
        guard isHome, isActiveTab else { return }
        guard pendingGameId == nil, !showNewGame else { return }
        guard selectedGameId != id else { return }
        deepLinkRouter.targetGameId = nil
        if selectedGameId != nil {
            selectedGameId = nil
            Task {
                try? await Task.sleep(nanoseconds: 500_000_000)
                // Only apply if nothing else claimed the now-empty slot
                // during the delay (e.g. a row tap) — avoids clobbering an
                // unrelated navigation that happened to start in that window.
                if selectedGameId == nil {
                    selectedGameId = id
                }
            }
        } else {
            selectedGameId = id
        }
    }
}

// searchToolbarBehavior is iOS 26+, and there's no pre-26 equivalent —
// older versions simply keep the always-visible field.
private struct MinimizedSearchField: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.searchToolbarBehavior(.minimize)
        } else {
            content
        }
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
