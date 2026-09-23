import Foundation

// Mirrors client/src/services/api.ts's resultBreakdown shape.
struct ResultBreakdown: Codable {
    let black: Double
    let white: Double
}

// A lean slice of client/src/services/api.ts's GameStateResponse — only the
// fields this slice's board view actually uses (no clocks, undo negotiation,
// AI level, or scoring breakdown yet). Codable ignores the rest of the JSON
// the server sends, so nothing here needs to change if the server's response
// shape doesn't; more fields can be added later without server changes.
struct GameState: Codable {
    let id: String
    let size: Int
    let handicap: Int
    // var, not let: the Title & tags sheet writes the new title straight
    // back here rather than refetching the whole game for one field.
    var title: String?
    let status: String
    var board: Board
    let blackUsername: String?
    let whiteUsername: String?
    let blackUserId: String?
    let whiteUserId: String?
    var currentColor: StoneColor
    var captures: Captures
    // var, not let: a game held on another device is answered from that
    // device's side, and the host rewrites this to the guest's colour
    // before sending it (see PeerHostService).
    var myColor: MyColor?
    // True only for the invited side of a remote-game invite that hasn't
    // been responded to yet — drives the accept/reject confirmation sheet.
    let pendingInviteResponse: Bool
    var lastMove: Point?
    // Independent of lastMove: describable even when the most recent event
    // left no stone to point at, i.e. a pass. nil only when nothing has
    // happened yet (a fresh non-handicap game).
    var lastEvent: LastEvent?
    let result: String?
    let shortResult: String?
    // Only non-nil for a scoring-based finish (a resignation/timeout has no
    // point count to break down). Mirrors client/src/services/api.ts's
    // resultBreakdown.
    let resultBreakdown: ResultBreakdown?
    // Reopen-scoring negotiation state + whether the opponent is GNU Go —
    // mirrors client/src/services/api.ts's pendingReopenBy/isAiOpponent,
    // used by the reopen-scoring button's label/behavior (immediate for a
    // local or AI game, request-then-confirm between two real players).
    let pendingReopenBy: StoneColor?
    let isAiOpponent: Bool
    // nil for a human game; the level GNU Go was created to play at
    // otherwise. Shown under GNU Go's name in the result sheet.
    let gnugoLevel: Int?
    let komi: Double
    // Epoch milliseconds. Optional so the app still decodes against a
    // server that predates this field being added to GET /api/games/:id.
    let createdAt: Int?
    // Short shared labels both players can edit, searchable from the game
    // list. Optional for the same reason as createdAt above.
    var tags: [String]?
    // Whether this game is one of the viewer's favourites. Optional for the
    // same reason as the two fields above.
    var starred: Bool?

    var tagList: [String] { tags ?? [] }

    // Clock fields — mirrors client/src/services/api.ts's ClockFields. A
    // null timeControl/mainTimeSeconds means the game is untimed, matching
    // the web client's own `isTimed = mainTimeSeconds !== null` check.
    let timeControl: TimeControl?
    let mainTimeSeconds: Int?
    let byoyomiSeconds: Int?
    let byoyomiPeriods: Int?
    let blackTimeRemainingMs: Int?
    let whiteTimeRemainingMs: Int?
    let blackPeriodsLeft: Int?
    let whitePeriodsLeft: Int?
    let turnStartedAt: Int?
}

// Mirrors client/src/services/api.ts's MoveResponse.
struct MoveResponse: Codable {
    let board: Board
    let capturedPoints: [Point]
    let nextColor: StoneColor
    let captures: Captures
}

// Mirrors client/src/services/api.ts's ValidateMoveResponse.
struct ValidateMoveResponse: Codable {
    let valid: Bool
    let error: String?
}

// Mirrors client/src/services/api.ts's PassResponse.
struct PassResponse: Codable {
    let status: String
    let result: String?
    let nextColor: StoneColor
}

// Mirrors client/src/services/api.ts's ResignResponse.
struct ResignResponse: Codable {
    let status: String
    let result: String?
}

// Mirrors client/src/services/api.ts's FinalizeScoringResponse.
struct FinalizeScoringResponse: Codable {
    let status: String
    let result: String?
    let captures: Captures
}

// Mirrors client/src/services/api.ts's ReopenScoringResponse — a union of
// three shapes ('requested'/'cancelled'/'confirmed'), collapsed into one
// struct with optional fields since Codable ignores whichever aren't present.
struct ReopenScoringResponse: Codable {
    let action: String
    let pendingReopenBy: StoneColor?
    let status: String?
}

// One entry in a user's own tag vocabulary: how they last added it, and how
// often, which is the order the suggestions come back in.
struct TagSuggestion: Decodable, Hashable {
    let tag: String
    let isPublic: Bool
    let count: Int
}
