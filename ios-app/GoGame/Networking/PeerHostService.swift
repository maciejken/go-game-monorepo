import Foundation

// The device that started the game answers for it. It holds the log, it
// referees with the same GameFlow both devices carry, and the guest never
// decides anything — exactly the arrangement the server has with its
// clients, minus the server.
//
// It plays no part in the host's own moves: those go through LocalTransport
// as before. This only serves the guest, and tells it when something
// happened on this side.
final class PeerHostService {
    private let transport: GameTransport
    private let gameId: String
    // Which colour the guest plays. The host's own view of the game says
    // whose it is from the host's side, so the one thing that has to be
    // rewritten before an answer goes out is the perspective.
    private let guestColor: StoneColor
    private weak var link: PeerLink?
    // Called after the guest changes the game, so the host's board reloads
    // — the other half of notifyChanged().
    var onGuestActed: (@Sendable () -> Void)?

    init(transport: GameTransport = LocalTransport(), gameId: String, guestColor: StoneColor, link: PeerLink) {
        self.transport = transport
        self.gameId = gameId
        self.guestColor = guestColor
        self.link = link
        link.onReceive = { [weak self] data in
            guard let self else { return }
            Task { await self.receive(data) }
        }
    }

    // Tell the guest the game moved on, so it asks for the state again. Sent
    // after the host plays, passes, resigns or finishes scoring.
    func notifyChanged() {
        guard let data = try? PeerCoding.encode(.changed) else { return }
        try? link?.send(data)
    }

    private func receive(_ data: Data) async {
        guard case let .request(id, request) = try? PeerCoding.decode(data) else { return }
        let reply = await answer(request)
        if let encoded = try? PeerCoding.encode(.reply(id: id, reply)) {
            try? link?.send(encoded)
        }
        if changesTheGame(request), !isRefusal(reply) {
            onGuestActed?()
        }
    }

    private func isRefusal(_ reply: PeerReply) -> Bool {
        if case .failed = reply { return true }
        return false
    }

    // Which requests leave the game different afterwards. A guest reading
    // the state doesn't need the host's board to do anything.
    private func changesTheGame(_ request: PeerRequest) -> Bool {
        switch request {
        case .makeMove, .pass, .resign, .finalizeScoring, .reopenScoring:
            return true
        case .state, .history, .validateMove, .sgf:
            return false
        }
    }

    // Every request names the game it is about, and the only game this host
    // is serving is the one it started: a guest asking about anything else
    // is refused rather than quietly served.
    private func answer(_ request: PeerRequest) async -> PeerReply {
        guard requestedGameId(request) == gameId else {
            return .failed("That game isn't being shared.")
        }
        do {
            switch request {
            case let .state(gameId):
                var state = try await transport.state(gameId: gameId)
                state.myColor = guestColor == .black ? .black : .white
                return .state(state)
            case let .history(gameId):
                return .history(try await transport.history(gameId: gameId))
            case let .validateMove(gameId, x, y, colour):
                guard colour == guestColor else {
                    return .validation(ValidateMoveResponse(valid: false, error: notYourStones))
                }
                return .validation(try await transport.validateMove(gameId: gameId, x: x, y: y, color: colour))
            case let .makeMove(gameId, x, y, colour):
                guard colour == guestColor else { return .failed(notYourStones) }
                let response = try await transport.makeMove(gameId: gameId, x: x, y: y, color: colour)
                return .move(response)
            case let .pass(gameId, colour):
                guard colour == guestColor else { return .failed(notYourStones) }
                return .passed(try await transport.pass(gameId: gameId, color: colour))
            case let .resign(gameId, colour):
                guard colour == guestColor else { return .failed(notYourStones) }
                return .resigned(try await transport.resign(gameId: gameId, color: colour))
            case let .finalizeScoring(gameId, deadPoints, sekiPoints):
                return .scored(
                    try await transport.finalizeScoring(gameId: gameId, deadPoints: deadPoints, sekiPoints: sekiPoints)
                )
            case let .reopenScoring(gameId):
                return .reopened(try await transport.reopenScoring(gameId: gameId))
            case let .sgf(gameId):
                return .sgf(try await transport.sgf(gameId: gameId))
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    // A guest that asks to move the host's stones is refused here rather
    // than trusted: the host is the referee, and the only thing making the
    // guest well-behaved is the same app running on it.
    private var notYourStones: String {
        String(localized: "Those aren't your stones to play.")
    }

    private func requestedGameId(_ request: PeerRequest) -> String {
        switch request {
        case let .state(gameId),
             let .history(gameId),
             let .validateMove(gameId, _, _, _),
             let .makeMove(gameId, _, _, _),
             let .pass(gameId, _),
             let .resign(gameId, _),
             let .finalizeScoring(gameId, _, _),
             let .reopenScoring(gameId),
             let .sgf(gameId):
            return gameId
        }
    }
}
