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
    @State private var showDeleteConfirmation = false
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
    // Mirrors client/src/pages/Game.tsx's confirmMoves setting (persisted
    // the same way, via a device-local preference) and pendingMove: with it
    // on, a first tap on a valid point just marks it; tapping that same
    // point again is what actually submits the move.
    @AppStorage("go-confirm-moves") private var confirmMovesEnabled = false
    @State private var pendingMove: Point?

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
        .task {
            await LiveSocket.listen(path: "/ws/games/\(gameId)") {
                guard !isDeleted else { return }
                await load()
            }
        }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showDeleteConfirmation = true
                } label: {
                    Image(systemName: "trash")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showSettingsSheet = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .sheet(isPresented: $showDeleteConfirmation) {
            deleteConfirmationSheetContent
                .presentationDetents([.height(230)])
                .presentationBackground(Color(uiColor: .systemBackground))
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
                    .presentationBackground(Color(uiColor: .systemBackground))
            }
        }
        .sheet(isPresented: $showSettingsSheet) {
            settingsSheetContent
                .presentationDetents([.height(160)])
        }
        .sheet(isPresented: $showResultSheet) {
            if let game {
                resultSheetContent(game)
                    .presentationDetents([.height(190)])
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

    private var navigationTitle: String {
        game?.title?.isEmpty == false ? game!.title! : ""
    }

    private func boardContent(_ game: GameState) -> some View {
        ScrollView {
            VStack(spacing: 12) {
                if !statusLine(game).isEmpty {
                    Text(statusLine(game))
                        .font(.headline)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                BoardGridView(
                    board: game.board,
                    size: game.size,
                    lastMove: game.lastMove,
                    isInteractive: isInteractive(game),
                    allowTapOnOccupied: game.status == "scoring",
                    deadPoints: markMode == .dead ? pendingDeadKeys : [],
                    blackTerritoryPoints: territoryKeys(livePreview(game)?.blackTerritoryPoints ?? []),
                    whiteTerritoryPoints: territoryKeys(livePreview(game)?.whiteTerritoryPoints ?? []),
                    sekiHighlightPoints: sekiActive(game) ? pendingSekiKeys : [],
                    pendingMove: game.status == "in_progress" ? pendingMove : nil,
                    pendingMoveColor: game.currentColor,
                    onTap: { x, y in
                        if game.status == "scoring" {
                            toggleMarkedGroup(x: x, y: y, in: game)
                        } else {
                            Task { await handlePointTap(x: x, y: y, in: game) }
                        }
                    }
                )

                // Order is board → mark mode → estimate: the picker and
                // estimate text used to sit above the board (the estimate
                // appended to an explainer sentence), which made the board
                // jump vertically whenever the estimate text's length
                // changed. Moving both below the board means only content
                // beneath it reflows.
                if game.status == "scoring" {
                    Picker("Mark mode", selection: $markMode) {
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
        .safeAreaInset(edge: .bottom) {
            // The glass layer lives in .background, not wrapped directly
            // around footerRow, specifically so .ignoresSafeArea can let it
            // bleed down past the row's own layout and cover the home
            // indicator strip too — footerRow itself stays laid out exactly
            // as before, safely clear of that strip, and only the backing
            // glass extends into it. No conflict with the home indicator:
            // the system draws that on top of app content regardless of
            // what's underneath, on every app, glass or not.
            footerRow(game)
                .padding(.vertical, 10)
                .background {
                    if #available(iOS 26.0, *) {
                        Rectangle()
                            .fill(.clear)
                            .glassEffect(.regular, in: Rectangle())
                            .ignoresSafeArea(edges: .bottom)
                    } else {
                        Rectangle()
                            .fill(.bar)
                            .ignoresSafeArea(edges: .bottom)
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
                if game.mainTimeSeconds != nil {
                    HStack(alignment: .top) {
                        footerClock(.black, game: game, isTicking: isTicking, nowMs: nowMs)
                        Spacer()
                        footerClock(.white, game: game, isTicking: isTicking, nowMs: nowMs)
                    }
                }
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
        let captures = color == .black ? game.captures.black : game.captures.white
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
            isActive: isTicking && game.currentColor == color
        )
    }

    @ViewBuilder
    private func turnMarker(_ game: GameState) -> some View {
        switch game.status {
        case "in_progress":
            // Same 44pt circle as finalizeButton below, so the footer's
            // center slot stays a consistent size across game phases. The
            // tint fills the whole glass shape rather than a smaller stone
            // drawn inside a neutral ring — that's what reads as an actual
            // black/white stone. The glass edge highlight alone isn't quite
            // enough contrast for a white marker in light mode or a black
            // one in dark mode (same fill as the footer behind it) — a
            // hairline .primary rim (black in light mode, white in dark)
            // fixes exactly those two cases, mirroring footerStone's own
            // border for the same reason, while staying nearly invisible on
            // the two cases that already contrast fine. No .disabled(...)
            // here, matching the board's own stones: a spectator's tap is
            // just a no-op, not a dimmed control — the color still needs to
            // read clearly for anyone watching.
            let action: () -> Void = {
                if game.myColor != nil { showActionsSheet = true }
            }
            let tint: Color = game.currentColor == .black ? .black : .white
            if #available(iOS 26.0, *) {
                Button(action: action) {
                    Color.clear.frame(width: 44, height: 44)
                }
                .buttonStyle(.glassProminent)
                .tint(tint)
                .buttonBorderShape(.circle)
                .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
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
                Button {
                    showResultSheet = true
                } label: {
                    Text(shortResult)
                        .font(.headline)
                }
                .buttonStyle(.plain)
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

    // Mirrors client/src/pages/Game.tsx's resultSummary: strips the
    // server's own "(B: x, W: y)" breakdown suffix, leaving just the plain
    // sentence — the breakdown is shown separately, as black/white stones.
    private func plainResult(_ game: GameState) -> String {
        guard let result = game.result else { return "Game over" }
        guard let range = result.range(of: #"\s*\(B: [\d.]+, W: [\d.]+\)\s*$"#, options: .regularExpression) else {
            return result
        }
        return String(result[result.startIndex..<range.lowerBound])
    }

    @ViewBuilder
    private func resultSheetContent(_ game: GameState) -> some View {
        VStack(spacing: 16) {
            Text(plainResult(game))
                .font(.headline)
                .multilineTextAlignment(.center)
            if let breakdown = game.resultBreakdown {
                HStack(spacing: 8) {
                    profileLink(username: game.blackUsername, userId: game.blackUserId)
                    resultPointsStone(.black, score: breakdown.black)
                    Spacer().frame(width: 20)
                    resultPointsStone(.white, score: breakdown.white)
                    profileLink(username: game.whiteUsername, userId: game.whiteUserId)
                }
                .font(.subheadline)
                // Only a scoring-based finish can be reopened (a
                // resignation/timeout has no scoring to redo) — the same
                // condition resultBreakdown itself is gated on server-side.
                if game.myColor != nil {
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
        }
        .padding()
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
                Text(username).underline()
            }
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
            return "Reopen Scoring"
        }
        guard let pendingReopenBy = game.pendingReopenBy else {
            return "Request Reopen Scoring"
        }
        return pendingReopenBy == myStoneColor(game) ? "Cancel Reopen Request" : "Confirm Reopen Scoring"
    }

    // Sized to comfortably fit a 3-digit score (e.g. "182.5") without the
    // text ellipsizing.
    @ViewBuilder
    private func resultPointsStone(_ color: StoneColor, score: Double) -> some View {
        ZStack {
            Circle()
                .fill(color == .black ? Color.black : Color.white)
                .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 1))
            Text(formatScore(score))
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(color == .black ? Color.white : Color.black)
        }
        .frame(width: 52, height: 52)
    }

    private func statusLine(_ game: GameState) -> String {
        switch game.status {
        case "finished", "scoring":
            return ""
        default:
            let toMove = game.currentColor == .black ? "Black" : "White"
            return canAct(game) ? "\(toMove) to move — your turn" : "\(toMove) to move"
        }
    }

    // Just the "Estimated: ..." line, with no explainer sentence — the
    // segmented Dead/Seki picker itself already makes the current mode
    // obvious, and dropping it keeps this line's length (the only thing
    // that changes as marks are toggled) from affecting anything above it.
    private func estimateText(_ game: GameState) -> String? {
        guard let preview = livePreview(game) else { return nil }
        let winner = preview.winner == .black ? "Black" : "White"
        return "Estimated: \(winner) wins by \(formatScore(preview.margin))"
            + " (B: \(formatScore(preview.black)), W: \(formatScore(preview.white)))"
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

    // Mirrors client/src/pages/Game.tsx's sekiActive: only dims the board
    // while actively in Seki mode (not just whenever a seki mark exists),
    // so switching to Dead mode isn't fighting the dim effect for attention.
    private func sekiActive(_ game: GameState) -> Bool {
        game.status == "scoring" && markMode == .seki && !pendingSekiKeys.isEmpty
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

    private func load() async {
        do {
            game = try await APIClient.getGame(id: gameId)
            pendingDeadKeys = []
            // A pending (unconfirmed) move marker only makes sense for the
            // turn it was placed on — a fresh load always means the turn
            // has moved on one way or another (our own confirmed move, the
            // opponent's move arriving live, etc.), mirrors
            // client/src/pages/Game.tsx's own pendingMove-clearing effect.
            pendingMove = nil
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
            let result = try await APIClient.validateMove(gameId: gameId, x: x, y: y, color: game.currentColor)
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
            let response = try await APIClient.makeMove(gameId: gameId, x: x, y: y, color: game.currentColor)
            self.game?.board = response.board
            self.game?.currentColor = response.nextColor
            self.game?.captures = response.captures
            self.game?.lastMove = Point(x: x, y: y)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pass() async {
        guard let game, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await APIClient.pass(gameId: gameId, color: game.currentColor)
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
            _ = try await APIClient.resign(gameId: gameId, color: resignColor)
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
            _ = try await APIClient.finalizeScoring(gameId: gameId, deadPoints: deadPoints, sekiPoints: sekiPoints)
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
            let response = try await APIClient.reopenScoring(gameId: gameId)
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
            try await APIClient.deleteGame(gameId: gameId)
            dismiss()
        } catch {
            isDeleted = false
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
