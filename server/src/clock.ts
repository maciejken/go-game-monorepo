// A single generalized byoyomi model covers all three presets uniformly:
// "unlimited" simply has no time control at all, and "correspondence" is
// just byoyomi with a 0-second main time bank and one very long period —
// neither needs special-casing anywhere else in this module.
export type TimeControlName = 'unlimited' | 'standard' | 'correspondence';

export interface TimeControlPreset {
  mainTimeSeconds: number;
  byoyomiSeconds: number;
  byoyomiPeriods: number;
}

export const TIME_CONTROL_PRESETS: Record<Exclude<TimeControlName, 'unlimited'>, TimeControlPreset> = {
  standard: { mainTimeSeconds: 600, byoyomiSeconds: 30, byoyomiPeriods: 5 },
  correspondence: { mainTimeSeconds: 0, byoyomiSeconds: 86400, byoyomiPeriods: 1 },
};

export function resolveTimeControl(name: unknown): TimeControlPreset | null {
  if (name === 'standard' || name === 'correspondence') {
    return TIME_CONTROL_PRESETS[name];
  }
  return null; // 'unlimited', missing, or anything unrecognized
}

export interface ClockState {
  remainingMs: number;
  periodsLeft: number;
}

// The most thinking time this player could still legitimately use before
// they're guaranteed to have lost on time — used both to detect a timeout
// and, since a move is only ever accepted once this holds, to guarantee
// deductClock below never has to reason about an already-expired clock.
export function totalBudgetMs(state: ClockState, byoyomiSeconds: number): number {
  return state.remainingMs + state.periodsLeft * byoyomiSeconds * 1000;
}

export function hasTimedOut(state: ClockState, byoyomiSeconds: number, elapsedMs: number): boolean {
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
export function deductClock(state: ClockState, byoyomiSeconds: number, elapsedMs: number): ClockState {
  if (elapsedMs <= state.remainingMs) {
    return { remainingMs: state.remainingMs - elapsedMs, periodsLeft: state.periodsLeft };
  }

  const overflowMs = elapsedMs - state.remainingMs;
  const periodsConsumed = Math.floor(overflowMs / (byoyomiSeconds * 1000));
  return { remainingMs: 0, periodsLeft: state.periodsLeft - periodsConsumed };
}
