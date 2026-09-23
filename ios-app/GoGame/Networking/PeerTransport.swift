import Foundation

// The guest's side of a game held on another device: every verb the board
// screen uses becomes one request over the link and one answer back.
//
// Nothing is decided here. The guest doesn't replay the log or check a move
// against the rules before sending it — the host is the referee, so the
// answer that comes back is the truth, and a guest running a tampered-with
// copy of the app gets nowhere.

// Sends requests and matches the answers back up with them. An actor because
// both sides of that bookkeeping — a request going out and a reply arriving
// on the link's own queue — touch the same table of what's outstanding.
actor PeerClient {
    private let link: PeerLink
    private var pending: [String: CheckedContinuation<PeerReply, Error>] = [:]
    // Called when the host says the game moved on. The board screen sets
    // this to refetch, which is the peer equivalent of its polling.
    private var onChanged: (@Sendable () -> Void)?
    // Two devices in the same room: an answer that hasn't arrived in this
    // long isn't slow, it's gone.
    private let timeout: Duration

    init(link: PeerLink, timeout: Duration = .seconds(10)) {
        self.link = link
        self.timeout = timeout
    }

    func start() {
        link.onReceive = { [weak self] data in
            Task { await self?.receive(data) }
        }
    }

    // The board sets this when it opens, to refetch when the host says the
    // game moved on — the peer equivalent of the live socket.
    func setOnChanged(_ handler: (@Sendable () -> Void)?) {
        onChanged = handler
    }

    func send(_ request: PeerRequest) async throws -> PeerReply {
        let id = UUID().uuidString
        let data = try PeerCoding.encode(.request(id: id, request))
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                try link.send(data)
            } catch {
                pending.removeValue(forKey: id)?.resume(throwing: error)
                return
            }
            Task { [weak self, timeout] in
                try? await Task.sleep(for: timeout)
                await self?.giveUp(on: id)
            }
        }
    }

    // The link went down: everything still waiting fails now rather than
    // waiting out its timeout one by one.
    func disconnected() {
        let waiting = pending.values
        pending.removeAll()
        for continuation in waiting {
            continuation.resume(throwing: PeerProtocolError.disconnected)
        }
    }

    private func giveUp(on id: String) {
        pending.removeValue(forKey: id)?.resume(throwing: PeerProtocolError.timedOut)
    }

    private func receive(_ data: Data) {
        guard let message = try? PeerCoding.decode(data) else { return }
        switch message {
        case let .reply(id, reply):
            pending.removeValue(forKey: id)?.resume(returning: reply)
        case .changed:
            onChanged?()
        case .request:
            // Only the host answers requests; a guest receiving one is a
            // confused peer, not something to act on.
            break
        }
    }
}

struct PeerTransport: GameTransport {
    let client: PeerClient

    // MARK: - Reading

    func state(gameId: String) async throws -> GameState {
        guard case let .state(state) = try await ask(.state(gameId: gameId)) else { throw unexpected }
        return state
    }

    func history(gameId: String) async throws -> GameHistoryResponse {
        guard case let .history(history) = try await ask(.history(gameId: gameId)) else { throw unexpected }
        return history
    }

    // MARK: - Playing

    func validateMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> ValidateMoveResponse {
        guard case let .validation(result) = try await ask(.validateMove(gameId: gameId, x: x, y: y, color: color)) else {
            throw unexpected
        }
        return result
    }

    func makeMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> MoveResponse {
        guard case let .move(response) = try await ask(.makeMove(gameId: gameId, x: x, y: y, color: color)) else {
            throw unexpected
        }
        return response
    }

    func pass(gameId: String, color: StoneColor) async throws -> PassResponse {
        guard case let .passed(response) = try await ask(.pass(gameId: gameId, color: color)) else { throw unexpected }
        return response
    }

    func resign(gameId: String, color: StoneColor) async throws -> ResignResponse {
        guard case let .resigned(response) = try await ask(.resign(gameId: gameId, color: color)) else { throw unexpected }
        return response
    }

    // MARK: - Scoring

    func finalizeScoring(
        gameId: String,
        deadPoints: [Point],
        sekiPoints: [Point]
    ) async throws -> FinalizeScoringResponse {
        let request = PeerRequest.finalizeScoring(gameId: gameId, deadPoints: deadPoints, sekiPoints: sekiPoints)
        guard case let .scored(response) = try await ask(request) else { throw unexpected }
        return response
    }

    func reopenScoring(gameId: String) async throws -> ReopenScoringResponse {
        guard case let .reopened(response) = try await ask(.reopenScoring(gameId: gameId)) else { throw unexpected }
        return response
    }

    // MARK: - Housekeeping

    func sgf(gameId: String) async throws -> String {
        guard case let .sgf(sgf) = try await ask(.sgf(gameId: gameId)) else { throw unexpected }
        return sgf
    }

    // The game lives on the other device, so there is nothing here to
    // delete and nothing the guest may delete there.
    func deleteGame(gameId: String) async throws {
        throw GameTransportError.unsupported("Only the device that started this game can delete it.")
    }

    func respondToInvite(gameId: String, accept: Bool) async throws {
        throw GameTransportError.unsupported("A nearby game has nobody to invite.")
    }

    func recomputeAiMove(gameId: String) async throws {
        throw GameTransportError.unsupported("A nearby game has no computer opponent.")
    }

    // MARK: - Asking

    private func ask(_ request: PeerRequest) async throws -> PeerReply {
        let reply = try await client.send(request)
        // A refusal is the host's answer, not a broken link: it carries the
        // reason, which is what the player needs to see.
        if case let .failed(reason) = reply {
            throw PeerProtocolError.refused(reason)
        }
        return reply
    }

    private var unexpected: Error {
        PeerProtocolError.refused(String(localized: "The other device answered with something unexpected."))
    }
}
