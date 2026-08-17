import type { StoredTimeControl } from '../services/api';

export const TIME_CONTROL_LABELS: Record<Exclude<StoredTimeControl, null>, string> = {
  standard: '10 min + byoyomi',
  correspondence: '24h per move',
};

export function timeControlLabel(timeControl: StoredTimeControl): string {
  return timeControl ? TIME_CONTROL_LABELS[timeControl] : 'Unlimited';
}

// mm:ss under an hour, h:mm:ss at/above an hour — a byoyomi period display
// (a handful of seconds to a couple minutes) never needs the hour digit, a
// correspondence display (hours) always does.
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export interface LiveClockDisplay {
  mainMs: number;
  inByoyomi: boolean;
  periodMs: number;
  periodsLeft: number;
}

// Client-side interpolation of a clock's current reading between server
// syncs — mirrors server/src/clock.ts's deductClock/hasTimedOut math for
// display purposes, but the server call it makes when a move actually lands
// remains the authority; this is only ever a preview.
export function computeLiveClock(
  isTicking: boolean,
  storedRemainingMs: number,
  storedPeriodsLeft: number,
  byoyomiSeconds: number,
  turnStartedAt: number | null,
  nowMs: number,
): LiveClockDisplay {
  const byoyomiMs = byoyomiSeconds * 1000;

  if (!isTicking || turnStartedAt === null) {
    return {
      mainMs: storedRemainingMs,
      inByoyomi: storedRemainingMs <= 0,
      periodMs: byoyomiMs,
      periodsLeft: storedPeriodsLeft,
    };
  }

  const elapsedMs = Math.max(0, nowMs - turnStartedAt);
  if (elapsedMs <= storedRemainingMs) {
    return { mainMs: storedRemainingMs - elapsedMs, inByoyomi: false, periodMs: byoyomiMs, periodsLeft: storedPeriodsLeft };
  }

  const overflowMs = elapsedMs - storedRemainingMs;
  const periodsConsumed = Math.floor(overflowMs / byoyomiMs);
  const currentPeriodElapsed = overflowMs % byoyomiMs;
  return {
    mainMs: 0,
    inByoyomi: true,
    periodMs: Math.max(0, byoyomiMs - currentPeriodElapsed),
    periodsLeft: Math.max(0, storedPeriodsLeft - periodsConsumed),
  };
}
