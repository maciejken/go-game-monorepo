import Foundation
import MultipeerConnectivity

// Finding the other device and holding the connection open. Everything the
// two devices actually say to each other is PeerProtocol's business; this is
// only the wire it travels on.
//
// MultipeerConnectivity is what makes the "no router, no internet" part
// true: it uses infrastructure Wi-Fi when there is some, and peer-to-peer
// Wi-Fi or Bluetooth when there isn't, without the app choosing.

// Bonjour's limit is 15 characters, lowercase letters, digits and hyphens.
// It must match NSBonjourServices in Info.plist.
let nearbyServiceType = "igo5-game"

// One connected device, as a PeerLink. The session is set up for exactly two
// devices: a game has two players, and a second guest would have nothing to
// do.
final class MultipeerLink: NSObject, PeerLink, MCSessionDelegate {
    let session: MCSession
    var onReceive: ((Data) -> Void)?
    var onConnected: (@Sendable () -> Void)?
    var onDisconnected: (@Sendable () -> Void)?

    init(peerId: MCPeerID) {
        // Encrypted, not because a Go move is a secret, but because the
        // alternative is an open listener on whatever network this is.
        session = MCSession(peer: peerId, securityIdentity: nil, encryptionPreference: .required)
        super.init()
        session.delegate = self
    }

    var isConnected: Bool { !session.connectedPeers.isEmpty }

    func send(_ data: Data) throws {
        let peers = session.connectedPeers
        guard !peers.isEmpty else { throw PeerProtocolError.disconnected }
        try session.send(data, toPeers: peers, with: .reliable)
    }

    func disconnect() {
        session.disconnect()
    }

    // MARK: - MCSessionDelegate

    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        switch state {
        case .connected:
            onConnected?()
        case .notConnected:
            onDisconnected?()
        default:
            break
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        onReceive?(data)
    }

    // Nothing here streams or sends files: a game is a handful of small
    // messages, and the unused parts of the protocol stay unused.
    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(
        _ session: MCSession,
        didFinishReceivingResourceWithName resourceName: String,
        fromPeer peerID: MCPeerID,
        at localURL: URL?,
        withError error: Error?
    ) {}
}

// What a host puts in the air about the game it is offering, and what a
// guest reads off it before deciding to join. Strings, because that is what
// MultipeerConnectivity's discovery info is.
enum NearbyAdvert {
    static func encode(record: OfflineGameRecord, hostName: String) -> [String: String] {
        [
            "gameId": record.id,
            "size": String(record.size),
            "handicap": String(record.handicap),
            // The colour on offer is whichever the host didn't take.
            "guestColor": (record.hostColor == .black ? StoneColor.white : StoneColor.black).rawValue,
            "host": hostName,
            "title": record.title ?? "",
        ]
    }

    static func decode(_ info: [String: String]?) -> NearbyGame? {
        guard
            let info,
            let gameId = info["gameId"],
            let size = info["size"].flatMap(Int.init),
            let guestColor = info["guestColor"].flatMap(StoneColor.init(rawValue:))
        else {
            return nil
        }
        return NearbyGame(
            gameId: gameId,
            size: size,
            handicap: info["handicap"].flatMap(Int.init) ?? 0,
            yourColor: guestColor,
            hostName: info["host"] ?? "",
            title: (info["title"]?.isEmpty == false) ? info["title"] : nil
        )
    }
}

// A game someone nearby is offering.
struct NearbyGame: Identifiable, Equatable {
    let gameId: String
    let size: Int
    let handicap: Int
    let yourColor: StoneColor
    let hostName: String
    let title: String?

    var id: String { gameId }
}

// The device that started the game: it advertises it, accepts the first
// player who asks, and then referees for them.
@Observable
final class NearbyHost: NSObject, MCNearbyServiceAdvertiserDelegate {
    enum Phase: Equatable {
        case idle
        case waiting
        case connected
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private var advertiser: MCNearbyServiceAdvertiser?
    private var link: MultipeerLink?
    private var service: PeerHostService?
    private(set) var gameId: String?
    // Set by the host's board while it is open, so a move made on the other
    // device shows up here.
    var onGuestActed: (@Sendable () -> Void)? {
        didSet { service?.onGuestActed = onGuestActed }
    }

