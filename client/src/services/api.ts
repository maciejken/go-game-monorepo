import type { Board, Captures, Color, Point } from 'shared';
import { t } from '../i18n';

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

export interface UserProfile {
  id: string;
  username: string;
  createdAt: number;
  acceptsInvitations: boolean;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
}

export interface GameResponse {
  id: string;
  size: number;
  handicap: number;
  title: string | null;
  tags: string[];
  // The subset of `tags` that is on the game for both players; the rest
  // are the viewer's own. Optional for a server that predates it.
  publicTags?: string[];
  starred: boolean;
  status: string;
  board: Board;
  blackUsername: string | null;
  whiteUsername: string | null;
  blackUserId: string | null;
  whiteUserId: string | null;
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
  createdAt: number;
  result: string | null;
  captures: Captures;
  myColor: MyColor;
  pendingUndoBy: Color | null;
  endReason: EndReason;
  pendingReopenBy: Color | null;
  isAiOpponent: boolean;
  gnugoLevel: number | null;
  aiCurrentLevel: number | null;
  // GNU Go ran out of time on this position and the server stopped
  // waiting. Optional: a server that predates the field simply never
  // says so, and a stalled game looks like a thinking one, as before.
  aiStalled?: boolean;
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
  tags: string[];
  publicTags?: string[];
  status: string;
  result: string | null;
  shortResult: string | null;
  createdAt: number;
  updatedAt: number;
  blackUsername: string | null;
  whiteUsername: string | null;
  blackUserId: string | null;
  whiteUserId: string | null;
  myColor: MyColor;
  isAiOpponent: boolean;
  gnugoLevel: number | null;
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
    // The server sends the English sentence plus the key it was built
    // from (see fail() in server.ts), so the translation happens here,
    // once, and every caller that shows err.message gets it. An
    // untranslated key falls back to the English the server already sent.
    const message =
      typeof data.errorKey === 'string'
        ? t(data.errorKey as Parameters<typeof t>[0], ...((data.errorParams as string[]) ?? []))
        : (data.error ?? 'Request failed');
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export type GameListScope = 'mine' | 'starred';

export interface GameListPage {
  games: GameSummary[];
  hasMore: boolean;
}

// Pagination is optional: pass no options for the old "everything at once"
// behavior, or { limit, offset } for one page — the server includes one
// extra row beyond `limit` when there's more, which this trims off and
// turns into `hasMore` so the caller never has to think about the trick.
export async function listGames(
  scope: GameListScope = 'mine',
  options?: { limit?: number; offset?: number; q?: string },
): Promise<GameListPage> {
  const params = new URLSearchParams({ scope });
  if (options?.q) {
    params.set('q', options.q);
  }
  if (options?.limit != null) {
    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset ?? 0));
  }
  const rows = await fetch(`${API_BASE}/games?${params}`).then((res) => handle<GameSummary[]>(res));
  if (options?.limit != null && rows.length > options.limit) {
    return { games: rows.slice(0, options.limit), hasMore: true };
  }
  return { games: rows, hasMore: false };
}

export interface RecentGameVsOpponent {
  handicap: number;
  gnugoLevel: number | null;
}

// Backs the new-game form's handicap/level auto-fill — the most recent
// past game against this opponent (a human by username, or the computer
// via `ai: true`), or null if there isn't one.
export function recentGameVs(
  opponent: { username: string } | { ai: true },
): Promise<RecentGameVsOpponent | null> {
  const params =
    'ai' in opponent ? new URLSearchParams({ ai: '1' }) : new URLSearchParams({ opponentUsername: opponent.username });
  return fetch(`${API_BASE}/games/recent-vs?${params}`).then((res) => handle<RecentGameVsOpponent | null>(res));
}

export interface UsernameSearchResult {
  username: string;
  isAi: boolean;
}

// Backs the new-game form's opponent autocomplete. The server returns []
// for a query under its own minimum length rather than erroring.
export function searchUsernames(query: string): Promise<UsernameSearchResult[]> {
  return fetch(`${API_BASE}/users/search?q=${encodeURIComponent(query)}`).then((res) =>
    handle<UsernameSearchResult[]>(res),
  );
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

// Both tag routes answer with the game's whole tag list, so the caller
// replaces its copy rather than patching it.
// isPublic is the difference between Share and Add: a public tag is
// visible to anyone who can see the game, a personal one only to whoever
// added it.
export function addGameTag(
  id: string,
  tag: string,
  isPublic: boolean,
): Promise<{ tags: string[]; publicTags?: string[] }> {
  return fetch(`${API_BASE}/games/${id}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, isPublic }),
  }).then((res) => handle<{ tags: string[]; publicTags?: string[] }>(res));
}

export interface TagSuggestion {
  tag: string;
  isPublic: boolean;
  count: number;
}

// Every tag this user has used before, most-used first.
export function listTagSuggestions(): Promise<{ tags: TagSuggestion[] }> {
  return fetch(`${API_BASE}/tags`).then((res) => handle<{ tags: TagSuggestion[] }>(res));
}

export function removeGameTag(id: string, tag: string): Promise<{ tags: string[]; publicTags?: string[] }> {
  return fetch(`${API_BASE}/games/${id}/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
  }).then((res) => handle<{ tags: string[]; publicTags?: string[] }>(res));
}

