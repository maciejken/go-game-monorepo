import SwiftUI

// The settings a shake starts a game with, reached from the profile. Same
// fields as NewGameView minus the title (a quick game isn't named) and
// plus the gesture's own switch. Saved to the server on every change
// rather than behind a Save button: each control is one field of one row,
// and a half-saved preset is less useful than an immediately-saved one.
struct QuickGamePresetView: View {
    @Environment(QuickGameStore.self) private var quickGame
    @Environment(SessionStore.self) private var session

    @State private var preset = QuickGamePreset.fallback
    @State private var isLoaded = false
    @State private var errorMessage: String?
    @State private var usernameSuggestions: [APIClient.UsernameSearchResult] = []
    @State private var usernameSearchTask: Task<Void, Never>?
    @State private var tagDraft = ""

    private static let boardSizes = [9, 13, 19]

    private var maxHandicap: Int { preset.size == 19 ? 9 : 5 }
    private var handicapOptions: [Int] { [0] + Array(2...maxHandicap) }
    private var komiOptions: [Double] { preset.handicap > 0 ? [0.5, 0] : [6.5, 5.5, 0.5, 0] }

    var body: some View {
        Form {
            Section {
                Toggle("Shake to play", isOn: binding(\.shakeToPlay))
            } footer: {
                Text("Shake the phone to start a game with these settings. Ignored while a game is open.")
            }

            Section {
                if !preset.tags.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(preset.tags, id: \.self) { tag in
                            TagChip(tag: tag) { remove(tag: tag) }
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
                // Without this the row separator is inset to wherever
                // SwiftUI thinks the row's content starts — here the Add
                // button, which leaves a stub of a line under it rather
                // than a full-width rule like every other row.
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Picker("Mode", selection: binding(\.mode)) {
                    Text("Local").tag("local")
                    Text("Remote").tag("remote")
                    Text("Vs. Computer").tag("gnugo")
                }
                if preset.mode == "gnugo" {
                    Stepper("GNU Go level: \(preset.gnugoLevel ?? 5)", value: gnugoLevelBinding, in: 1...10)
                }
                if preset.mode == "remote" {
                    TextField("Opponent username", text: opponentBinding)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    ForEach(usernameSuggestions, id: \.username) { suggestion in
                        Button {
                            preset.opponentUsername = suggestion.username
                            usernameSuggestions = []
                            save()
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
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }

            if preset.mode != "local" {
                Section("Your color") {
                    Picker("Color", selection: binding(\.color)) {
                        Text("Black").tag("black")
                        Text("White").tag("white")
                        Text("Random").tag("random")
                    }
                    .pickerStyle(.segmented)
                }
            }

            Section("Board") {
                Picker("Size", selection: binding(\.size)) {
                    ForEach(Self.boardSizes, id: \.self) { size in
                        Text("\(size)\u{00D7}\(size)").tag(size)
                    }
                }
                .pickerStyle(.segmented)

                Picker("Handicap", selection: binding(\.handicap)) {
                    ForEach(handicapOptions, id: \.self) { handicap in
                        Text(handicap == 0 ? "None" : "\(handicap)").tag(handicap)
                    }
                }

                Picker("Komi", selection: binding(\.komi)) {
                    ForEach(komiOptions, id: \.self) { option in
                        Text(formatKomi(option)).tag(option)
                    }
                }
            }

            // No section header: the picker's own label already says
            // "Time control", and the two read as a stutter.
            Section {
                Picker("Time control", selection: timeControlBinding) {
                    Text("10 minutes").tag("standard")
                    Text("24h per move").tag("correspondence")
                    Text("Unlimited").tag("unlimited")
                }
            }

        }
        .navigationTitle("Quick game preset")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !isLoaded else { return }
            if let loaded = try? await APIClient.getQuickGamePreset() {
                preset = loaded
                quickGame.preset = loaded
            }
            isLoaded = true
        }
    }

    // Every control writes through here: it applies the change, fixes up
    // whatever it invalidates (the same cross-field rules the new-game
    // form has), and saves.
    private func binding<Value>(_ keyPath: WritableKeyPath<QuickGamePreset, Value>) -> Binding<Value> {
        Binding(
            get: { preset[keyPath: keyPath] },
            set: { newValue in
                preset[keyPath: keyPath] = newValue
                reconcile()
                save()
            }
        )
    }

    private var opponentBinding: Binding<String> {
        Binding(
            get: { preset.opponentUsername ?? "" },
            set: { newValue in
                preset.opponentUsername = newValue
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                usernameSearchTask?.cancel()
                usernameSearchTask = Task {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                    usernameSuggestions = trimmed.isEmpty
                        ? []
                        : ((try? await APIClient.searchUsernames(query: trimmed)) ?? [])
                }
                // Only saved once it's a plausible name — the server
                // rejects a remote preset with an empty opponent.
                if !trimmed.isEmpty { save() }
            }
        )
    }

    private var gnugoLevelBinding: Binding<Int> {
        Binding(
            get: { preset.gnugoLevel ?? 5 },
            set: { newValue in
                preset.gnugoLevel = newValue
                save()
            }
        )
    }

    private var timeControlBinding: Binding<String> {
        Binding(
            get: { preset.timeControlName },
            set: { newValue in
                preset.timeControl = newValue == "unlimited" ? nil : newValue
                save()
            }
        )
    }

    // Mirrors NewGameView's own cross-field behaviour: a bigger handicap
    // than the board allows, a komi that stops being offered once there's
    // a handicap, and GNU Go giving away the handicap stones (so you take
    // black).
    private func reconcile() {
        if preset.handicap > maxHandicap {
            preset.handicap = maxHandicap
        }
        if preset.handicap > 0 && !komiOptions.contains(preset.komi) {
            preset.komi = 0.5
        }
        if preset.mode == "gnugo" && preset.handicap > 0 {
            preset.color = "black"
        }
        if preset.mode != "remote" {
            usernameSuggestions = []
        }
    }

    private var trimmedTagDraft: String {
        tagDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // The server applies the same rules it applies to a tag on a game —
    // charset, length, cap, case-insensitive dedupe — and answers with
    // what it stored, so a rejected tag simply doesn't come back.
    private func addTag() {
        let tag = trimmedTagDraft
        guard !tag.isEmpty else { return }
        preset.tags.append(tag)
        tagDraft = ""
        save()
    }

    private func remove(tag: String) {
        preset.tags.removeAll { $0 == tag }
        save()
    }

    private func save() {
        Task {
            do {
                // Adopting the response, not the request: the server
                // normalizes out-of-range values rather than failing, so
                // what it stored is the truth.
                let saved = try await APIClient.setQuickGamePreset(preset)
                preset = saved
                quickGame.preset = saved
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func formatKomi(_ value: Double) -> String {
        value == 0 ? "None" : value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(value))
            : String(format: "%.1f", value)
    }
}
