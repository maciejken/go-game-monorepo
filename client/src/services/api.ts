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

export interface GameStateResponse extends GameResponse, ClockFields {
  currentColor: Color;
  result: string | null;
  captures: Captures;
  myColor: MyColor;
  pendingUndoBy: Color | null;
  isAiOpponent: boolean;
}

export interface GameSummary {
  id: string;
  size: number;
  handicap: number;
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

async function handle<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? 'Request failed');
  }
  return data as T;
}

export function listGames(): Promise<GameSummary[]> {
  return fetch(`${API_BASE}/games`).then((res) => handle<GameSummary[]>(res));
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
  title?: string;
  mode?: 'local' | 'remote' | 'gnugo';
  timeControl?: TimeControlName;
  opponentUsername?: string;
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

export function undoMove(id: string): Promise<UndoResponse> {
  return fetch(`${API_BASE}/games/${id}/undo`, { method: 'POST' }).then((res) => handle<UndoResponse>(res));
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
