import Foundation

// A port of shared/src/clock.ts, held to the same answers by
// shared/fixtures/rules.json. One generalized byoyomi model covers all three
// presets: "unlimited" has no time control at all, and "correspondence" is
// byoyomi with no main time and one very long period.

enum TimeControlName: String, Codable {
    case unlimited
    case standard
    case correspondence
}

struct TimeControlPreset: Equatable {
    let mainTimeSeconds: Int
    let byoyomiSeconds: Int
    let byoyomiPeriods: Int
}

let timeControlPresets: [TimeControlName: TimeControlPreset] = [
    .standard: TimeControlPreset(mainTimeSeconds: 600, byoyomiSeconds: 30, byoyomiPeriods: 5),
    .correspondence: TimeControlPreset(mainTimeSeconds: 0, byoyomiSeconds: 86_400, byoyomiPeriods: 1),
]

func resolveTimeControl(_ name: String?) -> TimeControlPreset? {
    guard let name, let resolved = TimeControlName(rawValue: name) else {
        return nil
    }
    return timeControlPresets[resolved]
}

struct ClockState: Equatable {
    var remainingMs: Int
    var periodsLeft: Int
}

// The most thinking time this player could still legitimately use before
// they are guaranteed to have lost — used both to detect a timeout and,
// since a move is only accepted once this holds, to guarantee deduct(_:)
// never has to reason about an already-expired clock.
func totalBudgetMs(_ state: ClockState, byoyomiSeconds: Int) -> Int {
    state.remainingMs + state.periodsLeft * byoyomiSeconds * 1000
}

func hasTimedOut(_ state: ClockState, byoyomiSeconds: Int, elapsedMs: Int) -> Bool {
    elapsedMs > totalBudgetMs(state, byoyomiSeconds: byoyomiSeconds)
}

// Main time is spent first; once it is gone, each byoyomi period that
// elapsed *in full* before the move landed is burned. Moving within a
// period costs nothing, which is what makes this byoyomi rather than a
// plain time bank.
func deductClock(_ state: ClockState, byoyomiSeconds: Int, elapsedMs: Int) -> ClockState {
    if elapsedMs <= state.remainingMs {
        return ClockState(remainingMs: state.remainingMs - elapsedMs, periodsLeft: state.periodsLeft)
    }

    let overflowMs = elapsedMs - state.remainingMs
    let periodsConsumed = overflowMs / (byoyomiSeconds * 1000)
    return ClockState(remainingMs: 0, periodsLeft: state.periodsLeft - periodsConsumed)
}
