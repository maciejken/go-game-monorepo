import type { Board, Captures, Color, Point } from 'shared';

export type { Captures };

const API_BASE = '/api';

export type MyColor = Color | 'both' | null;

// Mirrors server/src/clock.ts: null on a stored game means "unlimited" (no
// time control at all); on a create request, 'unlimited' is the explicit
// choice that produces that null.
export type TimeControlName = 'unlimited' | 'standard' | 'correspondence';
export type StoredTimeControl = Exclude<TimeControlName, 'unlimited'> | null;

export interface ClockFields {
  timeControl: StoredTimeControl;
  mainTimeSeconds: number | null;
  byoyomiSeconds: number | null;
  byoyomiPeriods: number | null;
  blackTimeRemainingMs: number | null;
  whiteTimeRemainingMs: number | null;
  blackPeriodsLeft: number | null;
  whitePeriodsLeft: number | null;
  turnStartedAt: number | null;
}

export interface AuthUser {
  id: string;
  username: string;
}

export interface GameResponse {
  id: string;
  size: number;
  handicap: number;
  title: string | null;
  status: string;
  board: Board;
  blackUsername: string | null;
  whiteUsername: string | null;
}

// How a finished game ended — only a 'scoring' finish can be reopened via
// redo-scoring; resignations and timeouts have nothing to rescore.
export type EndReason = 'scoring' | 'resign' | 'timeout' | 'ended' | null;

// Describable record of the most recent event (move/pass/resign), for
// narrating live play to screen readers. Shares its shape with HistoryEntry
// so both can be passed to the same describeEntry() helper.
export interface LastEvent {
  eventType: string;
  color: Color | null;
  point: Point | null;
  capturedPoints: Point[];
}

export interface GameStateResponse extends GameResponse, ClockFields {
  currentColor: Color;
  komi: number;
  result: string | null;
  captures: Captures;
  myColor: MyColor;
  pendingUndoBy: Color | null;
  endReason: EndReason;
  pendingReopenBy: Color | null;
  isAiOpponent: boolean;
  lastMove: Point | null;
  lastEvent: LastEvent | null;
  canUndo: boolean;
  shortResult: string | null;
  resultBreakdown: { black: number; white: number } | null;
}

export interface GameSummary {
  id: string;
  size: number;
  handicap: number;
  komi: number;
  title: string | null;
  status: string;
  result: string | null;
  createdAt: number;
  updatedAt: number;
  blackUsername: string | null;
  whiteUsername: string | null;
  myColor: MyColor;
  isAiOpponent: boolean;
  timeControl: StoredTimeControl;
  starred: boolean;
}

export interface MoveResponse {
  board: Board;
  moveNumber: number;
  capturedPoints: Point[];
  nextColor: Color;
  captures: Captures;
}

export interface PassResponse {
  status: string;
  result: string | null;
  nextColor: Color;
}

export interface ResignResponse {
  status: string;
  result: string | null;
}

export interface EndGameResponse {
  status: string;
  result: null;
}

// A local game (one account playing both colors) always undoes immediately
// ('confirmed'). A remote game negotiates: the first call from either
// player 'requested's it, and only the other player's call can 'confirmed'
// it — calling again as the original requester 'cancelled's it instead.
export type UndoResponse =
  | { action: 'requested'; pendingUndoBy: Color }
  | { action: 'cancelled'; pendingUndoBy: null }
  | {
      action: 'confirmed';
      pendingUndoBy: null;
      board: Board;
      status: string;
      result: string | null;
      currentColor: Color;
      captures: Captures;
    };

export interface FinalizeScoringResponse {
  status: string;
  result: string | null;
  captures: Captures;
}

// Same request/confirm negotiation shape as UndoResponse, for reopening a
// scoring-finished game so dead stones can be re-marked.
export type ReopenScoringResponse =
  | { action: 'requested'; pendingReopenBy: Color }
  | { action: 'cancelled'; pendingReopenBy: null }
  | { action: 'confirmed'; pendingReopenBy: null; status: string; result: null };

export interface HistoryEntry {
  moveNumber: number;
  board: Board;
  eventType: string;
  color: Color | null;
  point: Point | null;
  capturedPoints: Point[];
}

export interface GameHistoryResponse {
  size: number;
  moves: HistoryEntry[];
}

