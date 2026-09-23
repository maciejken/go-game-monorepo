import Foundation

// A game the device referees for itself: the store holds the log, GameFlow
// derives the state, and nothing leaves the phone.
//
// It answers in exactly the shapes ServerTransport does, because the board
// screen is written against those and shouldn't care which kind of game it
// is showing. shared/fixtures/game-flow.json is the agreement between the
// two, driven through this by ios-app/Tests.
struct LocalTransport: GameTransport {
    let store: OfflineGameStore

    init(store: OfflineGameStore = .shared) {
        self.store = store
    }

    // MARK: - Reading

    func state(gameId: String) async throws -> GameState {
        let record = try store.load(gameId)
        let flow = GameFlow.replay(record.gameEvents, configuration: record.configuration)
        return gameState(record: record, flow: flow)
    }

    func history(gameId: String) async throws -> GameHistoryResponse {
        let record = try store.load(gameId)
        let configuration = record.configuration
        var entries: [HistoryEntry] = []
        var replayed: [GameEvent] = []

        // The server synthesises a START entry for move 0 so review mode can
        // step back to the empty board; a handicap game's placement takes
        // that slot instead.
        let events = record.gameEvents
        if !events.contains(where: { if case .handicap = $0 { return true } else { return false } }) {
            entries.append(
                HistoryEntry(
                    moveNumber: 0,
                    board: createEmptyBoard(size: record.size),
                    eventType: "START",
                    color: nil,
                    point: nil,
                    capturedPoints: []
                )
            )
        }

        for (index, event) in events.enumerated() {
            replayed.append(event)
            let flow = GameFlow.replay(replayed, configuration: configuration)
            let previous = GameFlow.replay(Array(replayed.dropLast()), configuration: configuration)
            let captured = capturedPoints(before: previous.board, after: flow.board, event: event)

            switch event {
            case .handicap:
                entries.append(HistoryEntry(moveNumber: 0, board: flow.board, eventType: "HANDICAP", color: nil, point: nil, capturedPoints: []))
            case let .move(colour, point):
                entries.append(HistoryEntry(moveNumber: index + 1, board: flow.board, eventType: "MOVE", color: colour, point: point, capturedPoints: captured))
            case let .pass(colour):
                entries.append(HistoryEntry(moveNumber: index + 1, board: flow.board, eventType: "PASS", color: colour, point: nil, capturedPoints: []))
            case let .resign(colour):
                entries.append(HistoryEntry(moveNumber: index + 1, board: flow.board, eventType: "RESIGN", color: colour, point: nil, capturedPoints: []))
            }
        }

        return GameHistoryResponse(size: record.size, moves: entries)
    }

    // MARK: - Playing

    func validateMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> ValidateMoveResponse {
        let record = try store.load(gameId)
        let flow = GameFlow.replay(record.gameEvents, configuration: record.configuration)
        do {
            _ = try GameFlow.move(Point(x: x, y: y), as: color, in: flow, configuration: record.configuration)
            return ValidateMoveResponse(valid: true, error: nil)
        } catch {
            return ValidateMoveResponse(valid: false, error: (error as? LocalizedError)?.errorDescription)
        }
    }

    func makeMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> MoveResponse {
        var record = try store.load(gameId)
        let configuration = record.configuration
        let before = GameFlow.replay(record.gameEvents, configuration: configuration)
        let event = try GameFlow.move(Point(x: x, y: y), as: color, in: before, configuration: configuration)

        record.events.append(StoredGameEvent(event))
        try store.save(record)

        let after = GameFlow.replay(record.gameEvents, configuration: configuration)
        return MoveResponse(
            board: after.board,
            capturedPoints: capturedPoints(before: before.board, after: after.board, event: event),
            nextColor: after.currentColor,
            captures: after.captures
        )
    }

    func pass(gameId: String, color: StoneColor) async throws -> PassResponse {
        var record = try store.load(gameId)
        let configuration = record.configuration
        let event = try GameFlow.pass(as: color, in: GameFlow.replay(record.gameEvents, configuration: configuration))

        record.events.append(StoredGameEvent(event))
        try store.save(record)

        let after = GameFlow.replay(record.gameEvents, configuration: configuration)
        return PassResponse(status: after.status.rawValue, result: nil, nextColor: after.currentColor)
    }

    func resign(gameId: String, color: StoneColor) async throws -> ResignResponse {
        var record = try store.load(gameId)
        let configuration = record.configuration
        let event = try GameFlow.resign(as: color, in: GameFlow.replay(record.gameEvents, configuration: configuration))

        record.events.append(StoredGameEvent(event))
        try store.save(record)

        let after = GameFlow.replay(record.gameEvents, configuration: configuration)
        return ResignResponse(status: after.status.rawValue, result: after.shortResult)
    }

    // MARK: - Scoring

    func finalizeScoring(
        gameId: String,
        deadPoints: [Point],
        sekiPoints: [Point]
    ) async throws -> FinalizeScoringResponse {
        var record = try store.load(gameId)
        let configuration = record.configuration
        let flow = GameFlow.replay(record.gameEvents, configuration: configuration)
        let (effective, adjusted) = applyDeadStones(flow.board, flow.captures, deadPoints)
        let score = scoreBoard(effective, adjusted, komi: configuration.komi, declaredSekiPoints: sekiPoints)

        record.deadPoints = deadPoints
        record.sekiPoints = sekiPoints
        record.scoredResult = GameFlow.shortResult(forScore: score)
        record.scoredBlack = score.black
        record.scoredWhite = score.white
        try store.save(record)

        return FinalizeScoringResponse(
            status: GameStatus.finished.rawValue,
            result: record.scoredResult,
            captures: adjusted
        )
    }

