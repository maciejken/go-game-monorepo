import Foundation

// What two devices say to each other while playing a game with no server
// between them.
//
// The shape is deliberately the same conversation the app already has with
// the server: the guest asks for exactly the things GameTransport names, and
// the host — which holds the game and referees it — answers in the same
// response types the server sends. That is why the board screen can't tell
// the difference, and why the same fixtures can be driven through a pair of
// linked devices as through one playing alone.
//
// Everything travels as JSON. It is a couple of hundred bytes per move
// between two phones in the same room, so there is nothing to gain from a
// tighter encoding and plenty to gain from being able to read a log of it.

enum PeerRequest: Codable {
    case state(gameId: String)
    case history(gameId: String)
    case validateMove(gameId: String, x: Int, y: Int, color: StoneColor)
    case makeMove(gameId: String, x: Int, y: Int, color: StoneColor)
    case pass(gameId: String, color: StoneColor)
    case resign(gameId: String, color: StoneColor)
    case finalizeScoring(gameId: String, deadPoints: [Point], sekiPoints: [Point])
    case reopenScoring(gameId: String)
    case sgf(gameId: String)
}

enum PeerReply: Codable {
    case state(GameState)
    case history(GameHistoryResponse)
    case validation(ValidateMoveResponse)
    case move(MoveResponse)
    case passed(PassResponse)
    case resigned(ResignResponse)
    case scored(FinalizeScoringResponse)
    case reopened(ReopenScoringResponse)
    case sgf(String)
    // The host refused or couldn't do it. It carries the sentence the host
    // would have shown its own player, already localized there — both
    // devices are running the same app, and a reason travels better than an
    // error code nobody has a table for.
    case failed(String)
}

enum PeerMessage: Codable {
    case request(id: String, PeerRequest)
    case reply(id: String, PeerReply)
    // The host played, passed or resigned: whatever the guest is showing is
    // now stale and it should ask for the state again. The state isn't
    // pushed with it, because the guest may be in review mode or scoring and
    // is the one that knows what it needs.
    case changed
}

enum PeerProtocolError: LocalizedError {
    case timedOut
    case disconnected
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .timedOut:
            return "The other device didn't answer."
        case .disconnected:
            return "The connection to the other device was lost."
        case let .refused(reason):
            return reason
        }
    }
}

// The one thing a link has to do: carry bytes to the other device, in order,
// without losing them. MultipeerConnectivity is one; the fixture runner
// pairs two ends in memory.
protocol PeerLink: AnyObject {
    func send(_ data: Data) throws
    var onReceive: ((Data) -> Void)? { get set }
}

enum PeerCoding {
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()

    static func encode(_ message: PeerMessage) throws -> Data {
        try encoder.encode(message)
    }

    static func decode(_ data: Data) throws -> PeerMessage {
        try decoder.decode(PeerMessage.self, from: data)
    }
}
