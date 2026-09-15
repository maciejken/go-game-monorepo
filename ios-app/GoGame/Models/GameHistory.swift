import Foundation

// The fields GameBoardView's describeEntry actually needs to describe an
// event in words — shared by HistoryEntry (review mode, one per logged
// event) and LastEvent (the live game's own most recent event) so the same
// describeEntry works for both without either needing the other's extra
// fields (moveNumber/board).
protocol MoveEventDescribable {
    var eventType: String { get }
    var color: StoneColor? { get }
    var point: Point? { get }
    var capturedPoints: [Point] { get }
}

// Mirrors server/src/server.ts's MoveHistoryEntry / GET /api/games/:id/history
// response — the full move-by-move record backing review mode: every logged
// event (START, HANDICAP, MOVE, PASS, RESIGN), paired with the board as it
// stood right after.
struct HistoryEntry: Codable, MoveEventDescribable {
    let moveNumber: Int
    let board: Board
    let eventType: String
    let color: StoneColor?
    let point: Point?
    let capturedPoints: [Point]
}

// Mirrors server/src/server.ts's LastEvent (GameStateResponse.lastEvent) —
// whatever happened most recently in a live game, independent of the
// stone-marker-only lastMove. Its whole reason to exist is a pass: unlike a
// move, a pass leaves no visible change on the board at all, so without
// this there's no way to tell "opponent passed" from "still my opponent's
// turn, nothing has happened yet."
struct LastEvent: Codable, MoveEventDescribable {
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
