import Foundation

// Everything the board screen does to a game, named the way the game thinks
// about it rather than the way HTTP does.
//
// Today there is exactly one implementation and it forwards to APIClient —
// the point is the seam, not the indirection. A game played offline keeps
// its own state on the device, and a peer-to-peer game keeps it on whoever
// started it; both will arrive as further implementations, and the views
// that call these methods will not be able to tell which one they have.
//
// Two of these are server-only ideas: only the server runs GNU Go, and only
// the server has invitations to answer. Implementations that can't do them
// throw GameTransportError.unsupported rather than pretending.
protocol GameTransport {
    func state(gameId: String) async throws -> GameState
    func history(gameId: String) async throws -> GameHistoryResponse
    func validateMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> ValidateMoveResponse
    func makeMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> MoveResponse
    func pass(gameId: String, color: StoneColor) async throws -> PassResponse
    func resign(gameId: String, color: StoneColor) async throws -> ResignResponse
    func finalizeScoring(
        gameId: String,
        deadPoints: [Point],
        sekiPoints: [Point]
    ) async throws -> FinalizeScoringResponse
    func reopenScoring(gameId: String) async throws -> ReopenScoringResponse
    func deleteGame(gameId: String) async throws
    func sgf(gameId: String) async throws -> String
    func respondToInvite(gameId: String, accept: Bool) async throws
    func recomputeAiMove(gameId: String) async throws
}

enum GameTransportError: LocalizedError {
    // Named so the message says which kind of game can't do it, since the
    // person reading it has no idea there is such a thing as a transport.
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case let .unsupported(what):
            return what
        }
    }
}
