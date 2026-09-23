import Foundation

// The handful of types the rules are written in. Kept apart from
// GameState.swift, which models the server's JSON: the engine in
// Rules.swift and Scoring.swift depends on these four and nothing else, so
// it compiles — and is tested — without dragging the networking layer in.
// See scripts/check-swift-rules.sh.

// Named StoneColor, not Color — Color is SwiftUI's own type, used constantly
// for actual UI colors, so reusing the name here would shadow it everywhere
// in the module. Mirrors shared's Color ('black' | 'white').
enum StoneColor: String, Codable {
    case black
    case white
}

// Mirrors shared's Point.
struct Point: Codable, Equatable {
    let x: Int
    let y: Int
}

// Mirrors client/src/services/api.ts's Captures.
struct Captures: Codable {
    let black: Int
    let white: Int
}

typealias Board = [[StoneColor?]]