// Asks the server to have GNU Go think again about the move it owes —
// the escape hatch for a request that died mid-thought (see the same
// endpoint's use from the iOS app).
export function recomputeAiMove(id: string): Promise<void> {
  return fetch(`${API_BASE}/games/${id}/recompute-ai-move`, { method: 'POST' }).then((res) =>
    handle<void>(res),
  );
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

export interface ValidateMoveResponse {
  valid: boolean;
  error?: string;
}

// Dry-run of the same server-side check makeMove applies — including
// superko, which needs the full position history and so can't be checked
// purely client-side. Always resolves (valid: true/false); it only rejects
// for an actual request failure (network, auth, game not found, etc).
export function validateMoveRequest(id: string, x: number, y: number, color: Color): Promise<ValidateMoveResponse> {
  return fetch(`${API_BASE}/games/${id}/moves/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, color }),
  }).then((res) => handle<ValidateMoveResponse>(res));
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

export function finalizeScoring(
  id: string,
  deadPoints: Point[],
  sekiPoints: Point[] = [],
): Promise<FinalizeScoringResponse> {
  return fetch(`${API_BASE}/games/${id}/finalize-scoring`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deadPoints, sekiPoints }),
  }).then((res) => handle<FinalizeScoringResponse>(res));
}

// Registration hands back a recovery code with the account — the one time
// it is ever shown, since the server keeps only its hash.
export function register(username: string, password: string): Promise<AuthUser & { recoveryCode?: string }> {
  return fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((res) => handle<AuthUser & { recoveryCode?: string }>(res));
}

// A new code, replacing whatever the account had. Needs the password: it
// hands out a key to the account.
export function newRecoveryCode(password: string): Promise<string> {
  return fetch(`${API_BASE}/auth/recovery-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
    .then((res) => handle<{ recoveryCode: string }>(res))
    .then((data) => data.recoveryCode);
}

// Setting a password without the old one, for someone who kept their
// code. Answers with the next one, since this one is spent.
export function resetPassword(username: string, recoveryCode: string, newPassword: string): Promise<string> {
  return fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, recoveryCode, newPassword }),
  })
    .then((res) => handle<{ recoveryCode: string }>(res))
    .then((data) => data.recoveryCode);
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

// What the server this client is talking to can do. A server either plays
// GNU Go games or it doesn't, and that doesn't change while it runs, so it
// rides along with the launch call that asks who is signed in.
export interface ServerFeatures {
  gnugo: boolean;
  // Whether this server times GNU Go moves — if it doesn't, there is no
  // report to offer and the link stays hidden.
  gnugoDebugPerformance?: boolean;
}

// True for a server old enough not to say, which is how every server
// behaved before there was anything to ask.
export const DEFAULT_FEATURES: ServerFeatures = { gnugo: true, gnugoDebugPerformance: false };

export function getMe(): Promise<{ user: AuthUser | null; features: ServerFeatures }> {
  return fetch(`${API_BASE}/auth/me`)
    .then((res) => handle<{ user: AuthUser | null; features?: ServerFeatures }>(res))
    .then((data) => ({ user: data.user, features: data.features ?? DEFAULT_FEATURES }));
}

// Any logged-in user's public info by id, not just the caller's own —
// backs the profile page (/profile/:id).
export function getUser(id: string): Promise<UserProfile> {
  return fetch(`${API_BASE}/users/${id}`).then((res) => handle<UserProfile>(res));
}

// Ends the account. The password goes with it because the server asks for
// it again: a session left open on a shared computer is not enough.
export function deleteAccount(password: string): Promise<void> {
  return fetch(`${API_BASE}/auth/me`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
    .then((res) => handle<{ success: true }>(res))
    .then(() => undefined);
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return fetch(`${API_BASE}/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  }).then((res) => handle<{ success: true }>(res)).then(() => undefined);
}

// A 204 with no body on success, so this can't go through handle<T> (which
// always calls res.json()) — mirrors deleteGame's own manual res.ok check.
export async function setAcceptsInvitations(acceptsInvitations: boolean): Promise<void> {
  await patchSetting({ acceptsInvitations });
}


async function patchSetting(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? 'Failed to update setting');
  }
}

// What one GNU Go move cost, split into the phases it is made of. Only
// collected on a server running with GNUGO_DEBUG_PERFORMANCE.
export interface GnugoTiming {
  moveNumber: number;
  level: number;
  boardSize: number;
  movesReplayed: number;
  queueWaitMs: number;
  setupMs: number;
  replayMs: number;
  genmoveMs: number;
  totalMs: number;
  // Linux only — null where /proc isn't there to read.
  cpuMs: number | null;
}

export function listGnugoTimings(gameId: string): Promise<GnugoTiming[]> {
  return fetch(`${API_BASE}/games/${gameId}/gnugo-timings`).then((res) => handle<GnugoTiming[]>(res));
}
