import Foundation

// The state machine the server runs in server.ts, as a pure function of the
// event log: which stones are on the board, whose turn it is, whether play
// is still going, and how it ended.
//
// The server keeps this log in SQLite and derives the same answers with a
// query per question; a device playing offline keeps the log itself and
// derives them here. shared/fixtures/game-flow.json holds the cases both
// have to agree on — scripts/check-server-flow.mjs drives them through the
// real API, scripts/check-swift-rules.sh through this.

enum GameEvent: Equatable {
    // The handicap placement is logged as event 0 when there is one; play
    // is numbered from 1 either way. There is no START row — the server
    // only synthesises one when it builds a history for display.
    case handicap(points: [Point])
    case move(color: StoneColor, point: Point)
    case pass(color: StoneColor)
    case resign(color: StoneColor)
}

enum GameStatus: String {
    case inProgress = "in_progress"
    case scoring
    case finished
}

// How a finished game ended, which is what decides whether scoring can be
// reopened and how the result reads.
enum EndReason: String {
    case scoring
    case resign
    case timeout
    case ended
}

struct GameConfiguration {
    let size: Int
    let handicap: Int
    let komi: Double

    init(size: Int, handicap: Int = 0, komi: Double? = nil) {
        self.size = size
        self.handicap = handicap
        self.komi = komi ?? defaultKomi(forHandicap: handicap)
    }
}

struct GameFlowState {
    var board: Board
    var captures: Captures
    var status: GameStatus
    var endReason: EndReason?
    // The SGF-style result ("B+R", "W+6.5") once there is one. The sentence
    // the clients show is built from this, not stored.
    var shortResult: String?
    var currentColor: StoneColor
    // Every position reached so far, for superko.
    var history: [PositionRecord]
    // The number the next event will be logged under.
    var nextMoveNumber: Int
}

enum GameFlowError: LocalizedError {
    case notInProgress
    case notYourTurn(StoneColor)
    case illegal(String)

    var errorDescription: String? {
        switch self {
        case .notInProgress:
            return "Game is not in progress"
        case let .notYourTurn(colour):
            return "It is \(colour.rawValue)'s turn"
        case let .illegal(reason):
            return reason
        }
    }
}

enum GameFlow {
    // Replays the log from the start. Deriving rather than storing means
    // there is one source of truth — the events — and no way for a cached
    // board to disagree with them.
    static func replay(_ events: [GameEvent], configuration: GameConfiguration) -> GameFlowState {
        var board = createEmptyBoard(size: configuration.size)
        var blackCaptures = 0
        var whiteCaptures = 0
        var status = GameStatus.inProgress
        var endReason: EndReason?
        var shortResult: String?
        var history: [PositionRecord] = []
        // Event 0 is the handicap placement when there is one, so play is
        // numbered from 1 in both cases: this counts the moves, passes and
        // resignations logged so far.
        var played = 0
        var previousWasPass = false

        for event in events {
            switch event {
            case let .handicap(points):
                for point in points {
                    board[point.y][point.x] = .black
                }
                history.append(
                    PositionRecord(board: board, nextColor: currentColor(forMoveNumber: turnMoveNumber(1, handicap: configuration.handicap)))
                )

            case let .move(colour, point):
                let (next, captured) = applyMove(board, point, colour)
                board = next
                if colour == .black {
                    blackCaptures += captured.count
                } else {
                    whiteCaptures += captured.count
                }
                played += 1
                history.append(
                    PositionRecord(board: board, nextColor: currentColor(forMoveNumber: turnMoveNumber(played + 1, handicap: configuration.handicap)))
                )
                previousWasPass = false

            case .pass:
                // Two in a row end play and open scoring, where dead stones
                // are marked before the result is computed.
                if previousWasPass {
                    status = .scoring
                }
                previousWasPass = true
                played += 1

            case let .resign(colour):
                status = .finished
                endReason = .resign
                shortResult = colour == .black ? "W+R" : "B+R"
                played += 1
            }
        }

        return GameFlowState(
            board: board,
            captures: Captures(black: blackCaptures, white: whiteCaptures),
            status: status,
            endReason: endReason,
            shortResult: shortResult,
            currentColor: currentColor(forMoveNumber: turnMoveNumber(played + 1, handicap: configuration.handicap)),
            history: history,
            nextMoveNumber: played + 1
        )
    }

    // What a new game starts with: nothing at all, or the handicap
    // placement.
    static func openingEvents(configuration: GameConfiguration) -> [GameEvent] {
        let points = handicapPoints(size: configuration.size, handicap: configuration.handicap)
        return points.isEmpty ? [] : [.handicap(points: points)]
    }

    // Validates a move against the current state and returns the event to
    // append, or throws with the same message the server would send.
    static func move(
        _ point: Point,
        as colour: StoneColor,
        in state: GameFlowState,
        configuration: GameConfiguration
    ) throws -> GameEvent {
        guard state.status == .inProgress else {
            throw GameFlowError.notInProgress
        }
        let result = validateMove(
            state.board,
            point,
            colour,
            moveNumber: turnMoveNumber(state.nextMoveNumber, handicap: configuration.handicap),
            history: state.history
        )
        guard result.isValid else {
            throw GameFlowError.illegal(result.error ?? "Invalid move")
        }
        return .move(color: colour, point: point)
    }

    static func pass(as colour: StoneColor, in state: GameFlowState) throws -> GameEvent {
        guard state.status == .inProgress else {
            throw GameFlowError.notInProgress
        }
        guard colour == state.currentColor else {
            throw GameFlowError.notYourTurn(state.currentColor)
        }
        return .pass(color: colour)
    }

    // Resigning is allowed off-turn: losing on purpose needs no permission
    // from the clock, and the server allows it too.
    static func resign(as colour: StoneColor, in state: GameFlowState) throws -> GameEvent {
        guard state.status == .inProgress || state.status == .scoring else {
            throw GameFlowError.notInProgress
        }
        return .resign(color: colour)
    }

    // The SGF-style result for a scored finish, formatted the way the
    // server writes it: no decimals when the margin is whole.
    static func shortResult(forScore score: ScoreResult) -> String {
        let margin = score.margin
        let formatted = margin == margin.rounded() ? String(Int(margin)) : String(format: "%.1f", margin)
        return "\(score.winner == .black ? "B" : "W")+\(formatted)"
    }
}