    // Local games reopen straight away: the negotiation the server runs
    // exists so one player can't reopen a finished game behind the other's
    // back, and here both players are this device.
    func reopenScoring(gameId: String) async throws -> ReopenScoringResponse {
        var record = try store.load(gameId)
        record.scoredResult = nil
        record.scoredBlack = nil
        record.scoredWhite = nil
        try store.save(record)
        return ReopenScoringResponse(action: "confirmed", pendingReopenBy: nil, status: GameStatus.scoring.rawValue)
    }

    // MARK: - Housekeeping

    func deleteGame(gameId: String) async throws {
        try store.delete(gameId)
    }

    func sgf(gameId: String) async throws -> String {
        let record = try store.load(gameId)
        return offlineSgf(record)
    }

    func respondToInvite(gameId: String, accept: Bool) async throws {
        throw GameTransportError.unsupported("An offline game has nobody to invite.")
    }

    func recomputeAiMove(gameId: String) async throws {
        throw GameTransportError.unsupported("An offline game has no computer opponent.")
    }

    // MARK: - Building the shapes the board expects

    private func gameState(record: OfflineGameRecord, flow: GameFlowState) -> GameState {
        let scored = record.scoredResult
        let status = scored != nil ? GameStatus.finished : flow.status
        let lastEvent = lastEvent(for: record.gameEvents.last, board: flow.board, configuration: record.configuration, events: record.gameEvents)

        return GameState(
            id: record.id,
            size: record.size,
            handicap: record.handicap,
            title: record.title,
            status: status.rawValue,
            board: flow.board,
            blackUsername: displayName(record.blackName, colour: .black),
            whiteUsername: displayName(record.whiteName, colour: .white),
            blackUserId: nil,
            whiteUserId: nil,
            currentColor: flow.currentColor,
            captures: flow.captures,
            myColor: record.myColor,
            pendingInviteResponse: false,
            lastMove: lastMovePoint(record.gameEvents),
            lastEvent: lastEvent,
            result: nil,
            shortResult: scored ?? flow.shortResult,
            resultBreakdown: record.scoredBlack.map { black in
                ResultBreakdown(black: black, white: record.scoredWhite ?? 0)
            },
            pendingReopenBy: nil,
            isAiOpponent: false,
            gnugoLevel: nil,
            komi: record.komi,
            createdAt: record.createdAt,
            tags: [],
            starred: false,
            // Offline games are untimed for now: a clock the device runs
            // alone has nobody to keep it honest, and nothing here needs one
            // yet.
            timeControl: nil,
            mainTimeSeconds: nil,
            byoyomiSeconds: nil,
            byoyomiPeriods: nil,
            blackTimeRemainingMs: nil,
            whiteTimeRemainingMs: nil,
            blackPeriodsLeft: nil,
            whitePeriodsLeft: nil,
            turnStartedAt: nil
        )
    }

    private func lastMovePoint(_ events: [GameEvent]) -> Point? {
        for event in events.reversed() {
            if case let .move(_, point) = event {
                return point
            }
            // A pass or resignation leaves the previous stone marked, same
            // as the server does.
            if case .pass = event { continue }
            if case .resign = event { continue }
        }
        return nil
    }

    private func lastEvent(
        for event: GameEvent?,
        board: Board,
        configuration: GameConfiguration,
        events: [GameEvent]
    ) -> LastEvent? {
        guard let event else { return nil }
        let previous = GameFlow.replay(Array(events.dropLast()), configuration: configuration)
        switch event {
        case .handicap:
            return LastEvent(eventType: "HANDICAP", color: nil, point: nil, capturedPoints: [])
        case let .move(colour, point):
            return LastEvent(
                eventType: "MOVE",
                color: colour,
                point: point,
                capturedPoints: capturedPoints(before: previous.board, after: board, event: event)
            )
        case let .pass(colour):
            return LastEvent(eventType: "PASS", color: colour, point: nil, capturedPoints: [])
        case let .resign(colour):
            return LastEvent(eventType: "RESIGN", color: colour, point: nil, capturedPoints: [])
        }
    }

    // Whatever disappeared between the two boards, minus the stone just
    // played — cheaper than threading capture lists through the replay, and
    // a board comparison can't disagree with the board.
    private func capturedPoints(before: Board, after: Board, event: GameEvent) -> [Point] {
        guard case .move = event else { return [] }
        var captured: [Point] = []
        for y in before.indices {
            for x in before[y].indices where before[y][x] != nil && after[y][x] == nil {
                captured.append(Point(x: x, y: y))
            }
        }
        return captured
    }
}

// A minimal SGF for an offline game: enough for another program to read the
// game back, which is the whole point of being able to export one.
private func offlineSgf(_ record: OfflineGameRecord) -> String {
    func coordinate(_ point: Point) -> String {
        let letters = Array("abcdefghijklmnopqrstuvwxyz")
        return "\(letters[point.x])\(letters[point.y])"
    }

    var root = "GM[1]FF[4]CA[UTF-8]SZ[\(record.size)]KM[\(record.komi)]"
    if record.handicap >= 2 {
        root += "HA[\(record.handicap)]"
    }
    if let title = record.title, !title.isEmpty {
        root += "GN[\(title.replacingOccurrences(of: "]", with: "\\]"))]"
    }
    if let result = record.scoredResult {
        root += "RE[\(result)]"
    }

    var body = ""
    for event in record.gameEvents {
        switch event {
        case let .handicap(points):
            root += "AB" + points.map { "[\(coordinate($0))]" }.joined()
        case let .move(colour, point):
            body += ";\(colour == .black ? "B" : "W")[\(coordinate(point))]"
        case let .pass(colour):
            body += ";\(colour == .black ? "B" : "W")[]"
        case .resign:
            break
        }
    }

    return "(;\(root)\(body))\n"
}
