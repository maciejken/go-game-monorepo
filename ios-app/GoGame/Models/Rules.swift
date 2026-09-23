import Foundation

// The half of the rules the app has never needed before, because the server
// was always the referee: whether a move is legal, and what it captures.
// Scoring.swift already covers the other half.
//
// This is a port of shared/src/index.ts, and the two are held together by
// shared/fixtures/rules.json — cases generated from the TypeScript engine
// that both sides must answer identically. Change a rule here and the
// fixtures will say so; change one there and regenerate them.

// A position the game has already been through: the board, and whose turn
// it was next. Superko compares against these.
struct PositionRecord: Equatable {
    let board: Board
    let nextColor: StoneColor
}

struct MoveValidation {
    let isValid: Bool
    let error: String?
    let board: Board?
    let capturedPoints: [Point]

    static func rejected(_ error: String) -> MoveValidation {
        MoveValidation(isValid: false, error: error, board: nil, capturedPoints: [])
    }

    static func accepted(board: Board, captured: [Point]) -> MoveValidation {
        MoveValidation(isValid: true, error: nil, board: board, capturedPoints: captured)
    }
}

// Move 0 is the START event the server logs before play, so the first stone
// is move 1 and odd numbers are Black's. A handicap game adds one, since the
// placement itself counts as a move and White answers it.
func currentColor(forMoveNumber moveNumber: Int) -> StoneColor {
    moveNumber % 2 == 1 ? .black : .white
}

func turnMoveNumber(_ moveNumber: Int, handicap: Int) -> Int {
    handicap >= 2 ? moveNumber + 1 : moveNumber
}

func opposite(_ color: StoneColor) -> StoneColor {
    color == .black ? .white : .black
}

func isOnBoard(_ board: Board, _ point: Point) -> Bool {
    point.y >= 0 && point.y < board.count && point.x >= 0 && point.x < board.count
}

func hasLiberties(_ board: Board, _ group: [Point]) -> Bool {
    let size = board.count
    for stone in group {
        for neighbour in [
            Point(x: stone.x, y: stone.y - 1),
            Point(x: stone.x, y: stone.y + 1),
            Point(x: stone.x - 1, y: stone.y),
            Point(x: stone.x + 1, y: stone.y),
        ] {
            guard neighbour.x >= 0, neighbour.x < size, neighbour.y >= 0, neighbour.y < size else { continue }
            if board[neighbour.y][neighbour.x] == nil {
                return true
            }
        }
    }
    return false
}

// Places the stone and removes whatever it kills. Captures are resolved
// before the played stone's own liberties are considered, which is what
// makes filling your last liberty legal when it takes a group with it.
func applyMove(_ board: Board, _ point: Point, _ color: StoneColor) -> (board: Board, captured: [Point]) {
    var next = board
    next[point.y][point.x] = color

    let enemy = opposite(color)
    var captured: [Point] = []
    var seen = Set<String>()

    for neighbour in [
        Point(x: point.x, y: point.y - 1),
        Point(x: point.x, y: point.y + 1),
        Point(x: point.x - 1, y: point.y),
        Point(x: point.x + 1, y: point.y),
    ] {
        guard isOnBoard(next, neighbour), next[neighbour.y][neighbour.x] == enemy else { continue }
        let key = "\(neighbour.x),\(neighbour.y)"
        if seen.contains(key) { continue }
        let group = getGroup(next, neighbour)
        for stone in group {
            seen.insert("\(stone.x),\(stone.y)")
        }
        if !hasLiberties(next, group) {
            for stone in group {
                next[stone.y][stone.x] = nil
                captured.append(stone)
            }
        }
    }

    return (next, captured)
}

