import Foundation

// The one saved new-game configuration behind the shake-to-play gesture,
// stored server-side (see quick_game_presets) so it follows the account
// rather than the device. Mirrors the fields the new-game form collects;
// shaking turns these into a plain POST /api/games, so every rule that
// endpoint enforces still applies when the game is actually created.
struct QuickGamePreset: Codable, Equatable {
    var mode: String
    var size: Int
    var handicap: Int
    var komi: Double
    // nil is "unlimited" — the same null the server stores for a game
    // without a clock, rather than a third string to keep in sync.
    var timeControl: String?
    var gnugoLevel: Int?
    var color: String
    var opponentUsername: String?
    // Stamped onto every game this preset starts, so quick games are
    // findable as a group afterwards.
    var tags: [String]
    var shakeToPlay: Bool

    // Only used until the first fetch lands; the server has its own copy
    // of these defaults for a user who has never saved one.
    static let fallback = QuickGamePreset(
        mode: "gnugo",
        size: 9,
        handicap: 0,
        komi: 6.5,
        timeControl: "standard",
        gnugoLevel: 5,
        color: "black",
        opponentUsername: nil,
        tags: [],
        shakeToPlay: false
    )

    // createGame takes "unlimited" where the preset stores nil.
    var timeControlName: String { timeControl ?? "unlimited" }
}