    // Starts offering the game. The host keeps playing through
    // LocalTransport as it always did — this only opens the other seat.
    func start(record: OfflineGameRecord, hostName: String, transport: GameTransport = LocalTransport()) {
        stop()
        let guestColor: StoneColor = record.hostColor == .black ? .white : .black
        let peerId = MCPeerID(displayName: String(hostName.prefix(63)))
        let link = MultipeerLink(peerId: peerId)
        let service = PeerHostService(
            transport: transport,
            gameId: record.id,
            guestColor: guestColor,
            link: link
        )
        service.onGuestActed = onGuestActed
        link.onConnected = { [weak link] in
            Task { @MainActor [weak self] in
                self?.phase = .connected
                // One seat, one player: once it's taken there is nothing
                // left to advertise.
                self?.advertiser?.stopAdvertisingPeer()
                // Now that somebody is in it, the other seat has a name.
                if let guestName = link?.session.connectedPeers.first?.displayName {
                    self?.remember(guestName: guestName, as: guestColor, in: record.id)
                }
            }
        }
        link.onDisconnected = { [weak self] in
            Task { @MainActor in
                guard self?.phase == .connected else { return }
                self?.phase = .waiting
                self?.advertiser?.startAdvertisingPeer()
            }
        }

        let advertiser = MCNearbyServiceAdvertiser(
            peer: peerId,
            discoveryInfo: NearbyAdvert.encode(record: record, hostName: hostName),
            serviceType: nearbyServiceType
        )
        advertiser.delegate = self
        advertiser.startAdvertisingPeer()

        self.link = link
        self.service = service
        self.advertiser = advertiser
        gameId = record.id
        phase = .waiting
        NearbySessions.shared.host = self
    }

    // The guest's name goes on their side of the game, so the board and the
    // list say who is playing rather than just which colour.
    private func remember(guestName: String, as colour: StoneColor, in gameId: String) {
        guard var record = try? OfflineGameStore.shared.load(gameId) else { return }
        if colour == .black {
            record.blackName = guestName
        } else {
            record.whiteName = guestName
        }
        try? OfflineGameStore.shared.save(record)
    }

    // Coming back to the app. The advertiser doesn't survive being
    // suspended, so a game nobody has joined is offered again; one that was
    // joined has lost its connection too, and waits to be rejoined.
    func resume() {
        guard advertiser != nil else { return }
        if link?.isConnected != true {
            phase = .waiting
            advertiser?.startAdvertisingPeer()
        }
    }

    // Tells the guest the game moved on after the host's own move.
    func notifyChanged() {
        service?.notifyChanged()
    }

    func stop() {
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        link?.disconnect()
        link = nil
        service = nil
        gameId = nil
        phase = .idle
        if NearbySessions.shared.host === self {
            NearbySessions.shared.host = nil
        }
    }

    // MARK: - MCNearbyServiceAdvertiserDelegate

    func advertiser(
        _ advertiser: MCNearbyServiceAdvertiser,
        didReceiveInvitationFromPeer peerID: MCPeerID,
        withContext context: Data?,
        invitationHandler: @escaping (Bool, MCSession?) -> Void
    ) {
        // The seat is taken by whoever asks first. Nothing here is worth
        // guarding with a prompt: the game is already being announced to
        // everyone in the room, and the host can stop sharing at any time.
        guard let link, !link.isConnected else {
            invitationHandler(false, nil)
            return
        }
        invitationHandler(true, link.session)
    }

    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        Task { @MainActor in
            phase = .failed(error.localizedDescription)
        }
    }
}

// The device joining someone else's game: it looks for games on offer, asks
// to join one, and from then on plays through PeerTransport.
@Observable
final class NearbyGuest: NSObject, MCNearbyServiceBrowserDelegate {
    enum Phase: Equatable {
        case idle
        case looking
        case joining
        case joined(String)
        // The game is still this guest's; the connection to it isn't there
        // at the moment. Losing it is ordinary — walking out of range, or
        // either app spending a moment in the background, is enough — so
        // this is a state to sit in and come back from, not a failure.
        case reconnecting(String)
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var games: [NearbyGame] = []

    private var browser: MCNearbyServiceBrowser?
    private var peerId: MCPeerID?
    private var link: MultipeerLink?
    private var peers: [String: MCPeerID] = [:]
    // The game this guest is in, kept so the same one can be rejoined
    // without asking anyone: the host offers it again under the same id.
    private var joinedGame: NearbyGame?
    // Outlives each connection, so the board's transport and its refetch
    // hook survive a reconnection rather than being swapped underneath it.
    private var client: PeerClient?

    func startLooking(as name: String) {
        stop()
        let peerId = MCPeerID(displayName: String(name.prefix(63)))
        self.peerId = peerId
        startBrowsing()
        phase = .looking
    }

