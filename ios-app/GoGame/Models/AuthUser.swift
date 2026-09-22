import Foundation

// Mirrors client/src/services/api.ts's AuthUser.
struct AuthUser: Codable, Identifiable {
    let id: String
    let username: String
    // Which of this user's own tags marks a favourite, or nil while they
    // haven't chosen one.
    let favouriteTag: String?
}

// Mirrors client/src/services/api.ts's UserProfile — any user's public
// info by id, backing the profile page/Account tab.
struct UserProfile: Codable, Identifiable {
    let id: String
    let username: String
    let createdAt: Int
    let acceptsInvitations: Bool
    // Only ever set on your own profile.
    let favouriteTag: String?
    let gamesPlayed: Int
    let gamesWon: Int
    let gamesLost: Int
}
