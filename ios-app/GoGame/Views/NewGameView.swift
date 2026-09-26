import SwiftUI
import UIKit

// Native Form port of client/src/pages/Home.tsx's new-game modal — the web
// version uses hand-built range sliders with tick marks; SwiftUI's own
// Picker/Stepper cover the same fields with standard iOS controls instead.
struct NewGameView: View {
    var onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var session
    @Environment(QuickGameStore.self) private var quickGame

    @State private var title = ""
    @State private var mode = "remote" // "offline" | "nearby" | "local" | "remote" | "gnugo"
    // Without an account there is nothing else to pick, and the picker
    // shows only these two.
    // Nearby games come in two halves: one device offers the game, the
    // other joins it.
    @State private var nearbyRole = "host" // "host" | "join"
    @State private var guest = NearbyGuest()
    @State private var boardSize = 19
    @State private var handicap = 0
    @State private var komi: Double = 6.5
    @State private var timeControl = "unlimited" // "standard" | "correspondence" | "unlimited"
    @State private var opponentUsername = ""
    @State private var color = "black" // "black" | "white" | "random"
    @State private var gnugoLevel = 10
    @State private var isCreating = false
    @State private var errorMessage: String?
    // A create-game failure specific to the opponent field (not found,
    // opted out of invitations, self-invite) — shown under that field
    // rather than the form's generic error, and cleared as soon as the
    // username changes rather than lingering until the next submit.
    @State private var opponentError: String?
    @State private var opponentLookupTask: Task<Void, Never>?
    @State private var usernameSearchTask: Task<Void, Never>?
    @State private var usernameSuggestions: [APIClient.UsernameSearchResult] = []
    // Saves this form as the shake-to-play preset when the game is
    // created — "these settings, again, by shaking".
    @State private var shakeToPlay = false
    @State private var tags: [String] = []

    private static let boardSizes = [9, 13, 19]

