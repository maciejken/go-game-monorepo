import Foundation

// Talks to the same REST API the web client uses (client/src/services/api.ts).
// Auth is cookie-based, same as the browser — URLSession.shared's default
// configuration uses the shared HTTPCookieStorage, which stores and resends
// the go_session cookie automatically (including across app relaunches,
// since it persists to disk), so there's no manual token handling here.
enum APIClient {
    private struct ErrorResponse: Decodable {
        let error: String
    }

    private static func url(_ path: String) -> URL {
        URL(string: "\(Config.baseURL.absoluteString)/\(path)")!
    }

    private static func send(_ request: URLRequest) async throws {
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkStatus(data: data, response: response)
    }

    private static func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
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