    private func startBrowsing() {
        guard let peerId else { return }
        browser?.stopBrowsingForPeers()
        let browser = MCNearbyServiceBrowser(peer: peerId, serviceType: nearbyServiceType)
        browser.delegate = self
        browser.startBrowsingForPeers()
        self.browser = browser
    }

    func join(_ game: NearbyGame) {
        joinedGame = game
        let client = self.client ?? PeerClient()
        self.client = client
        connect(to: game, using: client)
    }

    // Coming back to the app: whatever the session was doing, it wasn't
    // doing it while suspended. Browsing restarts, and a game that was
    // joined is looked for again.
    func resume() {
        switch phase {
        case .joined, .reconnecting:
            guard let game = joinedGame else { return }
            if link?.isConnected != true {
                phase = .reconnecting(game.gameId)
                startBrowsing()
            }
        case .looking:
            startBrowsing()
        default:
            break
        }
    }

    private func connect(to game: NearbyGame, using client: PeerClient) {
        guard let peerId, let browser, let peer = peers[game.gameId] else { return }
        let link = MultipeerLink(peerId: peerId)
        link.onConnected = {
            Task { @MainActor [weak self] in
                guard let self else { return }
                await client.attach(link)
                NearbySessions.shared.guest = self
                NearbySessions.shared.register(gameId: game.gameId, transport: PeerTransport(client: client))
                phase = .joined(game.gameId)
                // Nothing more to find: the game is in hand again.
                browser.stopBrowsingForPeers()
            }
        }
        link.onDisconnected = {
            Task { @MainActor [weak self] in
                // Whatever the board was waiting on fails now rather than
                // sitting there until each request times out.
                await client.disconnected()
                guard let self else { return }
                switch phase {
                case .joined, .joining, .reconnecting:
                    // The transport stays registered: the board keeps
                    // talking to the same client, which starts answering
                    // again once there is a link under it.
                    phase = .reconnecting(game.gameId)
                    games = []
                    peers = [:]
                    startBrowsing()
                default:
                    break
                }
            }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            browser.invitePeer(peer, to: link.session, withContext: nil, timeout: 20)
            self.link = link
            if case .reconnecting = phase {} else {
                phase = .joining
            }
        }
    }

    func stop() {
        browser?.stopBrowsingForPeers()
        browser = nil
        link?.disconnect()
        link = nil
        if let gameId = joinedGameId {
            NearbySessions.shared.forget(gameId: gameId)
        }
        joinedGame = nil
        client = nil
        games = []
        peers = [:]
        phase = .idle
        if NearbySessions.shared.guest === self {
            NearbySessions.shared.guest = nil
        }
    }

    // The game being played over this session, connected or not — what the
    // board asks about to know whether it is looking at a peer game that is
    // currently out of touch.
    var joinedGameId: String? {
        switch phase {
        case let .joined(gameId), let .reconnecting(gameId):
            return gameId
        default:
            return nil
        }
    }

    var isConnected: Bool {
        if case .joined = phase { return true }
        return false
    }

    // MARK: - MCNearbyServiceBrowserDelegate

    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        guard let game = NearbyAdvert.decode(info) else { return }
        Task { @MainActor in
            peers[game.gameId] = peerID
            if !games.contains(game) {
                games.append(game)
            }
            // The game this guest was already in, on offer again: rejoining
            // it needs no decision from anyone, so it doesn't ask for one.
            if case let .reconnecting(gameId) = phase, gameId == game.gameId, let client {
                connect(to: game, using: client)
            }
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        Task { @MainActor in
            let lost = peers.filter { $0.value == peerID }.map(\.key)
            for gameId in lost {
                peers.removeValue(forKey: gameId)
            }
            games.removeAll { lost.contains($0.gameId) }
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        Task { @MainActor in
            phase = .failed(error.localizedDescription)
        }
    }
}

// Which games are currently being played over a link, so the board screen
// gets the right transport for one. A game id alone can't say: the host's
// copy of a shared game is a local game held on this device, and the guest's
// copy of the same id is a conversation with the host.
@Observable
final class NearbySessions {
    static let shared = NearbySessions()

    var host: NearbyHost?
    // Held here for the same reason as the host: the screen that started it
    // goes away, the connection shouldn't.
    var guest: NearbyGuest?
    private var guestTransports: [String: PeerTransport] = [:]

    func register(gameId: String, transport: PeerTransport) {
        guestTransports[gameId] = transport
    }

    func forget(gameId: String) {
        guestTransports.removeValue(forKey: gameId)
    }

    func transport(forGameId gameId: String) -> GameTransport? {
        guestTransports[gameId]
    }
}
