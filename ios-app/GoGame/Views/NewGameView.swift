import SwiftUI

// Native Form port of client/src/pages/Home.tsx's new-game modal — the web
// version uses hand-built range sliders with tick marks; SwiftUI's own
// Picker/Stepper cover the same fields with standard iOS controls instead.
struct NewGameView: View {
    var onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var session
    @Environment(QuickGameStore.self) private var quickGame

    @State private var title = ""
    @State private var mode = "remote" // "local" | "remote" | "gnugo"
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
    @State private var tagDraft = ""

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
                    HStack(spacing: 8) {
                        TextField("Add a tag", text: $tagDraft)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .submitLabel(.done)
                            .onSubmit { addTag() }
                        Button("Add", action: addTag)
                            .disabled(trimmedTagDraft.isEmpty)
                    }
                    Picker("Mode", selection: $mode) {
                        Text("Local").tag("local")
                        Text("Remote").tag("remote")
                        Text("Vs. Computer").tag("gnugo")
                    }
                    .onChange(of: mode) { _, newMode in
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

                if mode == "remote" || mode == "gnugo" {
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
            .navigationTitle("New Game")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { Task { await create() } }
                        .disabled(isCreating)
                }
            }
        }
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

    private var trimmedTagDraft: String {
        tagDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Trim, dedupe and cap here so the list on screen matches what will be
    // sent; the server still has the last word on a tag's charset and
    // length, and quietly drops anything it won't store.
    private func addTag() {
        let tag = trimmedTagDraft
        guard !tag.isEmpty, tags.count < 12 else { return }
        guard !tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) else {
            tagDraft = ""
            return
        }
        tags.append(tag)
        tagDraft = ""
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
