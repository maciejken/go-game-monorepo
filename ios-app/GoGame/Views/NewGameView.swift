import SwiftUI

// Native Form port of client/src/pages/Home.tsx's new-game modal — the web
// version uses hand-built range sliders with tick marks; SwiftUI's own
// Picker/Stepper cover the same fields with standard iOS controls instead.
struct NewGameView: View {
    var onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var mode = "local" // "local" | "remote" | "gnugo"
    @State private var boardSize = 19
    @State private var handicap = 0
    @State private var komi: Double = 6.5
    @State private var timeControl = "unlimited" // "standard" | "correspondence" | "unlimited"
    @State private var opponentUsername = ""
    @State private var color = "black" // "black" | "white" | "random"
    @State private var gnugoLevel = 10
    @State private var isCreating = false
    @State private var errorMessage: String?
    @State private var opponentLookupTask: Task<Void, Never>?

    private static let boardSizes = [9, 13, 19]

    private var maxHandicap: Int { boardSize == 19 ? 9 : 5 }
    private var handicapOptions: [Int] { [0] + Array(2...maxHandicap) }
    private var komiOptions: [Double] { handicap > 0 ? [0.5, 0] : [6.5, 5.5, 0.5, 0] }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title (optional)", text: $title)
                    Picker("Mode", selection: $mode) {
                        Text("Local").tag("local")
                        Text("Remote").tag("remote")
                        Text("Vs. Computer").tag("gnugo")
                    }
                    .onChange(of: mode) { _, newMode in
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
                    if mode == "remote" {
                        TextField("Opponent username", text: $opponentUsername)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .onChange(of: opponentUsername) { _, newValue in
                                opponentLookupTask?.cancel()
                                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !trimmed.isEmpty else { return }
                                opponentLookupTask = Task {
                                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                                    guard !Task.isCancelled else { return }
                                    guard let recent = await recentGameVsQuiet(username: trimmed) else { return }
                                    handicap = recent.handicap
                                }
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

                if mode == "gnugo" {
                    Stepper("GNU Go level: \(gnugoLevel)", value: $gnugoLevel, in: 1...10)
                }

                Section("Time control") {
                    Picker("Time control", selection: $timeControl) {
                        Text("10 minutes").tag("standard")
                        Text("24h per move").tag("correspondence")
                        Text("Unlimited").tag("unlimited")
                    }
                }

                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
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

    // An unknown/not-yet-valid username, or any other request error, just
    // means there's nothing to prefill from — the real "no such user"
    // error still surfaces at submit time via APIClient.createGame.
    private func recentGameVsQuiet(username: String) async -> APIClient.RecentGameVsOpponent? {
        try? await APIClient.recentGameVs(username: username)
    }

    private func recentGameVsAIQuiet() async -> APIClient.RecentGameVsOpponent? {
        try? await APIClient.recentGameVsAI()
    }

    private func formatKomi(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(format: "%.1f", value)
    }

    private func create() async {
        errorMessage = nil
        let trimmedOpponent = opponentUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        if mode == "remote" && trimmedOpponent.isEmpty {
            errorMessage = "Opponent's username is required for a remote game"
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
                level: mode == "gnugo" ? gnugoLevel : nil
            )
            onCreated(gameId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
