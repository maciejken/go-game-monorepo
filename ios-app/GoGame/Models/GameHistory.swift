import Foundation

// Mirrors server/src/server.ts's MoveHistoryEntry / GET /api/games/:id/history
// response — the full move-by-move record backing review mode: every logged
// event (START, HANDICAP, MOVE, PASS, RESIGN), paired with the board as it
// stood right after.
struct HistoryEntry: Codable {
    let moveNumber: Int
    let board: Board
    let eventType: String
    let color: StoneColor?
    let point: Point?
    let capturedPoints: [Point]
}

struct GameHistoryResponse: Codable {
    let size: Int
    let moves: [HistoryEntry]
}

// Cumulative captures as of `upToMoveNumber` — mirrors
// client/src/pages/Game.tsx's sumCaptures.
func sumCaptures(_ entries: [HistoryEntry], upTo upToMoveNumber: Int) -> Captures {
    var black = 0
    var white = 0
    for entry in entries {
        guard entry.moveNumber <= upToMoveNumber, entry.eventType == "MOVE", !entry.capturedPoints.isEmpty else {
            continue
        }
        if entry.color == .black {
            black += entry.capturedPoints.count
        } else if entry.color == .white {
            white += entry.capturedPoints.count
        }
    }
    return Captures(black: black, white: white)
}