    private var maxHandicap: Int { boardSize == 19 ? 9 : 5 }
    private var handicapOptions: [Int] { [0] + Array(2...maxHandicap) }
    private var komiOptions: [Double] { handicap > 0 ? [0.5, 0] : [6.5, 5.5, 0.5, 0] }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title (optional)", text: $title)
                    if !tags.isEmpty {
                        FlowLayout(spacing: 6) {
                            ForEach(tags, id: \.self) { tag in
                                TagChip(tag: tag) { tags.removeAll { $0 == tag } }
                            }
                        }
                    }
                    // The same picker the game's own Title & tags sheet
                    // uses. Without Share: the game doesn't exist yet, and
                    // its tags are the creator's own until it does.
                    TagPicker(selected: tags) { tag, _ in addTag(tag) }
                        // Without this the row separator is inset to
                        // wherever SwiftUI thinks the row's content starts,
                        // which leaves a stub of a line rather than a
                        // full-width rule like every other row.
                        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                    Picker("Mode", selection: $mode) {
                        // The first three are games the server keeps: a
                        // local game belongs to an account, a remote one
                        // needs somebody to invite, and GNU Go runs there.
                        if session.currentUser != nil {
                            Text("Local").tag("local")
                            Text("Remote").tag("remote")
                            // Only where there is a GNU Go to play: a
                            // server can have it switched off.
                            if session.features.gnugo {
                                Text("Vs. Computer").tag("gnugo")
                            }
                        }
                        Text("Offline").tag("offline")
                        Text("Nearby").tag("nearby")
                    }
                    .onChange(of: mode) { _, newMode in
                        if newMode == "nearby" && nearbyRole == "join" {
                            guest.startLooking(as: playerName)
                        } else {
                            guest.stop()
                        }
                        if newMode != "remote" {
                            usernameSuggestions = []
                            opponentError = nil
                        }
                        if newMode == "gnugo" {
                            timeControl = "standard"
                            if handicap > 0 { color = "black" }
                            // Picking up where the last game against the
                            // computer left off. Plain assignment to
                            // `handicap` is enough to re-trigger its own
                            // .onChange below (color/komi side effects),
                            // unlike the web version, which has to route
                            // through its handleHandicapChange explicitly.
                            Task {
                                guard let recent = await recentGameVsAIQuiet() else { return }
                                handicap = recent.handicap
                                if let level = recent.gnugoLevel {
                                    gnugoLevel = level
                                }
                            }
                        }
                    }
                    if mode == "gnugo" {
                        Stepper("GNU Go level: \(gnugoLevel)", value: $gnugoLevel, in: 1...10)
                    }
                    // Effectively only ever populated by a local/gnugo
                    // creation failure (see create()'s catch below) — GNU
                    // Go's one-open-game limit is the practical case — so
                    // it belongs right under the control that caused it
                    // rather than at the bottom of an unrelated form.
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                    if mode == "remote" {
                        TextField("Opponent username", text: $opponentUsername)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .onChange(of: opponentUsername) { _, newValue in
                                opponentLookupTask?.cancel()
                                usernameSearchTask?.cancel()
                                opponentError = nil
                                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !trimmed.isEmpty else { return }
                                opponentLookupTask = Task {
                                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                                    guard !Task.isCancelled else { return }
                                    guard let recent = await recentGameVsQuiet(username: trimmed) else { return }
                                    handicap = recent.handicap
                                }
                                // Any non-empty query is sent — the server
                                // itself narrows a 1-2 character query to
                                // recent opponents rather than the whole
                                // user base, only searching everyone once
                                // there's a 3rd character. A much lighter
                                // debounce than the handicap lookup above,
                                // since this one drives visible list
                                // feedback while typing, not a background
                                // prefill.
                                usernameSearchTask = Task {
                                    try? await Task.sleep(nanoseconds: 300_000_000)
                                    guard !Task.isCancelled else { return }
                                    usernameSuggestions = (try? await APIClient.searchUsernames(query: trimmed)) ?? []
                                }
                            }
                        ForEach(usernameSuggestions, id: \.username) { suggestion in
                            Button {
                                selectSuggestion(suggestion)
                            } label: {
                                HStack {
                                    Text(suggestion.username)
                                    if suggestion.isAi {
                                        Text("(computer)").foregroundStyle(.secondary)
                                    } else if suggestion.username == session.currentUser?.username {
                                        Text("(you)").foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                        if let opponentError {
                            Text(opponentError).foregroundStyle(.red)
                        }
                    }
                }

                if mode == "remote" || mode == "gnugo" || (mode == "nearby" && nearbyRole == "host") {
                    Section("Your color") {
                        Picker("Color", selection: $color) {
                            Text("Black").tag("black")
                            Text("White").tag("white")
                            Text("Random").tag("random")
                        }
                        .pickerStyle(.segmented)
                    }
                }

                Section("Board") {
                    Picker("Size", selection: $boardSize) {
                        ForEach(Self.boardSizes, id: \.self) { size in
                            Text("\(size)\u{00D7}\(size)").tag(size)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: boardSize) { _, newSize in
                        let newMax = newSize == 19 ? 9 : 5
                        if handicap > newMax { handicap = newMax }
                    }

                    Picker("Handicap", selection: $handicap) {
                        ForEach(handicapOptions, id: \.self) { h in
                            Text(h == 0 ? "None" : "\(h)").tag(h)
                        }
                    }
                    .onChange(of: handicap) { _, newHandicap in
                        if mode == "gnugo" && newHandicap > 0 { color = "black" }
                        if newHandicap > 0 && !komiOptions.contains(komi) { komi = 0.5 }
                    }

                    Picker("Komi", selection: $komi) {
                        ForEach(komiOptions, id: \.self) { option in
                            Text(formatKomi(option)).tag(option)
                        }
                    }
                }

                if mode == "nearby" {
                    Section("Nearby") {
                        Picker("Nearby", selection: $nearbyRole) {
                            Text("Host a game").tag("host")
                            Text("Join a game").tag("join")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .onChange(of: nearbyRole) { _, role in
                            if role == "join" {
                                guest.startLooking(as: playerName)
                            } else {
                                guest.stop()
                            }
                        }

                        if nearbyRole == "join" {
                            nearbyJoinRows
                        }
                    }
                }

                // No section header: the picker's own label already says
                // "Time control", and the two read as a stutter.
                Section {
                    Picker("Time control", selection: $timeControl) {
                        Text("10 minutes").tag("standard")
                        Text("24h per move").tag("correspondence")
                        Text("Unlimited").tag("unlimited")
                    }
                }

                Section {
                    Toggle("Shake to play", isOn: $shakeToPlay)
                } footer: {
                    Text("Saves these settings as your quick game preset when the game starts, and shakes start one like it.")
                }
            }
            // Joining is the guest's "Start": the board opens as soon as
            // the host lets it in.
            .onChange(of: guest.phase) { _, phase in
                if case let .joined(gameId) = phase {
                    onCreated(gameId)
                }
            }
            .onDisappear {
                // Browsing stops with the sheet, but a game that was
                // actually joined keeps its connection — the board it just
                // opened is playing over it.
                if case .joined = guest.phase { return }
                guest.stop()
            }
            .onAppear {
                if session.currentUser == nil, mode != "nearby" {
                    mode = "offline"
                }
            }
            .navigationTitle("New Game")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if mode != "nearby" || nearbyRole == "host" {
                        Button("Start") { Task { await create() } }
                            .disabled(isCreating)
                    }
                }
            }
        }
    }

