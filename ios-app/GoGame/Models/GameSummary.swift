import Foundation

// Which color (if either) the logged-in viewer plays in a game — 'both'
// covers a local game where one account plays both sides. Mirrors
// client/src/services/api.ts's MyColor.
enum MyColor: String, Codable {
    case black
    case white
    case both
}

// Mirrors client/src/services/api.ts's StoredTimeControl — 'unlimited' is
// never actually stored (a null timeControl means that), so it has no case
// here, matching the TS type.
enum TimeControl: String, Codable {
    case standard
    case correspondence
}

// Mirrors client/src/services/api.ts's GameSummary — the shape returned by
// GET /api/games.
struct GameSummary: Codable, Identifiable {
    let id: String
    let size: Int
    let handicap: Int
    let komi: Double
    let title: String?
    let status: String
    let result: String?
    let shortResult: String?
    let createdAt: Int
    let updatedAt: Int
    let blackUsername: String?
    let whiteUsername: String?
    let blackUserId: String?
    let whiteUserId: String?
    let myColor: MyColor?
    let isAiOpponent: Bool
    let gnugoLevel: Int?
    let timeControl: TimeControl?
    let starred: Bool
    // Optional so the app still decodes against a server that predates
    // tags; tagList is what the views read.
    let tags: [String]?

    var tagList: [String] { tags ?? [] }
}
