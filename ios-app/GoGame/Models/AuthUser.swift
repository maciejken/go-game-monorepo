import Foundation

// Mirrors client/src/services/api.ts's AuthUser.
struct AuthUser: Codable, Identifiable {
    let id: String
    let username: String
}
