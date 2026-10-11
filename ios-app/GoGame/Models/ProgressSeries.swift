import Foundation

// Mirrors GET /api/progress: the games that count towards the progress
// chart, already narrowed server-side to the quick game preset.
//
// The preset comes back with them because the chart has to say what it is
// a chart of — a margin only means something alongside the board size,
// the komi and who (or what) was on the other side.
struct ProgressPreset: Codable {
    let mode: String
    let size: Int
    let handicap: Int
    let komi: Double
    let timeControl: String?
    let gnugoLevel: Int?
    let opponentUsername: String?
}

struct ProgressGame: Codable, Identifiable {
    let gameId: String
    let title: String?
    let finishedAt: Int
    // Points, from this user's own side: positive is a win by that much,
    // negative a loss, and zero the tie that only a whole-number komi can
    // produce. A game with no number to it at all — a resignation, a loss
    // on time — isn't in the series.
    let margin: Double
    // nil for a game played alone, where there is no other player.
    let opponent: String?

    var id: String { gameId }
}

struct ProgressSeries: Codable {
    let preset: ProgressPreset
    let games: [ProgressGame]
}
