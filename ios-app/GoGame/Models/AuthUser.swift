import Foundation

// Mirrors client/src/services/api.ts's AuthUser.
struct AuthUser: Codable, Identifiable {
    let id: String
    let username: String
}

// Mirrors client/src/services/api.ts's UserProfile — any user's public
// info by id, backing the profile page/Account tab.
struct UserProfile: Codable, Identifiable {
    let id: String
    let username: String
    let createdAt: Int
    let acceptsInvitations: Bool
    let gamesPlayed: Int
    let gamesWon: Int
    let gamesLost: Int
}
