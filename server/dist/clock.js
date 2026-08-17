export const TIME_CONTROL_PRESETS = {
    standard: { mainTimeSeconds: 600, byoyomiSeconds: 30, byoyomiPeriods: 5 },
    correspondence: { mainTimeSeconds: 0, byoyomiSeconds: 86400, byoyomiPeriods: 1 },
};
export function resolveTimeControl(name) {
    if (name === 'standard' || name === 'correspondence') {
        return TIME_CONTROL_PRESETS[name];
    }
    return null; // 'unlimited', missing, or anything unrecognized
}
// The most thinking time this player could still legitimately use before
// they're guaranteed to have lost on time — used both to detect a timeout
// and, since a move is only ever accepted once this holds, to guarantee
// deductClock below never has to reason about an already-expired clock.
export function totalBudgetMs(state, byoyomiSeconds) {
    return state.remainingMs + state.periodsLeft * byoyomiSeconds * 1000;
}
export function hasTimedOut(state, byoyomiSeconds, elapsedMs) {
    return elapsedMs > totalBudgetMs(state, byoyomiSeconds);
}
// Applies one move's thinking time to a player's clock. Only ever called
// after hasTimedOut has confirmed elapsedMs fits the budget, so this never
// needs to represent "ran out mid-move" — periodsLeft here can only reach
// as low as 0, never negative.
//
// Main time is spent first; once exhausted, each full byoyomi period that
// elapsed before the move landed is burned (periodsLeft decreases). Moving
// within a period costs nothing — periodsLeft only drops for a period spent
// in full, matching standard byoyomi rather than a simple time bank.
export function deductClock(state, byoyomiSeconds, elapsedMs) {
    if (elapsedMs <= state.remainingMs) {
        return { remainingMs: state.remainingMs - elapsedMs, periodsLeft: state.periodsLeft };
    }
    const overflowMs = elapsedMs - state.remainingMs;
    const periodsConsumed = Math.floor(overflowMs / (byoyomiSeconds * 1000));
    return { remainingMs: 0, periodsLeft: state.periodsLeft - periodsConsumed };
}