// `history` is every position the game has passed through, including the
// starting one. Situational superko: a move is illegal if the position it
// produces — board plus whose turn is next — has occurred before. That
// subsumes simple ko, which is one specific case of it.
func validateMove(
    _ board: Board,
    _ point: Point,
    _ color: StoneColor,
    moveNumber: Int,
    history: [PositionRecord] = []
) -> MoveValidation {
    guard isOnBoard(board, point) else {
        return .rejected("Point is outside the board")
    }

    let expected = currentColor(forMoveNumber: moveNumber)
    guard color == expected else {
        return .rejected("It is \(expected.rawValue)'s turn")
    }

    guard board[point.y][point.x] == nil else {
        return .rejected("Point is already occupied")
    }

    let (resultBoard, capturedPoints) = applyMove(board, point, color)

    if capturedPoints.isEmpty, !hasLiberties(resultBoard, getGroup(resultBoard, point)) {
        return .rejected("Move is suicide")
    }

    // The TypeScript engine compares a hash first and then the board itself;
    // comparing boards alone is the same answer, and a game's history is far
    // too short for the hash to be worth carrying.
    let nextColor = opposite(color)
    let repeated = history.contains { $0.nextColor == nextColor && $0.board == resultBoard }
    if repeated {
        return .rejected("Move violates the superko rule (position already occurred)")
    }

    return .accepted(board: resultBoard, captured: capturedPoints)
}

func createEmptyBoard(size: Int) -> Board {
    Array(repeating: Array(repeating: nil as StoneColor?, count: size), count: size)
}

// Standard handicap star points, matching shared's table: corners fill
// upper-right, lower-left, lower-right, upper-left; the centre is included
// only for odd handicaps 5/7/9; side points are added left+right at 6, then
// top+bottom at 8. Sizes without side points simply run out of placements.
private struct StarPoints {
    let upperRight: Point
    let lowerLeft: Point
    let lowerRight: Point
    let upperLeft: Point
    let center: Point
    var leftMid: Point?
    var rightMid: Point?
    var topMid: Point?
    var bottomMid: Point?
}

private let starPoints: [Int: StarPoints] = [
    9: StarPoints(
        upperRight: Point(x: 6, y: 2), lowerLeft: Point(x: 2, y: 6),
        lowerRight: Point(x: 6, y: 6), upperLeft: Point(x: 2, y: 2),
        center: Point(x: 4, y: 4)
    ),
    13: StarPoints(
        upperRight: Point(x: 9, y: 3), lowerLeft: Point(x: 3, y: 9),
        lowerRight: Point(x: 9, y: 9), upperLeft: Point(x: 3, y: 3),
        center: Point(x: 6, y: 6)
    ),
    19: StarPoints(
        upperRight: Point(x: 15, y: 3), lowerLeft: Point(x: 3, y: 15),
        lowerRight: Point(x: 15, y: 15), upperLeft: Point(x: 3, y: 3),
        center: Point(x: 9, y: 9),
        leftMid: Point(x: 3, y: 9), rightMid: Point(x: 15, y: 9),
        topMid: Point(x: 9, y: 3), bottomMid: Point(x: 9, y: 15)
    ),
]

func handicapPoints(size: Int, handicap: Int) -> [Point] {
    guard let sp = starPoints[size], handicap >= 2 else {
        return []
    }

    let corners = [sp.upperRight, sp.lowerLeft, sp.lowerRight, sp.upperLeft]
    var points = Array(corners.prefix(min(handicap, 4)))

    if handicap >= 6, let left = sp.leftMid, let right = sp.rightMid {
        points.append(contentsOf: [left, right])
    }
    if handicap >= 8, let top = sp.topMid, let bottom = sp.bottomMid {
        points.append(contentsOf: [top, bottom])
    }
    if handicap == 5 || handicap == 7 || handicap == 9 {
        points.append(sp.center)
    }

    return points
}

// Handicap stones are the real compensation, so komi there is only a
// tie-breaker.
func defaultKomi(forHandicap handicap: Int) -> Double {
    handicap >= 2 ? 0.5 : 6.5
}
