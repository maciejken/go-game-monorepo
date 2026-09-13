import Foundation

// Talks to the same REST API the web client uses (client/src/services/api.ts).
// Auth is cookie-based, same as the browser — the session below uses the
// shared HTTPCookieStorage, which stores and resends the go_session cookie
// automatically (including across app relaunches, since it persists to
// disk), so there's no manual token handling here.
enum APIClient {
    private struct ErrorResponse: Decodable {
        let error: String
    }

    // .default (like .shared) uses HTTPCookieStorage.shared, so cookie
    // behavior is unchanged — this exists only to shorten the timeout.
    // .shared's default 60s per-request timeout meant a single hung/slow
    // request (e.g. right at a notification-triggered cold launch, when
    // the device's radio may still be waking up) could leave a screen
    // spinning for a very long time before ever failing.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config)
    }()

    private static func url(_ path: String) -> URL {
        URL(string: "\(Config.baseURL.absoluteString)/\(path)")!
    }

    // Retries once after a short pause on a thrown error — covers a
    // transient hiccup right after resuming from background (the device's
    // radio may still be waking up, made more likely to actually bite by
    // this session's shorter-than-default 15s timeout above) without
    // surfacing a user-visible failure for what usually resolves itself a
    // couple of seconds later. Shared by every call site that would
    // otherwise flash an error alert/log a user out for a momentary blip.
    static func withRetry<T>(_ operation: () async throws -> T) async throws -> T {
        do {
            return try await operation()
        } catch {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            return try await operation()
        }
    }

    private static func send(_ request: URLRequest) async throws {
        let (data, response) = try await session.data(for: request)
        try checkStatus(data: data, response: response)
    }

    private static func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await session.data(for: request)
        try checkStatus(data: data, response: response)
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private static func checkStatus(data: Data, response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "Invalid response", status: 0)
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error ?? "Request failed"
            throw APIError(message: message, status: http.statusCode)
        }
    }

    private static func get<Response: Decodable>(_ path: String) async throws -> Response {
        try await send(URLRequest(url: url(path)))
    }

    // For the one endpoint that responds with plain text rather than JSON
    // (the SGF export) — reuses checkStatus for the same error handling,
    // decoding the success body as UTF-8 text instead of JSON.
    private static func getText(_ path: String) async throws -> String {
        let (data, response) = try await session.data(for: URLRequest(url: url(path)))
        try checkStatus(data: data, response: response)
        guard let text = String(data: data, encoding: .utf8) else {
            throw APIError(message: "Invalid response", status: 0)
        }
        return text
    }

    private static func post(_ path: String) async throws {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        try await send(request)
    }

    private static func post<Response: Decodable>(_ path: String) async throws -> Response {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        return try await send(request)
    }

    private static func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body) async throws -> Response {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await send(request)
    }

    private static func post<Body: Encodable>(_ path: String, body: Body) async throws {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        try await send(request)
    }

    private static func patch<Body: Encodable>(_ path: String, body: Body) async throws {
        var request = URLRequest(url: url(path))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        try await send(request)
    }

    private static func delete(_ path: String) async throws {
        var request = URLRequest(url: url(path))
        request.httpMethod = "DELETE"
        try await send(request)
    }

    static func register(username: String, password: String) async throws -> AuthUser {
        struct Body: Encodable { let username: String; let password: String }
        return try await post("api/auth/register", body: Body(username: username, password: password))
    }

    static func login(username: String, password: String) async throws -> AuthUser {
        struct Body: Encodable { let username: String; let password: String }
        return try await post("api/auth/login", body: Body(username: username, password: password))
    }

    static func logout() async throws {
        try await post("api/auth/logout")
    }

    static func me() async throws -> AuthUser? {
        struct MeResponse: Decodable { let user: AuthUser? }
        let response: MeResponse = try await get("api/auth/me")
        return response.user
    }

    static func changePassword(currentPassword: String, newPassword: String) async throws {
        struct Body: Encodable { let currentPassword: String; let newPassword: String }
        try await post("api/auth/password", body: Body(currentPassword: currentPassword, newPassword: newPassword))
    }

    static func setAcceptsInvitations(_ acceptsInvitations: Bool) async throws {
        struct Body: Encodable { let acceptsInvitations: Bool }
        try await patch("api/auth/me", body: Body(acceptsInvitations: acceptsInvitations))
    }

    // Any logged-in user's public info by id, not just the caller's own —
    // backs the profile page/Account tab.
    static func getUser(id: String) async throws -> UserProfile {
        try await get("api/users/\(id)")
    }

    // Mirrors client/src/services/api.ts's listGames: the server includes
    // one extra row beyond `limit` when there's more to load, which this
    // trims off into a plain `hasMore` so the caller never has to think
    // about the trick.
    struct GameListPage {
        let games: [GameSummary]
        let hasMore: Bool
    }

    static func games(scope: String = "mine", limit: Int, offset: Int) async throws -> GameListPage {
        let rows: [GameSummary] = try await get("api/games?scope=\(scope)&limit=\(limit)&offset=\(offset)")
        if rows.count > limit {
            return GameListPage(games: Array(rows.prefix(limit)), hasMore: true)
        }
        return GameListPage(games: rows, hasMore: false)
    }

    static func getGame(id: String) async throws -> GameState {
        try await get("api/games/\(id)")
    }

    // Backs review mode — the full move-by-move record, fetched once a
    // finished game is loaded.
    static func getGameHistory(id: String) async throws -> GameHistoryResponse {
        try await get("api/games/\(id)/history")
    }

    static func getSgf(id: String) async throws -> String {
        try await getText("api/games/\(id)/sgf")
    }

    // Mirrors client/src/pages/Home.tsx's createGame call. `color`,
    // `opponentUsername`, and `level` are only meaningful for "remote"/
    // "gnugo" modes; Swift's synthesized Encodable calls encodeIfPresent
    // for Optional properties, so passing nil here omits the key from the
    // JSON entirely rather than sending `null` — matching Home.tsx's
    // conditional object-spread.
    static func createGame(
        size: Int,
        handicap: Int,
        komi: Double,
        title: String?,
        mode: String,
        timeControl: String,
        color: String?,
        opponentUsername: String?,
        level: Int?
    ) async throws -> String {
        struct Body: Encodable {
            let size: Int
            let handicap: Int
            let komi: Double
            let title: String?
            let mode: String
            let timeControl: String
            let color: String?
            let opponentUsername: String?
            let level: Int?
        }
        struct CreatedGame: Decodable { let id: String }
        let created: CreatedGame = try await post(
            "api/games",
            body: Body(
                size: size, handicap: handicap, komi: komi, title: title,
                mode: mode, timeControl: timeControl,
                color: color, opponentUsername: opponentUsername, level: level
            )
        )
        return created.id
    }

    // Backs the new-game form's handicap/level auto-fill. Mirrors
    // client/src/services/api.ts's recentGameVs — null means no prior game
    // exists against this opponent (or the computer), not an error.
    struct RecentGameVsOpponent: Decodable {
        let handicap: Int
        let gnugoLevel: Int?
    }

    static func recentGameVs(username: String) async throws -> RecentGameVsOpponent? {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? username
        return try await get("api/games/recent-vs?opponentUsername=\(encoded)")
    }

    static func recentGameVsAI() async throws -> RecentGameVsOpponent? {
        try await get("api/games/recent-vs?ai=1")
    }

    // Backs the new-game form's opponent autocomplete. Mirrors
    // client/src/services/api.ts's searchUsernames — the server returns []
    // for a query under its own minimum length rather than erroring.
    struct UsernameSearchResult: Decodable {
        let username: String
        let isAi: Bool
    }

    static func searchUsernames(query: String) async throws -> [UsernameSearchResult] {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return try await get("api/users/search?q=\(encoded)")
    }

    static func makeMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> MoveResponse {
        struct Body: Encodable { let x: Int; let y: Int; let color: StoneColor }
        return try await post("api/games/\(gameId)/moves", body: Body(x: x, y: y, color: color))
    }

    // Dry-run of the same check makeMove applies (including superko, which
    // needs the full position history and so can't be replicated purely
    // client-side) — mirrors client/src/services/api.ts's
    // validateMoveRequest, used by the "confirm moves" feature.
    static func validateMove(gameId: String, x: Int, y: Int, color: StoneColor) async throws -> ValidateMoveResponse {
        struct Body: Encodable { let x: Int; let y: Int; let color: StoneColor }
        return try await post("api/games/\(gameId)/moves/validate", body: Body(x: x, y: y, color: color))
    }

    static func pass(gameId: String, color: StoneColor) async throws -> PassResponse {
        struct Body: Encodable { let color: StoneColor }
        return try await post("api/games/\(gameId)/pass", body: Body(color: color))
    }

    static func resign(gameId: String, color: StoneColor) async throws -> ResignResponse {
        struct Body: Encodable { let color: StoneColor }
        return try await post("api/games/\(gameId)/resign", body: Body(color: color))
    }

    static func finalizeScoring(gameId: String, deadPoints: [Point], sekiPoints: [Point] = []) async throws -> FinalizeScoringResponse {
        struct Body: Encodable { let deadPoints: [Point]; let sekiPoints: [Point] }
        return try await post("api/games/\(gameId)/finalize-scoring", body: Body(deadPoints: deadPoints, sekiPoints: sekiPoints))
    }

    // Mirrors client/src/services/api.ts's reopenScoring — immediate for a
    // local/AI game, request-then-confirm negotiation between two players.
    static func reopenScoring(gameId: String) async throws -> ReopenScoringResponse {
        try await post("api/games/\(gameId)/reopen-scoring")
    }

    static func deleteGame(gameId: String) async throws {
        try await delete("api/games/\(gameId)")
    }

    // Accepting just clears the pending flag server-side (the game already
    // plays normally either way); rejecting deletes the game outright and
    // notifies the inviter.
    static func respondToInvite(gameId: String, accept: Bool) async throws {
        struct Body: Encodable { let accept: Bool }
        try await post("api/games/\(gameId)/respond-invite", body: Body(accept: accept))
    }

    // Registers this device's APNs token so the server's
    // notifyOpponentOfMove (server/src/server.ts) knows where to push. Only
    // meaningful once the server itself has real APNs credentials
    // configured (server/src/apns.ts's isApnsConfigured) — until then this
    // still succeeds and stores the token, it just won't trigger a real push.
    static func registerDeviceToken(_ token: String) async throws {
        struct Body: Encodable { let token: String }
        try await post("api/device-tokens", body: Body(token: token))
    }
}
