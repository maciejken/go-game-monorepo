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

// What the server this app is talking to can do. Asked once at launch,
// alongside who is signed in — a server either plays GNU Go games or it
// doesn't, and that doesn't change while it is running.
struct ServerFeatures: Codable {
    // Defaults to true for a server old enough not to say: that is how
    // every server behaved before there was anything to ask.
    var gnugo = true
}
