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
    // "mine" or "starred" — set by the star beside the title rather than
    // by which tab you are on, since Favourites no longer has one.
    @State private var scope: String = "mine"
    // Shown when the star is pressed before a favourites tag exists.
    @State private var showFavouritesHelp = false
    @State private var showProfile = false
    @Environment(DeepLinkRouter.self) private var deepLinkRouter
    @Environment(SessionStore.self) private var session
    // Holding Home's new-game button starts a game from the shake-to-play
    // preset, whether or not the gesture itself is switched on — a press is
    // an explicit ask, where a shake is one you might not have meant.
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
    private var favouriteTag: String? { session.currentUser?.favouriteTag }

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
            List {
                // Says why the list is short before anyone wonders where
                // their server games went.
                if session.currentUser == nil {
                    Text("Playing without an account — these games are saved on this device")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if session.isOffline {
                    Text("Offline — showing games saved on this device")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(games) { game in
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
                    // Only Home starts games: a tap composes a new one, a
                    // press-and-hold starts the preset game outright. The
                    // two live on one button because they are the same
                    // errand, and Favourites is for finding games again,
                    // not making them.
                    if isHome {
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
                // On the Group, so it applies to whichever of the two
                // button bodies is built. simultaneousGesture so the
                // button keeps its own press behaviour and highlight.
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                        Task { await startQuickGame() }
                    }
                )
                // The press has no visible result until the game opens, so
                // the tap-back is what says "held long enough".
                .sensoryFeedback(.impact, trigger: isStartingQuickGame) { _, starting in starting }
                .padding(20)
            }
            .refreshable { await loadGames() }
            // task(id:) already runs once on appear and again whenever the
            // scope changes, so a plain .task beside it would just fetch
            // the same list twice every time this view appeared.
            .task(id: scope) { await loadGames() }
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
            // Both home-screen quick actions land here, because both of
            // them end on this tab anyway — one opens the form, the other
            // the game it creates.
            .task { consumeQuickAction() }
            .onChange(of: deepLinkRouter.pendingAction) { _, _ in consumeQuickAction() }
            .onChange(of: isActiveTab) { _, active in
                if active {
                    consumeDeepLink()
                    // MainTabView switches to this tab when an action
                    // arrives, so the action often lands while the tab is
                    // still the other one — without this it would sit
                    // unconsumed for good.
                    consumeQuickAction()
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
            .navigationTitle("Your Games")
            .toolbar {
                // Favourites are one of the user's own tags, which live on
                // the server — there is nothing to filter by without an
                // account.
                if session.currentUser != nil {
                    ToolbarItem(placement: .topBarTrailing) { favouritesFilterButton }
                }
            }
            .sheet(isPresented: $showFavouritesHelp) {
                favouritesHelpSheet
                    .presentationDetents([.height(260)])
            }
            .navigationDestination(isPresented: $showProfile) {
                if let myId = session.currentUser?.id {
                    ProfileView(userId: myId)
                }
            }
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

    // Filled only while the filter is on: the star says what the list is
    // showing, not what it could show.
    private var favouritesFilterButton: some View {
        Button {
            guard favouriteTag != nil else {
                showFavouritesHelp = true
                return
            }
            scope = isHome ? "starred" : "mine"
        } label: {
            Image(systemName: isHome ? "star" : "star.fill")
                .foregroundStyle(isHome ? Color.secondary : Color.yellow)
        }
        .accessibilityLabel("Show favourites only")
    }

    private var favouritesHelpSheet: some View {
        VStack(spacing: 16) {
            Image(systemName: "star")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Favourites are one of your own tags. Choose which tag marks them, then tag any game with it.")
                .multilineTextAlignment(.center)
            Button("Choose in your profile") {
                showFavouritesHelp = false
                showProfile = true
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }

    // Pushes onto this tab's own stack rather than routing through the
    // deep-link router as a shake does: the press happened here, so there's
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
        // No account, nothing to ask for: the device's own games are the
        // whole list, and a request would only come back 401.
        guard session.currentUser != nil else {
            games = merged(serverGames: [])
            hasMore = false
            errorMessage = nil
            return
        }
        do {
            // withRetry absorbs a transient failure (e.g. the network still
            // recovering right after resuming from background, which a
            // push-notification-driven open makes fairly common) instead of
            // flashing this screen's error alert for something that
            // resolves itself a couple of seconds later.
            let page = try await APIClient.withRetry {
                try await APIClient.games(scope: scope, limit: Self.pageSize, offset: 0, query: appliedSearch)
            }
            games = merged(serverGames: page.games)
            hasMore = page.hasMore
            errorMessage = nil
            session.isOffline = false
        } catch {
            // Leaving this screen mid-load cancels the task; the cancelled
            // request isn't something to alert anyone about.
            guard !APIClient.isCancellation(error) else { return }
            // The server being unreachable is exactly when offline games
            // matter, so they are still listed — the error says the rest of
            // the list is missing, it doesn't hide what the device has.
            games = merged(serverGames: [])
            hasMore = false
            // Being offline isn't a failure to report: the banner says the
            // rest of the list is missing, without an alert on every
            // refresh. Anything else the server says still gets one.
            if APIClient.isUnreachable(error) {
                session.isOffline = true
                errorMessage = nil
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    // Offline games live on the device, so they are not a page the server
    // can send: they are merged in here, newest first, and left out of the
    // favourites filter (a favourite is a tag, and tags are a server idea).
    private func merged(serverGames: [GameSummary]) -> [GameSummary] {
        guard isHome else { return serverGames }
        let offline = OfflineGameStore.shared.all()
            // A published game is in the list twice otherwise. The device's
            // copy is what's left when the server can't be reached, so it
            // is hidden rather than dropped.
            .filter { session.isOffline || session.currentUser == nil || $0.publishedGameId == nil }
            .map(\.summary)
            .filter { summary in
            guard !appliedSearch.isEmpty else { return true }
            return (summary.title ?? "").localizedCaseInsensitiveContains(appliedSearch)
        }
        return (offline + serverGames).sorted { $0.updatedAt > $1.updatedAt }
    }

    private func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await APIClient.games(
                scope: scope, limit: Self.pageSize, offset: games.count, query: appliedSearch
            )
            games.append(contentsOf: page.games.filter { summary in !games.contains { $0.id == summary.id } })
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
    private func consumeQuickAction() {
        guard let action = deepLinkRouter.pendingAction else { return }
        // Unlike a game link, neither action cares which way the list is
        // filtered — only that this tab is the one on screen to show the
        // sheet or the new game on.
        guard isActiveTab else { return }
        deepLinkRouter.pendingAction = nil
        switch action {
        case .favourites:
            // The same refusal the star button makes: with no favourite
            // tag there is nothing to filter by, and an empty list would
            // look like a bug rather than a setting that isn't set.
            if favouriteTag == nil {
                showFavouritesHelp = true
            } else {
                scope = "starred"
            }
        case .newGame:
            showNewGame = true
        case .quickGame:
            // The same call the lightning button makes, errors and all:
            // a preset that won't load is as likely from here as from a
            // press, and says so the same way.
            Task { await startQuickGame() }
        }
    }

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