    // What the other device shows this player as. The remembered session's
    // name when there is one, the device's own name otherwise — a game
    // offered by "iPhone" is still easier to pick out of a list than one
    // offered by nobody.
    private var playerName: String {
        if let username = session.currentUser?.username, !username.isEmpty {
            return username
        }
        return UIDevice.current.name
    }

    @ViewBuilder
    private var nearbyJoinRows: some View {
        switch guest.phase {
        case .joining:
            HStack(spacing: 8) {
                ProgressView()
                Text("Joining…")
            }
        case let .failed(reason):
            Text(reason).foregroundStyle(.red)
        default:
            if guest.games.isEmpty {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Looking for games nearby…")
                }
            } else {
                ForEach(guest.games) { game in
                    Button {
                        guest.join(game)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(game.title ?? game.hostName)
                            Text(nearbyGameSummary(game))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func nearbyGameSummary(_ game: NearbyGame) -> String {
        let colour = game.yourColor == .black ? String(localized: "Black") : String(localized: "White")
        var parts = [game.hostName, "\(game.size)×\(game.size)"]
        if game.handicap > 0 {
            parts.append(String(format: String(localized: "handicap %lld"), game.handicap))
        }
        parts.append(String(format: String(localized: "you play %@"), colour))
        return parts.joined(separator: " · ")
    }

    // Saved only once the game itself was created, so a form that the
    // server rejected can't become the preset. A failure here is silent:
    // the game exists either way, and the preset is a convenience.
    private func saveAsQuickPreset(opponent: String) async {
        let preset = QuickGamePreset(
            mode: mode,
            size: boardSize,
            handicap: handicap,
            komi: komi,
            timeControl: timeControl == "unlimited" ? nil : timeControl,
            gnugoLevel: mode == "gnugo" ? gnugoLevel : nil,
            color: color,
            opponentUsername: mode == "remote" ? opponent : nil,
            tags: tags,
            shakeToPlay: true
        )
        quickGame.preset = try? await APIClient.setQuickGamePreset(preset)
    }

    // Trim, dedupe and cap here so the list on screen matches what will be
    // sent; the server still has the last word on a tag's charset and
    // length, and quietly drops anything it won't store.
    // Kept here rather than sent anywhere: the game is created with these
    // in one request, so until then they are just a list.
    private func addTag(_ raw: String) -> Bool {
        let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tag.isEmpty, tags.count < 12 else { return false }
        guard !tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) else { return true }
        tags.append(tag)
        return true
    }

    // An unknown/not-yet-valid username, or any other request error, just
    // means there's nothing to prefill from — the real "no such user"
    // error still surfaces at submit time via APIClient.createGame.
    private func recentGameVsQuiet(username: String) async -> APIClient.RecentGameVsOpponent? {
        try? await APIClient.recentGameVs(username: username)
    }

    private func recentGameVsAIQuiet() async -> APIClient.RecentGameVsOpponent? {
        try? await APIClient.recentGameVsAI()
    }

    // Selecting the computer's or your own username switches mode instead
    // of filling in an opponent — those aren't real remote opponents, and
    // assigning `mode` re-triggers its own .onChange above (gnugo
    // prefill/color-forcing), unlike a route that skipped straight to
    // creating the game.
    private func selectSuggestion(_ suggestion: APIClient.UsernameSearchResult) {
        usernameSuggestions = []
        opponentError = nil
        if suggestion.isAi {
            opponentUsername = ""
            mode = "gnugo"
        } else if suggestion.username == session.currentUser?.username {
            opponentUsername = ""
            mode = "local"
        } else {
            opponentUsername = suggestion.username
        }
    }

    private func formatKomi(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(format: "%.1f", value)
    }

    private func create() async {
        errorMessage = nil
        opponentError = nil
        let trimmedOpponent = opponentUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        if mode == "remote" && trimmedOpponent.isEmpty {
            opponentError = "Opponent's username is required for a remote game"
            return
        }
        isCreating = true
        defer { isCreating = false }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            // An offline game is created on the device and never reaches
            // the server, so none of the remote-only options apply.
            if mode == "offline" {
                // One device, both colours — the same as a local game on
                // the server, which puts the signed-in player on both
                // sides. With nobody signed in the names stay empty and
                // the sides show as Black and White.
                let myName = session.currentUser?.username
                let record = try OfflineGameStore.shared.create(
                    size: boardSize,
                    handicap: handicap,
                    komi: komi,
                    title: trimmedTitle.isEmpty ? nil : trimmedTitle,
                    blackName: myName,
                    whiteName: myName
                )
                onCreated(record.id)
                return
            }
            // A nearby game is an offline game with the other seat open: it
            // is held here, refereed here, and the other device plays it
            // over the link (see NearbyHost).
            if mode == "nearby" {
                let myName = playerName
                let hostColor: StoneColor = color == "white" ? .white : .black
                let record = try OfflineGameStore.shared.create(
                    size: boardSize,
                    handicap: handicap,
                    komi: komi,
                    title: trimmedTitle.isEmpty ? nil : trimmedTitle,
                    blackName: hostColor == .black ? myName : nil,
                    whiteName: hostColor == .white ? myName : nil,
                    hostColor: hostColor
                )
                NearbyHost().start(record: record, hostName: myName)
                onCreated(record.id)
                return
            }
            let gameId = try await APIClient.createGame(
                size: boardSize,
                handicap: handicap,
                komi: komi,
                title: trimmedTitle.isEmpty ? nil : trimmedTitle,
                mode: mode,
                timeControl: timeControl,
                color: (mode == "remote" || mode == "gnugo") ? color : nil,
                opponentUsername: mode == "remote" ? trimmedOpponent : nil,
                level: mode == "gnugo" ? gnugoLevel : nil,
                tags: tags
            )
            if shakeToPlay {
                await saveAsQuickPreset(opponent: trimmedOpponent)
            }
            onCreated(gameId)
        } catch {
            if mode == "remote" {
                opponentError = error.localizedDescription
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}
