import Foundation

// Direct port of client/src/utils/clock.ts — kept in lockstep with it
// deliberately (same field names, same formulas) rather than reinvented,
// since it's a pure, dependency-free function on that side too.

struct LiveClockDisplay {
    let mainMs: Double
    let inByoyomi: Bool
    let periodMs: Double
    let periodsLeft: Int
}

// mm:ss under an hour, h:mm:ss at/above an hour.
func formatClock(_ ms: Double) -> String {
    let totalSeconds = max(0, Int(ceil(ms / 1000)))
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    let seconds = totalSeconds % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
        : String(format: "%02d:%02d", minutes, seconds)
}

// Client-side interpolation of a clock's current reading between server
// syncs — this is only ever a preview; the server is still the authority
// when a move actually lands.
func computeLiveClock(
    isTicking: Bool,
    storedRemainingMs: Double,
    storedPeriodsLeft: Int,
    byoyomiSeconds: Double,
    turnStartedAt: Double?,
    nowMs: Double
) -> LiveClockDisplay {
    let byoyomiMs = byoyomiSeconds * 1000

    guard isTicking, let turnStartedAt else {
        return LiveClockDisplay(
            mainMs: storedRemainingMs,
            inByoyomi: storedRemainingMs <= 0,
            periodMs: byoyomiMs,
            periodsLeft: storedPeriodsLeft
        )
    }

    let elapsedMs = max(0, nowMs - turnStartedAt)
    if elapsedMs <= storedRemainingMs {
        return LiveClockDisplay(
            mainMs: storedRemainingMs - elapsedMs,
            inByoyomi: false,
            periodMs: byoyomiMs,
            periodsLeft: storedPeriodsLeft
        )
    }

    let overflowMs = elapsedMs - storedRemainingMs
    let periodsConsumed = Int(floor(overflowMs / byoyomiMs))
    if periodsConsumed >= storedPeriodsLeft {
        // All periods used up (matches server/src/clock.ts's hasTimedOut
        // budget) — freeze at 0 instead of cycling through phantom periods
        // until the server actually flags the timeout.
        return LiveClockDisplay(mainMs: 0, inByoyomi: true, periodMs: 0, periodsLeft: 0)
    }
    let currentPeriodElapsed = overflowMs.truncatingRemainder(dividingBy: byoyomiMs)
    return LiveClockDisplay(
        mainMs: 0,
        inByoyomi: true,
        periodMs: byoyomiMs - currentPeriodElapsed,
        periodsLeft: storedPeriodsLeft - periodsConsumed
    )
}
