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
    // Whether *you* block this person. Never the other way round: a block
    // is meant to be invisible to whoever it is aimed at, so the server
    // will not answer that question.
    let blocked: Bool
}

// What the server this app is talking to can do. Asked once at launch,
// alongside who is signed in — a server either plays GNU Go games or it
// doesn't, and that doesn't change while it is running.
struct ServerFeatures: Codable {
    // Defaults to true for a server old enough not to say: that is how
    // every server behaved before there was anything to ask.
    var gnugo = true
}
