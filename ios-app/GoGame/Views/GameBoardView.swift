import SwiftUI

// Which click-a-group action a tap during scoring performs — mirrors
// client/src/pages/Game.tsx's markMode.
enum MarkMode {
    case dead
    case seki
}

struct GameBoardView: View {
    let gameId: String
    @State private var game: GameState?
    @State private var errorMessage: String?
    @State private var isBusy = false
    @State private var markMode: MarkMode = .dead
    // Point keys ("x,y") marked dead/seki during the scoring phase — local
    // until Finalize is tapped, mirroring client/src/pages/Game.tsx's
    // pendingDead/pendingSeki.
    @State private var pendingDeadKeys: Set<String> = []
    @State private var pendingSekiKeys: Set<String> = []
    @State private var showActionsSheet = false
    @State private var showSettingsSheet = false
    @State private var showResultSheet = false
    @State private var showTagsSheet = false
    // Measured from the tags sheet's own content, so its detent grows with
    // the number of chip rows instead of guessing one height for all of them.
    @State private var tagsSheetHeight: CGFloat = 200
    @State private var showDeleteConfirmation = false
    // Set once the SGF has been fetched and written to a temp file — its
    // presence both drives the share sheet (.sheet(isPresented:), same
    // pattern as errorMessage below) and holds everything the sheet shares.
    @State private var gameShare: GameShare?
    // Set before the delete request is even issued (see deleteGame()): the
    // server broadcasts a game-update event as part of handling that
    // request itself, so the push can reach this view's own live socket
    // before the DELETE response comes back, and this view stays mounted
    // (mid-dismiss, not yet torn down) long enough to act on it. Also
    // checked again in load()'s own error handling, since a load() already
    // in flight when this flips true isn't stopped by the guard on the
    // live-socket callback alone. Mirrors the same fix applied to
    // GameListView's create-game race.
    @State private var isDeleted = false
    @Environment(\.dismiss) private var dismiss
    // Used to jump to a player's profile from the result sheet — reuses the
    // exact same mechanism a real /profile/<id> universal link goes
    // through, since MainTabView already knows how to switch to the
    // Account tab and push a profile for it regardless of what's currently
    // on screen.
    @Environment(DeepLinkRouter.self) private var deepLinkRouter
    // Suppresses shake-to-play while this board is on screen — see
    // QuickGameStore.isBoardOpen.
    @Environment(QuickGameStore.self) private var quickGame
    // Mirrors client/src/pages/Game.tsx's confirmMoves setting (persisted
    // the same way, via a device-local preference) and pendingMove: with it
    // on, a first tap on a valid point just marks it; tapping that same
    // point again is what actually submits the move.
    @AppStorage("go-confirm-moves") private var confirmMovesEnabled = false
    // A shake here opens Title & tags — the menu's first action — rather
    // than starting a quick game, which is what a shake does everywhere
    // else. Device-local like the setting above: it's about how this
    // phone is held, not about the account.
    @AppStorage("go-shake-title-tags") private var shakeOpensTitleTags = true
    @State private var pendingMove: Point?
    // The board is hidden from VoiceOver, so typing a coordinate is the
    // way in for anyone it doesn't work for. On by default, since someone
    // who needs it can't discover a setting they can't reach the board to
    // miss; anyone who would rather have the space back turns it off.
    // Where this game actually lives — the server, or this device for an
    // offline game. Chosen from the id unless a caller passes one.
    var transportOverride: GameTransport?
    private var transport: GameTransport { transportOverride ?? makeTransport(forGameId: gameId) }
    @AppStorage("go-coordinate-entry") private var coordinateEntryEnabled = true
    // Watching a board isn't touching it, so the screen would otherwise dim
    // mid-game — but that is a battery trade, so it stays a choice.
    @AppStorage("go-keep-screen-awake") private var keepScreenAwake = true
    // A stone placed on a real board is felt as well as seen; a tap on
    // glass isn't, unless the phone says so.
    @AppStorage("go-haptics") private var hapticsEnabled = true
    @State private var coordinateText = ""
    @State private var coordinateEditing = false
    @FocusState private var coordinateFocused: Bool
    // Why the typed point can't be played (occupied, ko, suicide), as the
    // server sees it — asked for as it is typed, so an illegal point says
    // so before it is submitted rather than erroring after.
    @State private var coordinateError: String?
    // Review mode — always on for a finished game (no toggle, unlike the
    // web client's Review/Live menu item): the full move-by-move record,
    // fetched once when the game is first found to be finished, and the
    // move number currently being displayed. history is fetched exactly
    // once per game (guarded in load()) since a finished game's history
    // never changes.
    @State private var history: GameHistoryResponse?
    @State private var reviewMoveNumber: Int?
    // Bumped on every return from the background to restart the live
    // socket — see the .task(id:) below.
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @State private var socketGeneration = 0
    @State private var wasBackgrounded = false

