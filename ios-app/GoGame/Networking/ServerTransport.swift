import Foundation

// The games this app has always played: the server is the referee and the
// store, and every verb is one request.
struct ServerTransport: GameTransport {
    func state(gameId: String) async throws -> GameState {
        try await APIClient.getGame(id: gameId)
    }

    func history(gameId: String) async throws -> GameHistoryResponse {
        try await APIClient.getGameHistory(id: gameId)
    }

    func validateMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> ValidateMoveResponse {
        try await APIClient.validateMove(gameId: gameId, x: x, y: y, color: color)
    }

    func makeMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> MoveResponse {
        try await APIClient.makeMove(gameId: gameId, x: x, y: y, color: color)
    }

    func pass(gameId: String, color: StoneColor) async throws -> PassResponse {
        try await APIClient.pass(gameId: gameId, color: color)
    }

    func resign(gameId: String, color: StoneColor) async throws -> ResignResponse {
        try await APIClient.resign(gameId: gameId, color: color)
    }

    func finalizeScoring(
        gameId: String,
        deadPoints: [Point],
        sekiPoints: [Point]
    ) async throws -> FinalizeScoringResponse {
        try await APIClient.finalizeScoring(gameId: gameId, deadPoints: deadPoints, sekiPoints: sekiPoints)
    }

    func reopenScoring(gameId: String) async throws -> ReopenScoringResponse {
        try await APIClient.reopenScoring(gameId: gameId)
    }

    func deleteGame(gameId: String) async throws {
        try await APIClient.deleteGame(gameId: gameId)
    }

    func sgf(gameId: String) async throws -> String {
        try await APIClient.getSgf(id: gameId)
    }

    func respondToInvite(gameId: String, accept: Bool) async throws {
        try await APIClient.respondToInvite(gameId: gameId, accept: accept)
    }

    func recomputeAiMove(gameId: String) async throws {
        try await APIClient.recomputeAiMove(gameId: gameId)
    }
}

// Which transport a given game needs. Offline games carry a recognisable
// id (see offlineGameIdPrefix), so nothing has to be looked up or passed
// down through the views to know where a game lives.
//
// A game joined from a nearby device is the exception: it has the host's id,
// which says nothing about where it is from this side, so the open
// connection is what identifies it.
func makeTransport(forGameId id: String) -> GameTransport {
    if let nearby = NearbySessions.shared.transport(forGameId: id) {
        return nearby
    }
    return isOfflineGameId(id) ? LocalTransport() : ServerTransport()
}