// Carries the HTTP status alongside the server's error message, so callers
// can distinguish e.g. a 404 (the resource doesn't exist) from other
// failures without string-matching the message.
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.error ?? 'Request failed', res.status);
  }
  return data as T;
}

export type GameListScope = 'mine' | 'all';

export function listGames(scope: GameListScope = 'mine'): Promise<GameSummary[]> {
  return fetch(`${API_BASE}/games?scope=${scope}`).then((res) => handle<GameSummary[]>(res));
}

export function starGame(id: string): Promise<{ starred: true }> {
  return fetch(`${API_BASE}/games/${id}/star`, { method: 'POST' }).then((res) =>
    handle<{ starred: true }>(res),
  );
}

export function unstarGame(id: string): Promise<{ starred: false }> {
  return fetch(`${API_BASE}/games/${id}/star`, { method: 'DELETE' }).then((res) =>
    handle<{ starred: false }>(res),
  );
}

export async function deleteGame(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/games/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? 'Failed to delete game');
  }
}

export interface CreateGameOptions {
  size?: number;
  handicap?: number;
  komi?: number;
  title?: string;
  mode?: 'local' | 'remote' | 'gnugo';
  timeControl?: TimeControlName;
  color?: Color | 'random';
  opponentUsername?: string;
  level?: number;
}

export function createGame(options: CreateGameOptions = {}): Promise<GameResponse> {
  return fetch(`${API_BASE}/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: 19, handicap: 0, ...options }),
  }).then((res) => handle<GameResponse>(res));
}

export function getGame(id: string): Promise<GameStateResponse> {
  return fetch(`${API_BASE}/games/${id}`).then((res) => handle<GameStateResponse>(res));
}

export function updateGameTitle(id: string, title: string): Promise<{ title: string | null }> {
  return fetch(`${API_BASE}/games/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((res) => handle<{ title: string | null }>(res));
}

export function getGameHistory(id: string): Promise<GameHistoryResponse> {
  return fetch(`${API_BASE}/games/${id}/history`).then((res) => handle<GameHistoryResponse>(res));
}

// A plain GET the browser downloads directly (the server sets
// Content-Disposition: attachment) — no auth required, so this works for
// spectators too.
export function sgfExportUrl(id: string): string {
  return `${API_BASE}/games/${id}/sgf`;
}

export function makeMove(id: string, x: number, y: number, color: Color): Promise<MoveResponse> {
  return fetch(`${API_BASE}/games/${id}/moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, color }),
  }).then((res) => handle<MoveResponse>(res));
}

export function passTurn(id: string, color: Color): Promise<PassResponse> {
  return fetch(`${API_BASE}/games/${id}/pass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color }),
  }).then((res) => handle<PassResponse>(res));
}

export function resignGame(id: string, color: Color): Promise<ResignResponse> {
  return fetch(`${API_BASE}/games/${id}/resign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color }),
  }).then((res) => handle<ResignResponse>(res));
}

export function endGame(id: string): Promise<EndGameResponse> {
  return fetch(`${API_BASE}/games/${id}/end`, { method: 'POST' }).then((res) => handle<EndGameResponse>(res));
}

export function undoMove(id: string): Promise<UndoResponse> {
  return fetch(`${API_BASE}/games/${id}/undo`, { method: 'POST' }).then((res) => handle<UndoResponse>(res));
}

export function reopenScoring(id: string): Promise<ReopenScoringResponse> {
  return fetch(`${API_BASE}/games/${id}/reopen-scoring`, { method: 'POST' }).then((res) =>
    handle<ReopenScoringResponse>(res),
  );
}

export function finalizeScoring(id: string, deadPoints: Point[]): Promise<FinalizeScoringResponse> {
  return fetch(`${API_BASE}/games/${id}/finalize-scoring`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deadPoints }),
  }).then((res) => handle<FinalizeScoringResponse>(res));
}

export function register(username: string, password: string): Promise<AuthUser> {
  return fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((res) => handle<AuthUser>(res));
}

export function login(username: string, password: string): Promise<AuthUser> {
  return fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((res) => handle<AuthUser>(res));
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
}

export function getMe(): Promise<AuthUser | null> {
  return fetch(`${API_BASE}/auth/me`)
    .then((res) => handle<{ user: AuthUser | null }>(res))
    .then((data) => data.user);
}
