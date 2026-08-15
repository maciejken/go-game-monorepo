import type { Board, Color, Point } from 'shared';

const API_BASE = '/api';

export interface GameResponse {
  id: string;
  size: number;
  handicap: number;
  title: string | null;
  status: string;
  board: Board;
}

export interface Captures {
  black: number;
  white: number;
}

export interface GameStateResponse extends GameResponse {
  currentColor: Color;
  result: string | null;
  captures: Captures;
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

export interface UndoResponse {
  board: Board;
  status: string;
  result: string | null;
  currentColor: Color;
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

export function createGame(size = 19, handicap = 0, title?: string): Promise<GameResponse> {
  return fetch(`${API_BASE}/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size, handicap, title }),
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
