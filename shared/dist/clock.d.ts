export type TimeControlName = 'unlimited' | 'standard' | 'correspondence';
export interface TimeControlPreset {
    mainTimeSeconds: number;
    byoyomiSeconds: number;
    byoyomiPeriods: number;
}
export declare const TIME_CONTROL_PRESETS: Record<Exclude<TimeControlName, 'unlimited'>, TimeControlPreset>;
export declare function resolveTimeControl(name: unknown): TimeControlPreset | null;
export interface ClockState {
    remainingMs: number;
    periodsLeft: number;
}
export declare function totalBudgetMs(state: ClockState, byoyomiSeconds: number): number;
export declare function hasTimedOut(state: ClockState, byoyomiSeconds: number, elapsedMs: number): boolean;
export declare function deductClock(state: ClockState, byoyomiSeconds: number, elapsedMs: number): ClockState;