    var body: some View {
        Group {
            if let game {
                boardContent(game)
            } else {
                ProgressView()
            }
        }
        // The Home tab's bottom tab bar would otherwise stack on top of
        // this screen's own glass footer (turn marker, captures, clock) —
        // hide it here specifically, same as the pre-tab-bar layout.
        .toolbar(.hidden, for: .tabBar)
        .navigationTitle(navigationTitle)
        .task { await load() }
        // Keyed on socketGeneration so coming back from the background
        // tears the old socket down and starts a fresh one: a connection
        // that died while the app was suspended often doesn't report the
        // failure, it just sits half-open, never receiving and never
        // erroring, which would leave the board silently stale until the
        // user pulled to refresh. listen() refetches on every (re)connect,
        // so the restart also picks up whatever was missed while away.
        .task(id: socketGeneration) {
            await LiveSocket.listen(path: "/ws/games/\(gameId)") {
                guard !isDeleted else { return }
                await load(surfacingErrors: false)
            }
        }
        // Only a real background trip counts. scenePhase also goes
        // .inactive for things like a Control Centre pull-down or the app
        // switcher, and reconnecting for those would just mean extra
        // refetches for a connection that was never actually interrupted.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                wasBackgrounded = true
            case .active:
                if wasBackgrounded {
                    wasBackgrounded = false
                    socketGeneration += 1
                }
            default:
                break
            }
        }
        .onAppear {
            quickGame.isBoardOpen = true
            // Cleared on the way out, so this only ever applies while a
            // board is on screen.
            UIApplication.shared.isIdleTimerDisabled = keepScreenAwake
        }
        .onDisappear {
            quickGame.isBoardOpen = false
            UIApplication.shared.isIdleTimerDisabled = false
        }
        // Takes effect on the board already open, not just the next one.
        .onChange(of: keepScreenAwake) { _, keepAwake in
            UIApplication.shared.isIdleTimerDisabled = keepAwake
        }
        // isBoardOpen gates this as well as the quick game: a board that's
        // still pushed on another tab shouldn't answer a shake meant for
        // whatever is actually on screen.
        .onShake {
            guard shakeOpensTitleTags, quickGame.isBoardOpen else { return }
            showTagsSheet = true
        }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    // Only meaningful while actually waiting on GNU Go —
                    // the escape hatch for a request that died mid-thought.
                    if let game, isAiTurn(game) {
                        Button {
                            Task { await recomputeAiMove() }
                        } label: {
                            Label("Recompute GNU Go's move", systemImage: "arrow.clockwise")
                        }
                    }
                    // Open to anyone: a spectator can't edit the title or
                    // tags (the sheet shows them read-only, as does the
                    // server) but can still favourite the game from here.
                    Button {
                        showTagsSheet = true
                    } label: {
                        Label("Title & tags", systemImage: "tag")
                    }
                    Button {
                        Task { await exportSgf() }
                    } label: {
                        Label("Share game", systemImage: "square.and.arrow.up")
                    }
                    Button(role: .destructive) {
                        showDeleteConfirmation = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        showSettingsSheet = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .rotationEffect(.degrees(90))
                }
            }
        }
        .sheet(isPresented: $showDeleteConfirmation) {
            deleteConfirmationSheetContent
                .presentationDetents([.height(230)])
                .presentationBackground(sheetBackground)
        }
        // Bound directly to the game's own pendingInviteResponse rather
        // than a local flag: accepting clears it server-side, and the
        // reload that follows naturally dismisses this sheet by itself
        // once that flag comes back false — no separate state to keep in
        // sync. The `set` half is a no-op (paired with
        // .interactiveDismissDisabled below) so declining or accepting via
        // the buttons are the only ways out, never a swipe.
        .sheet(isPresented: Binding(get: { game?.pendingInviteResponse == true }, set: { _ in })) {
            if let game {
                inviteResponseSheetContent(game)
                    .interactiveDismissDisabled(true)
                    .presentationDetents([.height(260)])
                    .presentationBackground(sheetBackground)
            }
        }
        .sheet(isPresented: Binding(get: { gameShare != nil }, set: { if !$0 { gameShare = nil } })) {
            if let gameShare {
                ShareSheet(share: gameShare)
            }
        }
        .sheet(isPresented: $showActionsSheet) {
            if let game {
                actionsSheetContent(game)
                    .presentationDetents([.height(180)])
                    // A sheet's default background is a translucent system
                    // material, which applies automatic vibrancy blending to
                    // semantic colors like Color.primary — that washed the
                    // Pass button's intended solid black/white fill out to
                    // gray. An opaque background stops that blending.
                    .presentationBackground(sheetBackground)
            }
        }
        .sheet(isPresented: $showSettingsSheet) {
            settingsSheetContent
                .presentationDetents([.height(354)])
        }
        .sheet(isPresented: $showTagsSheet) {
            if let game {
                TitleTagsSheetView(
                    gameId: gameId,
                    title: game.title,
                    tags: game.tagList,
                    starred: game.starred ?? false,
                    canEdit: game.myColor != nil,
                    onTitleChange: { title in self.game?.title = title },
                    onTagsChange: { tags in self.game?.tags = tags },
                    onStarredChange: { starred in self.game?.starred = starred },
                    contentHeight: $tagsSheetHeight
                )
                .presentationDetents([.height(tagsSheetHeight)])
                .presentationBackground(sheetBackground)
            }
        }
        .sheet(isPresented: $showResultSheet) {
            if let game {
                resultSheetContent(game)
                    .presentationDetents([.height(resultSheetHeight(game))])
            }
        }
        .alert(
            "Error",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    // These sheets sit on an opaque background rather than the default
    // translucent material, which vibrancy-blends semantic colours like
    // Color.primary towards grey (see the actions sheet below). In dark
    // mode systemBackground is pure black, which leaves the secondary
    // buttons on these sheets — plain .glass, so nearly unfilled — with
    // almost nothing to stand out against. One step up the grey scale
    // gives them an edge without visibly lightening the sheet.
    private var sheetBackground: Color {
        colorScheme == .dark ? Color(uiColor: .secondarySystemBackground) : Color(uiColor: .systemBackground)
    }

    private var navigationTitle: String {
        game?.title?.isEmpty == false ? game!.title! : ""
    }

    private func boardContent(_ game: GameState) -> some View {
        ScrollView {
            VStack(spacing: 12) {
                BoardGridView(
                    board: displayedBoard(game),
                    size: game.size,
                    lastMove: highlightedPoint(game),
                    isInteractive: isInteractive(game),
                    allowTapOnOccupied: game.status == "scoring",
                    // Dimmed in both mark modes, not just while marking
                    // dead: a stone counted as a prisoner is already off
                    // the board for scoring, and leaving it solid in seki
                    // mode hides the territory markers underneath it.
                    deadPoints: pendingDeadKeys,
                    blackTerritoryPoints: territoryKeys(livePreview(game)?.blackTerritoryPoints ?? []),
                    whiteTerritoryPoints: territoryKeys(livePreview(game)?.whiteTerritoryPoints ?? []),
                    sekiHighlightPoints: sekiActive(game) ? pendingSekiKeys : [],
                    pendingMove: game.status == "in_progress" ? pendingMove : nil,
                    pendingMoveColor: game.currentColor,
                    highlightColumn: coordinateEntryEnabled && isInteractive(game)
                        ? partialColumn(coordinateText, size: game.size)
                        : nil,
                    // Only once the row is there too, and only until the
                    // move is played — playCoordinate clears the field,
                    // which takes both lines with it.
                    highlightRow: coordinateEntryEnabled && isInteractive(game)
                        ? parseCoordinate(coordinateText, size: game.size)?.y
                        : nil,
                    onTap: { x, y in
                        // On the tap itself, not on the move landing: the
                        // feedback is for the touch, and a move played over
                        // the network would answer far too late to feel
                        // like the same event.
                        if hapticsEnabled {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        }
                        if game.status == "scoring" {
                            toggleMarkedGroup(x: x, y: y, in: game)
                        } else {
                            Task { await handlePointTap(x: x, y: y, in: game) }
                        }
                    }
                )
                // Tapping the board puts the keyboard away, the way
                // tapping outside a field does elsewhere. On the board
                // alone, not the whole column: the field is in that column
                // too, and a tap on the field would have dismissed the
                // keyboard it had just asked for. simultaneous so the
                // board's own stone buttons still take the same tap.
                .simultaneousGesture(TapGesture().onEnded { coordinateFocused = false })
                // A grid of up to 361 buttons, none of which VoiceOver can
                // describe usefully one swipe at a time — it reads the
                // board as hundreds of anonymous stops between the status
                // line and everything below it. coordinateEntry below is
                // the way in for VoiceOver instead.
                .accessibilityHidden(true)

                if isReviewing(game) {
                    if let entry = reviewEntry {
                        Text("\(entry.moveNumber). \(describeEntry(entry, size: game.size))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                } else if let lastEvent = game.lastEvent {
                    // Independent of the board itself: a pass leaves no
                    // visible change at all, so without this there's no way
                    // to tell "opponent passed" from "still waiting."
                    Text(describeEntry(lastEvent, size: game.size))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                if coordinateEntryEnabled, isInteractive(game) {
                    coordinateEntry(game)
                }

                if isReviewing(game), let history {
                    // Extra breathing room beyond the VStack's own 12pt
                    // spacing, so the move list doesn't crowd right up
                    // against the description line above it.
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(history.moves, id: \.moveNumber) { entry in
                                    moveChainMarker(entry, size: game.size)
                                        .id(entry.moveNumber)
                                }
                            }
                            .padding(.horizontal)
                            .padding(.vertical, 8)
                        }
                        .padding(.top, 8)
                        .onChange(of: reviewMoveNumber) { _, newValue in
                            guard let newValue else { return }
                            withAnimation { proxy.scrollTo(newValue, anchor: .center) }
                        }
                        .task {
                            if let reviewMoveNumber {
                                proxy.scrollTo(reviewMoveNumber, anchor: .center)
                            }
                        }
                    }
                }

                // Order is board → mark mode → estimate: the picker and
                // estimate text used to sit above the board (the estimate
                // appended to an explainer sentence), which made the board
                // jump vertically whenever the estimate text's length
                // changed. Moving both below the board means only content
                // beneath it reflows.
                if game.status == "scoring" {
                    Picker("Marking mode", selection: $markMode) {
                        Text("Dead").tag(MarkMode.dead)
                        Text("Seki").tag(MarkMode.seki)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)

                    if let estimate = estimateText(game) {
                        Text(estimate)
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                }
            }
            .padding(.top)
            .padding(.bottom)
        }
        // ...and so does dragging the board, the other way a keyboard goes
        // away by itself on iOS.
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            // Nothing at all while a coordinate is being typed: the
            // keyboard would cover this row anyway, and giving its height
            // back to the board is the point — captures and clocks are
            // still a dismissal away.
            if coordinateEditing {
                EmptyView()
            } else {
            // The glass layer lives in .background, not wrapped directly
            // around footerRow, specifically so .ignoresSafeArea can let it
            // bleed down past the row's own layout and cover the home
            // indicator strip too — footerRow itself stays laid out exactly
            // as before, safely clear of that strip, and only the backing
            // glass extends into it. No conflict with the home indicator:
            // the system draws that on top of app content regardless of
            // what's underneath, on every app, glass or not.
            footerRow(game)
                // 14pt rather than 10pt so the short-result button's 4pt
                // overflow past its pinned 44pt row (see footerRow) still
                // leaves a visible gap above/below it, instead of nearly
                // touching the glass edge.
                .padding(.vertical, 14)
                .background {
                    if #available(iOS 26.0, *) {
                        Rectangle()
                            .fill(.clear)
                            // Nudged away from the turn marker's own colour
                            // in both appearances: the marker is a plain
                            // black or white circle with nothing drawn on
                            // top of it (a rim would break its press
                            // animation — see turnMarker), so all of its
                            // contrast has to come from the surface behind
                            // it. Darker than white in light mode, lighter
                            // than black in dark mode.
                            .glassEffect(
                                .regular.tint(
                                    colorScheme == .light
                                        ? Color.black.opacity(0.08)
                                        : Color.white.opacity(0.08)
                                ),
                                in: Rectangle()
                            )
                            .ignoresSafeArea(edges: .bottom)
                    } else {
                        Rectangle()
                            .fill(.bar)
                            .ignoresSafeArea(edges: .bottom)
                    }
                }
            }
        }
    }

    private var settingsSheetContent: some View {
        VStack(spacing: 16) {
            Text("Settings")
                .font(.headline)
            Toggle("Confirm moves before playing them", isOn: $confirmMovesEnabled)
                .onChange(of: confirmMovesEnabled) { _, _ in pendingMove = nil }
            Toggle("Shake to open Title & tags", isOn: $shakeOpensTitleTags)
            // For anyone the board doesn't work for — VoiceOver skips it
            // entirely — or who would rather type the coordinate than tap.
            Toggle("Enter moves as coordinates", isOn: $coordinateEntryEnabled)
            Toggle("Keep the screen awake", isOn: $keepScreenAwake)
            Toggle("Haptic feedback", isOn: $hapticsEnabled)
        }
        .padding()
    }

    // Mirrors GameRowView's own compact "13x13 · handicap 2 · komi 0.5 ·
    // 10 min" metadata line rather than a tall LabeledContent list — same
    // settings, far less vertical space.
    private func inviteMetaParts(_ game: GameState) -> [String] {
        var parts = ["\(game.size)x\(game.size)"]
        if game.handicap > 0 {
            parts.append(String(localized: "handicap %lld", defaultValue: "handicap \(game.handicap)"))
        }
        parts.append(
            game.komi == 0
                ? String(localized: "no komi")
                : String(localized: "komi %@", defaultValue: "komi \(formatScore(game.komi))")
        )
        parts.append(timeControlLabel(game))
        let myColor = reviewColorLabel(game.myColor == .black ? .black : .white)
        parts.append(String(localized: "you play %@", defaultValue: "you play \(myColor)"))
        return parts
    }

    // Same labels GameRowView gives a game-list row; a null timeControl is
    // how the server stores "unlimited".
    private func timeControlLabel(_ game: GameState) -> String {
        switch game.timeControl {
        case .standard: return String(localized: "10 min")
        case .correspondence: return String(localized: "24h per move")
        case nil: return String(localized: "Unlimited")
        }
    }

    private func inviteResponseSheetContent(_ game: GameState) -> some View {
        let opponentName = (game.myColor == .black ? game.whiteUsername : game.blackUsername) ?? "Someone"
        return VStack(spacing: 12) {
            Text("Game Invitation")
                .font(.headline)
            Text("\(opponentName) invited you to a game\(game.title?.isEmpty == false ? " — \(game.title!)" : "").")
                .multilineTextAlignment(.center)
            Text(inviteMetaParts(game).joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Group {
                if #available(iOS 26.0, *) {
                    Button {
                        Task { await respondToInvite(accept: true) }
                    } label: {
                        Text("Accept")
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(.primary)
                } else {
                    Button {
                        Task { await respondToInvite(accept: true) }
                    } label: {
                        Text("Accept").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .disabled(isBusy)
            Group {
                if #available(iOS 26.0, *) {
                    Button(role: .destructive) {
                        Task { await respondToInvite(accept: false) }
                    } label: {
                        Text("Reject").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .tint(.red)
                } else {
                    Button(role: .destructive) {
                        Task { await respondToInvite(accept: false) }
                    } label: {
                        Text("Reject").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .disabled(isBusy)
        }
        .padding()
    }

    private var deleteConfirmationSheetContent: some View {
        VStack(spacing: 16) {
            Text("Delete this game and all its moves? This cannot be undone.")
                .font(.headline)
                .multilineTextAlignment(.center)
            Group {
                if #available(iOS 26.0, *) {
                    Button(role: .destructive) {
                        showDeleteConfirmation = false
                        Task { await deleteGame() }
                    } label: {
                        Text("Delete").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .tint(.red)
                } else {
                    Button(role: .destructive) {
                        showDeleteConfirmation = false
                        Task { await deleteGame() }
                    } label: {
                        Text("Delete").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .disabled(isBusy)
            Group {
                if #available(iOS 26.0, *) {
                    Button {
                        showDeleteConfirmation = false
                    } label: {
                        // glassProminent doesn't auto-invert its label color
                        // for a light (white, in dark mode) tint.
                        Text("Cancel")
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(.primary)
                } else {
                    Button {
                        showDeleteConfirmation = false
                    } label: {
                        Text("Cancel").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding()
    }

    // Pass/Resign, opened by tapping the turn marker. Gated on "is a
    // participant" (myColor != nil), not "is it my turn" — Resign has
    // always been available off-turn too, only Pass is turn-gated, so
    // gating the sheet's opening by turn-ownership would wrongly block an
    // off-turn resignation. Mirrors today's actionRow's enablement exactly,
    // just relocated.
    @ViewBuilder
    private func actionsSheetContent(_ game: GameState) -> some View {
        VStack(spacing: 16) {
            Text(game.currentColor == .black ? "Black to move" : "White to move")
                .font(.headline)
            Group {
                if #available(iOS 26.0, *) {
                    Button {
                        showActionsSheet = false
                        Task { await pass() }
                    } label: {
                        // glassProminent doesn't auto-invert its label color
                        // for a light (white, in dark mode) tint — it stayed
                        // white-on-white without this explicit override.
                        Text("Pass")
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(.primary) // keeps the black-in-light/white-in-dark contrast the pre-26 fallback uses
                } else {
                    Button {
                        showActionsSheet = false
                        Task { await pass() }
                    } label: {
                        Text("Pass").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ActionButtonStyle(inverted: false))
                }
            }
            .disabled(!canAct(game) || isBusy)
            Group {
                if #available(iOS 26.0, *) {
                    Button(role: .destructive) {
                        showActionsSheet = false
                        Task { await resign() }
                    } label: {
                        Text("Resign").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .tint(.red) // an explicit tint rather than relying on the destructive role alone
                } else {
                    Button(role: .destructive) {
                        showActionsSheet = false
                        Task { await resign() }
                    } label: {
                        Text("Resign").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ActionButtonStyle(inverted: true))
                }
            }
            .disabled(game.myColor == nil || isBusy)
        }
        .padding()
    }

    // Mirrors the web client's footer: captures (+ clock, if timed) for
    // each side flanking a center turn-marker stone — colored per whose
    // turn it is, or standing in for the short result once the game isn't
    // still being played.
    //
    // Split into two rows rather than one variable-height column per side:
    // the turn marker is centered only against the captures row (fixed
    // height), with clocks/byoyomi segments — whose height varies once
    // byoyomi kicks in — entirely below and decoupled from that alignment.
    // Otherwise the marker would re-center itself vertically against
    // whatever the tallest side happens to be at the moment, overlapping
    // the clock/segments. Same reasoning for centering horizontally in its
    // own layer rather than between two Spacers: unequal side widths (e.g.
    // one side growing byoyomi segments) would shift how much space each
    // Spacer gets, drifting the "centered" item off true center.
    private func footerRow(_ game: GameState) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let nowMs = context.date.timeIntervalSince1970 * 1000
            let isTicking = game.status == "in_progress"
            VStack(spacing: 4) {
                ZStack {
                    HStack {
                        footerCaptures(.black, game: game)
                        Spacer()
                        footerCaptures(.white, game: game)
                    }
                    turnMarker(game)
                }
                // Pinned to the turn marker's own 44pt height regardless of
                // which control is centered here — the short-result button
                // is deliberately a bit taller (52pt) than that, and without
                // this the row (and so the whole footer) would grow to fit
                // it. Letting the ZStack clip to this fixed height instead
                // means the button's extra few points just overlay the
                // existing vertical padding around the row, which already
                // has room to spare.
                .frame(height: 44)
                // Always rendered, even for an untimed game — hidden with
                // .opacity rather than omitted, so this row's height (and so
                // the footer's overall height) doesn't change based on
                // whether the game happens to have a clock. The untimed
                // branch renders inert placeholder text rather than a real
                // footerClock: computeLiveClock divides elapsed time by
                // byoyomiSeconds, which is 0 for an untimed game, and if
                // isTicking is also true that's a divide-by-zero producing
                // an infinite Double — Int(that) is a fatal crash, not just
                // a bad number. The placeholder matches ClockView's plain
                // (non-byoyomi) font/layout closely enough that this row's
                // height is the same either way.
                HStack(alignment: .top) {
                    if game.mainTimeSeconds != nil {
                        footerClock(.black, game: game, isTicking: isTicking, nowMs: nowMs)
                        Spacer()
                        footerClock(.white, game: game, isTicking: isTicking, nowMs: nowMs)
                    } else {
                        Text("00:00").font(.subheadline.monospacedDigit())
                        Spacer()
                        Text("00:00").font(.subheadline.monospacedDigit())
                    }
                }
                .opacity(game.mainTimeSeconds != nil ? 1 : 0)
                .allowsHitTesting(game.mainTimeSeconds != nil)
            }
            .padding(.horizontal, 16)
        }
    }

    // A small stone-colored circle for the footer (capture indicators, the
    // turn marker) — always bordered with the adaptive .primary color
    // (black in light mode, white in dark mode) rather than a fixed dark
    // stroke, since a plain black circle is otherwise nearly invisible
    // against the footer's dark-mode background. Board stones don't need
    // this (BoardGridView's stoneShape): the wood background behind them
    // doesn't change with the system theme.
    @ViewBuilder
    private func footerStone(_ color: StoneColor, size: CGFloat) -> some View {
        Circle()
            .fill(color == .black ? Color.black : Color.white)
            .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
            .frame(width: size, height: size)
    }

    @ViewBuilder
    private func footerCaptures(_ color: StoneColor, game: GameState) -> some View {
        let reviewCaptures = displayedCaptures(game)
        let captures = color == .black ? reviewCaptures.black : reviewCaptures.white
        HStack(spacing: 4) {
            footerStone(color, size: 14)
            Text("\(captures)")
                .font(.subheadline.monospacedDigit())
        }
    }

    @ViewBuilder
    private func footerClock(_ color: StoneColor, game: GameState, isTicking: Bool, nowMs: Double) -> some View {
        let clock = computeLiveClock(
            isTicking: isTicking && game.currentColor == color,
            storedRemainingMs: Double(color == .black ? (game.blackTimeRemainingMs ?? 0) : (game.whiteTimeRemainingMs ?? 0)),
            storedPeriodsLeft: color == .black ? (game.blackPeriodsLeft ?? 0) : (game.whitePeriodsLeft ?? 0),
            byoyomiSeconds: Double(game.byoyomiSeconds ?? 0),
            turnStartedAt: game.turnStartedAt.map(Double.init),
            nowMs: nowMs
        )
        ClockView(
            clock: clock,
            byoyomiPeriods: game.byoyomiPeriods,
            isActive: isTicking && game.currentColor == color,
            segmentAlignment: color == .black ? .leading : .trailing
        )
    }

    @ViewBuilder
    private func turnMarker(_ game: GameState) -> some View {
        switch game.status {
        case "in_progress":
            // Same 44pt circle as finalizeButton below, so the footer's
            // center slot stays a consistent size across game phases. The
            // whole button is the stone: the colour comes from the glass
            // style's own tint, with nothing drawn on top of it. Anything
            // overlaid — the hairline rim this used to have, or a stone
            // shape inside — is a separate layer that can't deform with
            // the material, so it stays rigid while the glass stretches
            // under a press and makes the button read as static no matter
            // how lively the glass underneath actually is. Prominent
            // rather than plain .glass because a plain tint is far too
            // weak to carry the colour: on a dark background a
            // white-tinted glass circle renders dark, which would make
            // "whose turn is it" unreadable. No .disabled(...) here,
            // matching the board's own stones: a spectator's tap is just
            // a no-op, not a dimmed control.
            let action: () -> Void = {
                if game.myColor != nil { showActionsSheet = true }
            }
            let tint: Color = game.currentColor == .black ? .black : .white
            if #available(iOS 26.0, *) {
                // Same glass style, tint and border shape as the
                // short-result button below — the difference that mattered
                // was never the style (the plain-.glass nav buttons down
                // there respond too), it was the label. A glass button
                // only animates under a press when it has real rendered
                // content: Text for the result button, an Image for the
                // nav buttons. Color.clear gives it none, with or without
                // a contentShape, and the button sits inert.
                //
                // So the label is Text, exactly like the result button's —
                // but a single "." drawn in clear. It's real content, so
                // the glass responds to a press, while being both tiny and
                // invisible: a same-tint circle was still given away by the
                // glass's own highlights falling differently on it, and
                // anything that large separates visibly when the shape
                // stretches. A clear period has no edge to catch the light
                // and nothing to see lagging behind.
                Button(action: action) {
                    Text(".")
                        .foregroundStyle(.clear)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.glassProminent)
                .tint(tint)
                .buttonBorderShape(.circle)
            } else {
                Button(action: action) {
                    Circle()
                        .fill(tint)
                        .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
            }
        case "scoring":
            finalizeButton(game)
        default:
            if let shortResult = game.shortResult {
                // Same fill-the-shape-with-the-winner's-color treatment as
                // the in-progress turn marker, just a touch bigger (52pt vs
                // 44pt) since it also has to hold text. The size itself
                // stays fixed regardless of score length ("B+5.5" vs
                // "W+123.5") — .minimumScaleFactor shrinks the font instead
                // of the button growing, so the footer's center slot never
                // shifts width across game phases.
                // Winner's colour fills the whole button via the glass
                // style's tint, with nothing drawn over it — see the turn
                // marker above: an overlaid rim is a separate layer that
                // can't stretch with the material, so it stays a rigid
                // circle while the glass deforms under a press, which is
                // exactly what made this read as a static disc sitting in
                // a glass button. The text is the only thing inside, and
                // takes the contrasting colour since the fill is opaque.
                let winnerIsBlack = shortResult.hasPrefix("B")
                let tint: Color = winnerIsBlack ? .black : .white
                let textColor: Color = winnerIsBlack ? .white : .black
                let label = Text(shortResult)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.4)
                    .foregroundStyle(textColor)
                    .frame(width: 52, height: 52)
                // Flanking First/Last review-nav buttons, ~62% the result
                // button's size, per request — no separate Prev/Next: those
                // happen by tapping a stone directly in the move-chain strip
                // instead, to keep this footer row from getting crowded.
                HStack(spacing: 8) {
                    ReviewNavButton(
                        systemName: "chevron.left",
                        disabled: history == nil || reviewMoveNumber == 0,
                        step: { goToMove((reviewMoveNumber ?? 0) - 1) },
                        jump: { goToMove(0) }
                    )
                    if #available(iOS 26.0, *) {
                        Button {
                            showResultSheet = true
                        } label: {
                            label
                        }
                        .buttonStyle(.glassProminent)
                        .tint(tint)
                        .buttonBorderShape(.circle)
                    } else {
                        Button {
                            showResultSheet = true
                        } label: {
                            label
                                .background(tint, in: Circle())
                                .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                    ReviewNavButton(
                        systemName: "chevron.right",
                        disabled: history == nil || reviewMoveNumber == (history?.moves.count ?? 1) - 1,
                        step: { goToMove((reviewMoveNumber ?? 0) + 1) },
                        jump: { goToMove((history?.moves.count ?? 1) - 1) }
                    )
                }
            }
        }
    }

    // Icon-only (no label) so it fits the same footer slot the turn marker
    // and short result occupy — a Liquid Glass circle on iOS 26+, falling
    // back to a translucent-material circle on older versions still within
    // this app's iOS 17 deployment target.
    @ViewBuilder
    private func finalizeButton(_ game: GameState) -> some View {
        let action: () -> Void = { Task { await finalizeScoring() } }
        let icon = Image(systemName: "checkmark")
            .font(.system(size: 18, weight: .semibold))
            .frame(width: 44, height: 44)
        if #available(iOS 26.0, *) {
            Button(action: action) { icon }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .disabled(game.myColor == nil || isBusy)
        } else {
            Button(action: action) {
                icon.background(.ultraThinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(game.myColor == nil || isBusy)
        }
    }

    // Mirrors client/src/pages/Game.tsx's describeResult: the sentence is
    // built from the SGF-style shortResult ("W+6.5", "B+R", "W+T"), with a
    // catalogue entry per color so translators write whole sentences.
    private func plainResult(_ game: GameState) -> String {
        switch game.shortResult {
        case nil:
            return String(localized: "Game over")
        case "B+R":
            return String(localized: "B+R", defaultValue: "Black wins by resignation")
        case "W+R":
            return String(localized: "W+R", defaultValue: "White wins by resignation")
        case "B+T":
            return String(localized: "B+T", defaultValue: "Black wins on time")
        case "W+T":
            return String(localized: "W+T", defaultValue: "White wins on time")
        case let shortResult?:
            let margin = String(shortResult.dropFirst(2))
            return shortResult.hasPrefix("B")
                ? String(localized: "B+%@", defaultValue: "Black wins by \(margin)")
                : String(localized: "W+%@", defaultValue: "White wins by \(margin)")
        }
    }

    @ViewBuilder
    private func resultSheetContent(_ game: GameState) -> some View {
        VStack(spacing: 16) {
            Text(plainResult(game))
                .font(.headline)
                .multilineTextAlignment(.center)
                // Clear of the sheet's grabber, which sits close enough to
                // the headline to read as crowding it.
                .padding(.top, 16)
            // The stone markers' own centre line is this row's centre line:
            // each player's name-and-details column is centred against it
            // (an HStack's default .center alignment), so extra detail lines
            // grow either side of the stones instead of shifting them.
            // Unscored finishes (B+R, W+T) keep the row, with empty stones —
            // the setup details below are worth showing either way.
            HStack(spacing: 8) {
                playerColumn(
                    username: game.blackUsername,
                    userId: game.blackUserId,
                    details: playerDetails(game, color: .black)
                )
                resultPointsStone(.black, score: game.resultBreakdown?.black)
                Spacer().frame(width: 20)
                resultPointsStone(.white, score: game.resultBreakdown?.white)
                playerColumn(
                    username: game.whiteUsername,
                    userId: game.whiteUserId,
                    details: playerDetails(game, color: .white)
                )
            }
            .font(.subheadline)
            VStack(spacing: 4) {
                Text(setupLine(game))
                if let startedLine = startedLine(game) {
                    Text(startedLine)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            // Only a scoring-based finish can be reopened (a
            // resignation/timeout has no scoring to redo) — the same
            // condition resultBreakdown itself is gated on server-side.
            if game.resultBreakdown != nil, game.myColor != nil {
                Group {
                    if #available(iOS 26.0, *) {
                        Button(reopenScoringLabel(game)) {
                            Task { await reopenScoring() }
                        }
                        .buttonStyle(.glass)
                    } else {
                        Button(reopenScoringLabel(game)) {
                            Task { await reopenScoring() }
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .disabled(isBusy)
                if let pendingReopenBy = game.pendingReopenBy {
                    Text(pendingReopenBy == myStoneColor(game)
                        ? "Waiting for the other player to confirm."
                        : "The other player requested to reopen scoring.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
    }

    // One player's name with their setup details stacked underneath it.
    @ViewBuilder
    private func playerColumn(username: String?, userId: String?, details: [String]) -> some View {
        VStack(spacing: 2) {
            profileLink(username: username, userId: userId)
            ForEach(details, id: \.self) { detail in
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(.center)
    }

    // Per-player setup details: GNU Go's level goes under whichever side it
    // plays, and the handicap stones always under black, who receives them.
    private func playerDetails(_ game: GameState, color: StoneColor) -> [String] {
        var details: [String] = []
        if let level = game.gnugoLevel, isAiSide(game, color: color) {
            details.append(String(localized: "level %lld", defaultValue: "level \(level)"))
        }
        if color == .black, game.handicap > 0 {
            details.append(String(localized: "handicap %lld", defaultValue: "handicap \(game.handicap)"))
        }
        return details
    }

    // GNU Go plays through one shared account whose username is literally
    // "gnugo" (server/src/seed.ts's AI_USERNAME), so matching on it is what
    // tells the two sides apart — including for a spectator, whose own
    // myColor is nil and so says nothing about which side the AI is on.
    private func isAiSide(_ game: GameState, color: StoneColor) -> Bool {
        game.isAiOpponent && (color == .black ? game.blackUsername : game.whiteUsername) == "gnugo"
    }

    // The settings both players share, mirroring the same two fields in
    // GameRowView's metadata line.
    private func setupLine(_ game: GameState) -> String {
        let komi = game.komi == 0
            ? String(localized: "no komi")
            : String(localized: "komi %@", defaultValue: "komi \(formatScore(game.komi))")
        return "\(komi) · \(timeControlLabel(game))"
    }

    // nil only against a server that predates createdAt being included in
    // GET /api/games/:id — the line is simply left out then.
    private func startedLine(_ game: GameState) -> String? {
        guard let createdAt = game.createdAt else { return nil }
        let started = Date(timeIntervalSince1970: Double(createdAt) / 1000)
        let date = started.formatted(date: .abbreviated, time: .shortened)
        return String(localized: "Game started on %@", defaultValue: "Game started on \(date)")
    }

    // Every row in this sheet has a fixed height, so adding them up sizes it
    // to its content — snug whether or not there are per-player details, a
    // score breakdown to reopen, or a pending reopen request.
    private func resultSheetHeight(_ game: GameState) -> CGFloat {
        let detailLines = max(
            playerDetails(game, color: .black).count,
            playerDetails(game, color: .white).count
        )
        // padding + the headline's own top inset + result headline + the
        // stone row + the setup/started lines
        var height: CGFloat = 32 + 16 + 22 + 16 + max(52, 22 + CGFloat(detailLines) * 17)
        height += 16 + (game.createdAt == nil ? 16 : 36)
        if game.resultBreakdown != nil, game.myColor != nil {
            height += 16 + 34
            if game.pendingReopenBy != nil {
                height += 4 + 16
            }
        }
        return height
    }

    // A player's name in the result sheet, tappable to their profile. Safe
    // to do here (unlike a game-list row, which is already a giant tap
    // target of its own) since this sheet has no other tap target to
    // conflict with.
    @ViewBuilder
    private func profileLink(username: String?, userId: String?) -> some View {
        if let username, let userId {
            Button {
                showResultSheet = false
                deepLinkRouter.targetProfileId = userId
            } label: {
                // Black in light mode, white in dark — matches the web
                // client's own plain-text links — rather than the default
                // system blue a Button's label would otherwise pick up.
                // foregroundStyle alone isn't enough to override that
                // default tint here; .buttonStyle(.plain) below is what
                // actually stops it from recoloring the label blue.
                Text(username).underline().foregroundStyle(.primary)
            }
            .buttonStyle(.plain)
        } else {
            Text(username ?? "—")
        }
    }

    // MyColor has a 'both' case StoneColor doesn't, so pendingReopenBy
    // (always a definite color) can't be compared to myColor directly.
    private func myStoneColor(_ game: GameState) -> StoneColor? {
        switch game.myColor {
        case .black: return .black
        case .white: return .white
        case .both, .none: return nil
        }
    }

    // Mirrors client/src/pages/Game.tsx's describeReopenAction.
    private func reopenScoringLabel(_ game: GameState) -> String {
        if game.myColor == .both || game.isAiOpponent {
            return String(localized: "Reopen Scoring")
        }
        guard let pendingReopenBy = game.pendingReopenBy else {
            return String(localized: "Request Reopen Scoring")
        }
        return pendingReopenBy == myStoneColor(game)
            ? String(localized: "Cancel Reopen Request")
            : String(localized: "Confirm Reopen Scoring")
    }

    // Sized to comfortably fit a 3-digit score (e.g. "182.5") without the
    // text ellipsizing. A nil score (a resignation or timeout, which has no
    // point count) leaves the stone empty rather than dropping it.
    @ViewBuilder
    private func resultPointsStone(_ color: StoneColor, score: Double?) -> some View {
        ZStack {
            Circle()
                .fill(color == .black ? Color.black : Color.white)
                .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
            if let score {
                Text(formatScore(score))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(color == .black ? Color.white : Color.black)
            }
        }
        .frame(width: 52, height: 52)
    }

    // Just the "Estimated: ..." line, with no explainer sentence — the
    // segmented Dead/Seki picker itself already makes the current mode
    // obvious, and dropping it keeps this line's length (the only thing
    // that changes as marks are toggled) from affecting anything above it.
    private func estimateText(_ game: GameState) -> String? {
        guard let preview = livePreview(game) else { return nil }
        let winner = reviewColorLabel(preview.winner)
        return String(
            localized: "Estimated: %@ wins by %@",
            defaultValue: "Estimated: \(winner) wins by \(formatScore(preview.margin))"
        )
    }

    private func formatScore(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(format: "%.1f", value)
    }

    private func isInteractive(_ game: GameState) -> Bool {
        game.status == "scoring" ? game.myColor != nil : canAct(game)
    }

    // Mirrors server/src/server.ts's canActAsColor: the logged-in viewer can
    // act as `color` if they're that color, or 'both' (a local game).
    private func canAct(_ game: GameState) -> Bool {
        guard game.status == "in_progress" else { return false }
        switch game.myColor {
        case .both: return true
        case .black: return game.currentColor == .black
        case .white: return game.currentColor == .white
        case .none: return false
        }
    }

    // Gates the "Recompute GNU Go's move" menu item — only meaningful while
    // actually waiting on GNU Go, i.e. an AI opponent whose turn it
    // currently is (myColor excludes .both, since a local game has no AI).
    private func isAiTurn(_ game: GameState) -> Bool {
        guard game.isAiOpponent, game.status == "in_progress", let myColor = game.myColor, myColor != .both else {
            return false
        }
        let myStoneColor: StoneColor = myColor == .black ? .black : .white
        return game.currentColor != myStoneColor
    }

    // Mirrors client/src/pages/Game.tsx's sekiActive: only dims the board
    // while actively in Seki mode (not just whenever a seki mark exists),
    // so switching to Dead mode isn't fighting the dim effect for attention.
    private func sekiActive(_ game: GameState) -> Bool {
        game.status == "scoring" && markMode == .seki && !pendingSekiKeys.isEmpty
    }

    // Always on for a finished game — no toggle, unlike the web client's
    // Review/Live menu item (which is also available mid-game there).
    private func isReviewing(_ game: GameState) -> Bool {
        game.status == "finished"
    }

    private var reviewEntry: HistoryEntry? {
        guard let history, let reviewMoveNumber, history.moves.indices.contains(reviewMoveNumber) else {
            return nil
        }
        return history.moves[reviewMoveNumber]
    }

    private func displayedBoard(_ game: GameState) -> Board {
        isReviewing(game) ? (reviewEntry?.board ?? game.board) : game.board
    }

    private func highlightedPoint(_ game: GameState) -> Point? {
        isReviewing(game) ? reviewEntry?.point : game.lastMove
    }

    private func displayedCaptures(_ game: GameState) -> Captures {
        if isReviewing(game), let history, let reviewMoveNumber {
            return sumCaptures(history.moves, upTo: reviewMoveNumber)
        }
        return game.captures
    }

    private func goToMove(_ n: Int) {
        guard let history else { return }
        reviewMoveNumber = min(max(n, 0), history.moves.count - 1)
    }

    private static let reviewColumnLabels = Array("ABCDEFGHJKLMNOPQRST")
    private static let coordinateSeparators = CharacterSet(charactersIn: "-–—,. ")

    private func reviewColorLabel(_ color: StoneColor?) -> String {
        switch color {
        case .black: return String(localized: "Black")
        case .white: return String(localized: "White")
        case nil: return ""
        }
    }

    // Typing a point instead of tapping it: the coordinate as it is
    // written anyway ("D4"), validated as it is typed, played with the
    // keyboard's Go key or the button. Naming a point is one field however
    // big the board is, where swiping the board itself would be hundreds
    // of stops.
    @ViewBuilder
    private func coordinateEntry(_ game: GameState) -> some View {
        let point = parseCoordinate(coordinateText, size: game.size)
        // Nothing typed yet is neither right nor wrong — and neither is a
        // column with its row still to come ("D", "4-"), which is a
        // coordinate half-written rather than a wrong one. Both leave the
        // hint standing on its own, with no verdict either way.
        let typedAnything = !coordinateText.trimmingCharacters(in: .whitespaces).isEmpty
        let isIncomplete = point == nil && coordinateRest(coordinateText, size: game.size) == ""
        let showsVerdict = typedAnything && !isIncomplete
        let isValid = point != nil && coordinateError == nil
        VStack(alignment: .leading, spacing: 8) {
            // Above the field, not below it: with the keyboard up, the
            // field is the last thing on screen, so anything under it is
            // behind the keyboard and never seen while typing.
            Text(coordinateError ?? coordinateEntryStatus(game, point: point, isIncomplete: isIncomplete))
                .font(.subheadline)
                .foregroundStyle(!showsVerdict ? Color.secondary : (isValid ? Color.primary : Color.red))
            // Whatever keyboard the device's language gives: both
            // notations are short, and either keyboard reaches both.
            TextField("Point", text: $coordinateText)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($coordinateFocused)
                .onSubmit { playCoordinate(game, point: point) }
                // The verdict sits in the field, at the end of what is
                // being typed, rather than only in the line above it. The
                // colour carries it, and the symbol carries it again for
                // anyone who can't separate the two colours.
                .overlay(alignment: .trailing) {
                    if showsVerdict {
                        Image(systemName: isValid ? "checkmark.circle" : "exclamationmark.circle")
                            .foregroundStyle(isValid ? Color.green : Color.red)
                            .padding(.trailing, 8)
                            // The line above already says the same thing.
                            .accessibilityHidden(true)
                    }
                }
                // A red rim around the field too, so a wrong point is
                // obvious without reading either.
                .overlay {
                    if showsVerdict, !isValid {
                        RoundedRectangle(cornerRadius: 5)
                            .stroke(Color.red, lineWidth: 1.5)
                    }
                }
        }
        .padding(.horizontal)
        .onChange(of: coordinateFocused) { _, focused in coordinateEditing = focused }
        // The entry only exists while it is your move, so appearing is
        // itself the signal that the opponent has played.
        // The entry only exists while it is your move, so appearing is
        // itself the signal that the opponent has played: focusing here is
        // what lets a game be played from a keyboard without touching the
        // phone. Anyone who would rather not have a keyboard come up can
        // turn coordinate entry off and play on the board.
        .onAppear { focusCoordinateEntry() }
        .onChange(of: game.currentColor) { _, _ in focusCoordinateEntry() }
        // Switching coordinate entry on from the settings sheet builds the
        // field behind the sheet: focusing it there would throw a keyboard
        // over the sheet being read. It waits for the sheet to close.
        .onChange(of: isSheetOpen) { _, open in
            if !open {
                focusCoordinateEntry()
            }
        }
        // Previewing the typed point as the board's pending stone is the
        // same marker a tap-to-confirm move uses, so "where is D4" is
        // answered on the board itself rather than only in words.
        .onChange(of: coordinateText) { _, _ in
            let typed = parseCoordinate(coordinateText, size: game.size)
            coordinateError = nil
            guard game.status == "in_progress" else {
                pendingMove = nil
                return
            }
            pendingMove = typed
            guard let typed else { return }
            Task {
                do {
                    let result = try await transport.validateMove(
                        gameId: gameId,
                        x: typed.x,
                        y: typed.y,
                        color: game.currentColor
                    )
                    // The field may have moved on while this was in
                    // flight; only the point still typed gets an answer.
                    guard parseCoordinate(coordinateText, size: game.size) == typed else { return }
                    // The server sends these as the English sentence,
                    // which is the catalogue key itself (see shared's
                    // validateMove) — an unknown one falls back to the
                    // sentence as sent.
                    coordinateError = result.valid
                        ? nil
                        : result.error.map { String(localized: String.LocalizationValue($0)) }
                            ?? String(localized: "Invalid move")
                } catch {
                    // A failed check is not a failed move — say nothing and
                    // let the play attempt itself report any problem.
                }
            }
        }
    }

    // "D4" or "4-4" -> the point it names, or nil if this board has no
    // such point. Both notations are accepted because both keyboards are:
    // the digits-and-dash plane this field opens on writes the numbered
    // form, a hardware keyboard or dictation may well write the lettered
    // one. Columns skip I, as everywhere else the notation is written,
    // column 1 is A, and row 1 is the bottom of the board.
    private func parseCoordinate(_ text: String, size: Int) -> Point? {
        let columns = Self.reviewColumnLabels.prefix(size)
        let parts = coordinateParts(text)
        let column: Int
        let row: Int
        if let first = parts.first, first.count == 1, let index = columns.firstIndex(of: Character(first)) {
            guard parts.count == 2, let typedRow = coordinateRow(parts[1], size: size) else { return nil }
            column = index
            row = typedRow
        } else {
            guard parts.count == 2,
                  let typedColumn = coordinateNumber(parts[0]), let typedRow = coordinateNumber(parts[1]),
                  typedColumn >= 1, typedColumn <= size
            else { return nil }
            column = typedColumn - 1
            row = typedRow
        }
        guard row >= 1, row <= size else { return nil }
        return Point(x: column, y: size - row)
    }

    // Splits "D4", "D 7", "4-4", "cztery siedem" into their two halves.
    // Dash, comma, full stop and space all separate them: which one arrives
    // depends on the keyboard and on what dictation heard, and none of them
    // means anything else here. "D4" has no separator at all, so a leading
    // column letter is split off by itself.
    private func coordinateParts(_ text: String) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespaces).uppercased()
        guard let first = trimmed.first else { return [] }
        if first.isLetter, trimmed.dropFirst().first?.isNumber == true {
            return [String(first), String(trimmed.dropFirst())]
        }
        // Two letters, no separator: the row named by letter as well as
        // the column ("DG" is D7), so a coordinate can be written without
        // ever leaving the letter keyboard.
        if trimmed.count == 2, trimmed.allSatisfy(\.isLetter) {
            return trimmed.map(String.init)
        }
        return trimmed
            .components(separatedBy: Self.coordinateSeparators)
            .filter { !$0.isEmpty }
    }

    // A row written as a letter counts from the same A-T that names the
    // columns, I skipped in both — so the letters read off one edge of the
    // board or the other, not SGF's own a-s lettering. Otherwise it is a
    // number like any other.
    private func coordinateRow(_ text: String, size: Int) -> Int? {
        if text.count == 1,
           let index = Self.reviewColumnLabels.prefix(size).firstIndex(of: Character(text)) {
            return index + 1
        }
        return coordinateNumber(text)
    }

    // Digits, or the number as a word — dictation writes "7" as "siedem"
    // in Polish, "seven" in English, and there is no way to ask it not to.
    // NumberFormatter reads those back in whatever language the device is
    // set to, so this needs no word list of its own.
    private func coordinateNumber(_ text: String) -> Int? {
        if let value = Int(text) {
            return value
        }
        let formatter = NumberFormatter()
        formatter.numberStyle = .spellOut
        formatter.locale = .current
        return formatter.number(from: text.lowercased())?.intValue
    }

    // Plays immediately even with "Confirm moves before playing them" on:
    // that setting guards against a mis-tap on a board, and a coordinate
    // typed out and shown back as "D4 is empty" has already been confirmed
    // by reading it. Asking twice would mean entering the same move twice.
    // The column half of what has been typed so far, whether or not the
    // row is there yet: "D", "D4", "4" and "4-" all name column D. Only
    // for lighting the line on the board — a move still needs both halves.
    private func partialColumn(_ text: String, size: Int) -> Int? {
        guard let first = coordinateParts(text).first else { return nil }
        if first.count == 1, let index = Self.reviewColumnLabels.prefix(size).firstIndex(of: Character(first)) {
            return index
        }
        guard let typed = coordinateNumber(first), typed >= 1, typed <= size else { return nil }
        return typed - 1
    }

    // What is left after the column and any separator — "" while only the
    // column has been typed ("D", "4", "4-"), nil when the text doesn't
    // start with a column of this board at all.
    private func coordinateRest(_ text: String, size: Int) -> String? {
        let parts = coordinateParts(text)
        guard let first = parts.first else { return nil }
        let namesColumn = (first.count == 1 && Self.reviewColumnLabels.prefix(size).contains(Character(first)))
            || coordinateNumber(first).map { $0 >= 1 && $0 <= size } == true
        guard namesColumn else { return nil }
        return parts.dropFirst().joined(separator: " ")
    }

    // Any sheet over the board: while one is up it owns the screen, and
    // the field underneath waits its turn.
    private var isSheetOpen: Bool {
        showActionsSheet || showSettingsSheet || showResultSheet || showTagsSheet
            || showDeleteConfirmation || gameShare != nil || game?.pendingInviteResponse == true
    }

    // One runloop hop after the field appears: setting focus in the same
    // pass as the view that takes it is too early, and SwiftUI drops it.
    private func focusCoordinateEntry() {
        guard !isSheetOpen else { return }
        DispatchQueue.main.async { coordinateFocused = true }
    }

    private func playCoordinate(_ game: GameState, point: Point?) {
        guard let point, !isBusy else { return }
        if game.status == "scoring" {
            toggleMarkedGroup(x: point.x, y: point.y, in: game)
        } else {
            pendingMove = nil
            Task { await makeMove(x: point.x, y: point.y) }
        }
        coordinateText = ""
        coordinateError = nil
    }

    // What is at the point just typed, so a VoiceOver user can tell an
    // empty point from an occupied one without the board to read — and
    // what is wrong with what they typed, while it names no point yet.
    private func coordinateEntryStatus(_ game: GameState, point: Point?, isIncomplete: Bool) -> String {
        // D4 is on every board size this app offers, so the example is
        // part of the sentence rather than built from the board — the
        // whole hint, wording and example both, is the translator's.
        guard !coordinateText.trimmingCharacters(in: .whitespaces).isEmpty, !isIncomplete else {
            return String(localized: "Enter a point, for example D4 or 4-4")
        }
        guard let point else {
            let typed = coordinateText.trimmingCharacters(in: .whitespaces).uppercased()
            return String(
                localized: "%@ is not a point on this board",
                defaultValue: "\(typed) is not a point on this board"
            )
        }
        let label = "\(Self.reviewColumnLabels[point.x])\(game.size - point.y)"
        switch displayedBoard(game)[point.y][point.x] {
        case .black:
            return String(localized: "%@ has a black stone", defaultValue: "\(label) has a black stone")
        case .white:
            return String(localized: "%@ has a white stone", defaultValue: "\(label) has a white stone")
        case nil:
            return String(localized: "%@ is empty", defaultValue: "\(label) is empty")
        }
    }

    private func coordinateActionLabel(_ game: GameState, point: Point?) -> String {
        guard let point else { return String(localized: "Play") }
        let label = "\(Self.reviewColumnLabels[point.x])\(game.size - point.y)"
        return game.status == "scoring"
            ? String(localized: "Mark the group at %@", defaultValue: "Mark the group at \(label)")
            : String(localized: "Play %@", defaultValue: "Play \(label)")
    }

    // Mirrors client/src/pages/Game.tsx's describeEntry.
    private func describeEntry(_ entry: some MoveEventDescribable, size: Int) -> String {
        switch entry.eventType {
        case "START":
            return String(localized: "Start of game")
        case "HANDICAP":
            return String(localized: "Handicap stones placed")
        case "PASS":
            let color = reviewColorLabel(entry.color)
            return String(localized: "%@ passed", defaultValue: "\(color) passed")
        case "RESIGN":
            let color = reviewColorLabel(entry.color)
            return String(localized: "%@ resigned", defaultValue: "\(color) resigned")
        case "MOVE":
            let color = reviewColorLabel(entry.color)
            guard let point = entry.point else {
                return String(localized: "%@ played %@", defaultValue: "\(color) played \("")")
            }
            let label = "\(Self.reviewColumnLabels[point.x])\(size - point.y)"
            let captureNote = entry.capturedPoints.isEmpty
                ? ""
                : String(
                    localized: " (captured %lld)",
                    defaultValue: " (captured \(entry.capturedPoints.count))"
                )
            let move = String(localized: "%@ played %@", defaultValue: "\(color) played \(label)")
            return move + captureNote
        default:
            return ""
        }
    }

    // The move chain: a flat, stone-colored circular marker per logged
    // event, reusing BoardGridView's own stone colors/shape (just bigger,
    // 40pt — comfortably fits a 3-digit move number at 13pt bold, matching
    // the equivalent web element's own proportions) rather than a new
    // style. A colorless event (START/HANDICAP) gets a dashed neutral ring
    // instead of a stone fill. Tapping one jumps review straight to it.
    @ViewBuilder
    private func moveChainMarker(_ entry: HistoryEntry, size: Int) -> some View {
        let isCurrent = entry.moveNumber == reviewMoveNumber
        Button {
            goToMove(entry.moveNumber)
        } label: {
            ZStack {
                switch entry.color {
                case .black:
                    // A plain black fill nearly disappears against this
                    // list's own dark-mode background — the same .primary
                    // hairline rim footerStone uses for exactly that reason
                    // (invisible in the one case that needs it, negligible
                    // in the three that don't).
                    Circle()
                        .fill(Color.black)
                        .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
                case .white:
                    Circle().fill(Color(red: 0.97, green: 0.94, blue: 0.87))
                case nil:
                    Circle().strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                        .foregroundStyle(.secondary)
                }
                Text("\(entry.moveNumber)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(entry.color == .black ? .white : (entry.color == .white ? .black : .primary))
            }
            .frame(width: 40, height: 40)
            // The "current" marker is called out with just a bold .primary
            // ring (black in light mode, white in dark) — no shadow/glow —
            // so it reads by the same light/dark contrast the rest of the
            // board already uses, as a single distinct edge rather than a
            // soft effect. Drawn as its own larger circle (not stroked flush
            // against the stone) so the gap between stone edge and ring is
            // equally visible on both black and white markers — flush would
            // have coincided with black's own separate hairline border while
            // leaving white's bare edge looking thinner.
            .overlay(
                Circle()
                    .stroke(Color.primary, lineWidth: isCurrent ? 2.5 : 0)
                    .frame(width: 46, height: 46)
            )
        }
        .buttonStyle(.plain)
        // Without this VoiceOver reads only the number drawn in the marker.
        // The label is the same sentence the line above the list shows once
        // this move is selected, so hearing it and selecting it agree.
        // Text(verbatim:) because describeEntry already returns a localized
        // sentence — interpolating it into a label literal would have
        // SwiftUI look it up as a catalogue key of its own.
        .accessibilityLabel(Text(verbatim: "\(entry.moveNumber). \(describeEntry(entry, size: size))"))
        .accessibilityAddTraits(isCurrent ? [.isSelected] : [])
    }

    // Live "what you'll get" preview — mirrors client/src/pages/Game.tsx's
    // live-preview block, using the same applyDeadStones → scoreBoard
    // pipeline (Models/Scoring.swift) the server uses at finalize time.
    private func livePreview(_ game: GameState) -> ScoreResult? {
        guard game.status == "scoring" else { return nil }
        let deadPointsArray = pendingDeadKeys.compactMap(parsePointKey)
        let sekiPointsArray = pendingSekiKeys.compactMap(parsePointKey)
        let (effectiveBoard, effectiveCaptures) = applyDeadStones(game.board, game.captures, deadPointsArray)
        return scoreBoard(effectiveBoard, effectiveCaptures, komi: game.komi, declaredSekiPoints: sekiPointsArray)
    }

    private func territoryKeys(_ points: [Point]) -> Set<String> {
        Set(points.map { "\($0.x),\($0.y)" })
    }

    private func parsePointKey(_ key: String) -> Point? {
        let parts = key.split(separator: ",").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return Point(x: parts[0], y: parts[1])
    }

    // surfacingErrors is off for the live socket's own refetches — see the
    // catch at the bottom.
    private func load(surfacingErrors: Bool = true) async {
        do {
            if game == nil, history == nil {
                // The very first load of this game in this view's lifetime:
                // fetch the detail and history concurrently, since there's
                // no way yet to know whether it'll turn out finished. This
                // used to depend on a hint passed in from wherever the view
                // was opened from (a list row's cached status) — but every
                // other way into a game (a push-notification deep link, a
                // freshly created game) had no reliable way to supply that
                // hint (nothing to look up on a cold launch before the list
                // has even loaded), silently falling back to the slow
                // sequential path below. Gating on "nothing fetched yet"
                // instead needs no hint from any caller and covers all of
                // them uniformly. Both requests are awaited before either
                // `game` or `history` is assigned, so the board, title, and
                // move chain all appear in the same SwiftUI update rather
                // than the board/title popping in first. Once this first
                // load lands, later reloads (pull-to-refresh, live-socket
                // refetch) fall through to the plain path below, which only
                // ever fetches history for a game already confirmed
                // finished — never repeatedly for one still being played.
                async let gameFetch = APIClient.withRetry { try await transport.state(gameId: gameId) }
                async let historyFetch = try? APIClient.withRetry { try await transport.history(gameId: gameId) }
                let fetchedGame = try await gameFetch
                let fetchedHistory = await historyFetch
                game = fetchedGame
                if fetchedGame.status == "finished", let fetchedHistory {
                    history = fetchedHistory
                    reviewMoveNumber = fetchedHistory.moves.count - 1
                }
            } else {
                game = try await APIClient.withRetry { try await transport.state(gameId: gameId) }
            }
            pendingDeadKeys = []
            // A pending (unconfirmed) move marker only makes sense for the
            // turn it was placed on — a fresh load always means the turn
            // has moved on one way or another (our own confirmed move, the
            // opponent's move arriving live, etc.), mirrors
            // client/src/pages/Game.tsx's own pendingMove-clearing effect.
            pendingMove = nil
            if game?.status == "finished", history == nil, let fetched = try? await transport.history(gameId: gameId) {
                history = fetched
                reviewMoveNumber = fetched.moves.count - 1
            }
        } catch {
            // isDeleted only gates load() calls made *after* it flips true —
            // one already in flight when it flips (e.g. a pull-to-refresh or
            // a live-socket refetch that started a moment earlier) still
            // lands here once the game is actually gone, otherwise
            // surfacing a "Game not found" alert that flashes and vanishes
            // right as this view is popping. Checking it again at the one
            // place that actually shows something to the user closes that
            // gap regardless of what triggered the call.
            guard !isDeleted else { return }
            // Navigating away mid-load cancels this task, and the cancelled
            // request would otherwise surface as an "Error — cancelled"
            // alert on the way out.
            guard !APIClient.isCancellation(error) else { return }
            // The live socket refetches on every (re)connect and retries
            // that connection every couple of seconds while the server is
            // unreachable — so surfacing its failures meant an alert that
            // came straight back as fast as it could be dismissed, for as
            // long as the network was flaky. Those refetches say nothing
            // instead: the board simply keeps showing what it already has.
            // A real problem still surfaces from the paths someone
            // actually asked for — the first load (where the alternative
            // is an endless spinner), pull-to-refresh, and each action's
            // own error handling, which is separate from this.
            guard surfacingErrors else { return }
            errorMessage = error.localizedDescription
        }
    }

    // With confirm-moves off, a tap plays immediately as before. With it on:
    // a first tap on a valid point just marks it (mirrors dead-marking's own
    // tap-to-toggle interaction); tapping that same marked point again is
    // what actually submits the move; tapping a different valid point just
    // moves the mark there instead. Validity is checked against the server
    // (not replicated client-side) so checks needing full position history
    // — superko — are just as reliable as occupied/turn/suicide. Mirrors
    // client/src/pages/Game.tsx's handlePointClick.
    private func handlePointTap(x: Int, y: Int, in game: GameState) async {
        guard confirmMovesEnabled else {
            await makeMove(x: x, y: y)
            return
        }
        if let pendingMove, pendingMove.x == x, pendingMove.y == y {
            self.pendingMove = nil
            await makeMove(x: x, y: y)
            return
        }
        do {
            let result = try await transport.validateMove(gameId: gameId, x: x, y: y, color: game.currentColor)
            if result.valid {
                pendingMove = Point(x: x, y: y)
            } else {
                errorMessage = result.error ?? "Invalid move"
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func makeMove(x: Int, y: Int) async {
        guard let game, canAct(game), !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let response = try await transport.makeMove(gameId: gameId, x: x, y: y, color: game.currentColor)
            self.game?.board = response.board
            self.game?.currentColor = response.nextColor
            self.game?.captures = response.captures
            self.game?.lastMove = Point(x: x, y: y)
            self.game?.lastEvent = LastEvent(
                eventType: "MOVE", color: game.currentColor, point: Point(x: x, y: y), capturedPoints: response.capturedPoints
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pass() async {
        guard let game, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await transport.pass(gameId: gameId, color: game.currentColor)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resign() async {
        guard let game, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        // Mirrors client/src/hooks/useGame.ts's resign(): a definite color
        // resigns as itself; 'both' (a local game) resigns as whoever's turn
        // it currently is.
        let resignColor: StoneColor
        switch game.myColor {
        case .black: resignColor = .black
        case .white: resignColor = .white
        case .both, .none: resignColor = game.currentColor
        }
        do {
            _ = try await transport.resign(gameId: gameId, color: resignColor)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // Tapping a stone during scoring toggles its whole connected group
    // (getGroup, Models/Scoring.swift) dead or seki depending on markMode —
    // mirrors client/src/pages/Game.tsx's toggleMarkedGroup/
    // toggleGroupMembership: a second tap on any stone in an
    // already-marked group un-marks it, and marking a group in one set
    // clears it from the other (a group can't be both). In Seki mode, the
    // opposite-color partner group (findSekiPartnerStones) is folded into
    // the same toggle, since a real seki always involves both sides.
    private func toggleMarkedGroup(x: Int, y: Int, in game: GameState) {
        var x = x
        var y = y
        if game.board[y][x] == nil {
            // A seki's shared liberties/eyes are exactly the empty points a
            // player naturally taps to mark it, but getGroup needs a stone
            // to flood-fill from — redirect to whichever neighboring point
            // has one. findSekiPartnerStones already pulls in the other
            // side of the seki from there, so it doesn't matter which
            // neighboring stone we land on.
            guard markMode == .seki else { return }
            let neighbors = [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
            guard let neighbor = neighbors.first(where: {
                $0.0 >= 0 && $0.0 < game.size && $0.1 >= 0 && $0.1 < game.size && game.board[$0.1][$0.0] != nil
            }) else { return }
            x = neighbor.0
            y = neighbor.1
        }
        let point = Point(x: x, y: y)
        var keys = Set(getGroup(game.board, point).map { "\($0.x),\($0.y)" })
        if markMode == .seki {
            keys.formUnion(findSekiPartnerStones(game.board, point).map { "\($0.x),\($0.y)" })
        }

        switch markMode {
        case .dead:
            let alreadyMarked = keys.contains { pendingDeadKeys.contains($0) }
            for key in keys {
                if alreadyMarked {
                    pendingDeadKeys.remove(key)
                } else {
                    pendingDeadKeys.insert(key)
                }
            }
            if !alreadyMarked {
                pendingSekiKeys.subtract(keys)
            }
        case .seki:
            let alreadyMarked = keys.contains { pendingSekiKeys.contains($0) }
            for key in keys {
                if alreadyMarked {
                    pendingSekiKeys.remove(key)
                } else {
                    pendingSekiKeys.insert(key)
                }
            }
            if !alreadyMarked {
                pendingDeadKeys.subtract(keys)
            }
        }
    }

    private func finalizeScoring() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        let deadPoints = pendingDeadKeys.compactMap(parsePointKey)
        let sekiPoints = pendingSekiKeys.compactMap(parsePointKey)
        do {
            _ = try await transport.finalizeScoring(gameId: gameId, deadPoints: deadPoints, sekiPoints: sekiPoints)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reopenScoring() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let response = try await transport.reopenScoring(gameId: gameId)
            if response.action == "confirmed" { showResultSheet = false }
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteGame() async {
        guard !isBusy else { return }
        isBusy = true
        // Set before issuing the request, not after it succeeds: the server
        // broadcasts the game-update event as part of handling the delete
        // request itself, so that push can reach this view's own live
        // socket before our own DELETE response even comes back — gating
        // only on success left that whole in-flight window uncovered,
        // exactly like the create-game race did for GameListView.
        isDeleted = true
        defer { isBusy = false }
        do {
            try await transport.deleteGame(gameId: gameId)
            dismiss()
        } catch {
            isDeleted = false
            errorMessage = error.localizedDescription
        }
    }

    // Mirrors the filename server/src/server.ts's own SGF route suggests
    // via Content-Disposition — recomputed here since fetching as plain
    // text (rather than URLSession's download(for:), which would honor
    // that header for a saved file's name) doesn't pick it up on its own.
    // The same https://<host>/games/<id> address the app itself opens as a
    // Universal Link and the web client serves as a page, so a shared link
    // works for whoever receives it either way.
    private var gameLink: URL? {
        URL(string: "\(Config.baseURL.absoluteString)/games/\(gameId)")
    }

    // What a shared note or mail is called: the game's own title when it
    // has one, the two players otherwise — the same fallback the game-list
    // row makes when a game is untitled.
    private var shareTitle: String {
        if let title = game?.title, !title.isEmpty {
            return title
        }
        let black = game?.blackUsername ?? String(localized: "Black")
        let white = game?.whiteUsername ?? String(localized: "White")
        return String(localized: "%@ vs %@", defaultValue: "\(black) vs \(white)")
    }

    // A quick note carries no move record, so an untitled game falls back
    // to when it started rather than to the players — the one detail that
    // still tells two otherwise identical notes apart.
    private var quickNoteTitle: String {
        if let title = game?.title, !title.isEmpty {
            return title
        }
        guard let game, let startedLine = startedLine(game) else { return shareTitle }
        return startedLine
    }

    private func exportSgf() async {
        do {
            let sgf = try await transport.sgf(gameId: gameId)
            let safeName = game?.title?
                .replacingOccurrences(of: "[^a-zA-Z0-9-_ ]", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            let filename = "\(safeName?.isEmpty == false ? safeName! : gameId).sgf"
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
            try sgf.write(to: url, atomically: true, encoding: .utf8)
            gameShare = GameShare(
                sgfFileURL: url,
                sgfText: sgf,
                gameURL: gameLink,
                title: shareTitle,
                quickNoteTitle: quickNoteTitle
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func respondToInvite(accept: Bool) async {
        guard !isBusy else { return }
        isBusy = true
        // Rejecting deletes the game server-side, so set this before the
        // request goes out — same reasoning as deleteGame(): the server's
        // own broadcast can reach this view's live socket before the
        // response does, and without this a load() already in flight would
        // land on a 404 and flash a "Game not found" error right as this
        // view is popping.
        if !accept {
            isDeleted = true
        }
        defer { isBusy = false }
        do {
            try await transport.respondToInvite(gameId: gameId, accept: accept)
            if accept {
                await load()
            } else {
                dismiss()
            }
        } catch {
            if !accept {
                isDeleted = false
            }
            errorMessage = error.localizedDescription
        }
    }

    // Server call is fire-and-forget on its side too — it just re-triggers
    // GNU Go's move generation and returns immediately, so the eventual
    // move (if any) still arrives the normal way, via the live socket
    // triggering a reload. No local busy/loading state: tapping this
    // repeatedly is harmless (see the server route's own comment) and
    // there's nothing here to visibly wait for either way.
    private func recomputeAiMove() async {
        do {
            try await transport.recomputeAiMove(gameId: gameId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// Pass is filled with Color.primary (black in light mode, white in dark —
// i.e. always contrasting against the sheet's own background) with
// background-colored text; Resign is the same shape with the two colors
// swapped, plus a thin border so it stays visible against the sheet's own
// (matching) background color. A slightly-rounded rectangle rather than
// .bordered/.borderedProminent's pill shape, per request.
private struct ActionButtonStyle: ButtonStyle {
    var inverted: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let fill = inverted ? Color(uiColor: .systemBackground) : Color.primary
        let foreground = inverted ? Color.primary : Color(uiColor: .systemBackground)
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(foreground)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(fill)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(Color.primary.opacity(0.35), lineWidth: inverted ? 1 : 0)
                    )
            )
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }
}

// Review navigation flanking the result button — 32pt, ~62% of that
// button's 52pt. A tap steps one move; a press and hold runs to the end of
// the game in that direction.
private struct ReviewNavButton: View {
    let systemName: String
    let disabled: Bool
    let step: () -> Void
    let jump: () -> Void

    // A Button fires on release however long the press was, so without
    // this a long press would jump to the end of the game and then step
    // one move back off it. Set when the hold fires, consumed by the
    // release that follows it.
    @State private var didJump = false

    var body: some View {
        let icon = Image(systemName: systemName)
            .font(.system(size: 15, weight: .semibold))
            .frame(width: 32, height: 32)
        Group {
            if #available(iOS 26.0, *) {
                Button(action: tapped) { icon }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
            } else {
                Button(action: tapped) {
                    icon
                        .background(.ultraThinMaterial, in: Circle())
                        .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .disabled(disabled)
        // simultaneousGesture rather than .onLongPressGesture: the latter
        // replaces the button's own press handling, taking its glass
        // response with it.
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.4)
                // Cleared as each press begins: a hold released off the
                // button never reaches tapped(), and the flag would
                // otherwise sit set and swallow the next tap.
                .onChanged { _ in didJump = false }
                .onEnded { _ in
                    guard !disabled else { return }
                    didJump = true
                    jump()
                }
        )
    }

    private func tapped() {
        guard !didJump else {
            didJump = false
            return
        }
        step()
    }
}
