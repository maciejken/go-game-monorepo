import express from 'express';
import db from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import {
  applyDeadStones,
  createEmptyBoard,
  getCurrentColor,
  getKomi,
  hashBoard,
  scoreBoard,
  validateMove,
  type Board,
  type Captures,
  type Color,
  type Point,
  type PositionRecord,
} from 'shared';

import { dbPath, port } from './config.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionToken,
  getSessionUser,
  hashPassword,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from './auth.js';
import { seedDefaultUser, seedAiUser, getAiUserId } from './seed.js';
import { attachWebSocketServer, broadcastGameUpdate, broadcastGamesListUpdate } from './ws.js';
import { generateAiMove, isGnuGoAvailable, type AiMoveResult, type ReplayMove } from './gnugo.js';
import { deductClock, hasTimedOut, resolveTimeControl, type ClockState, type TimeControlName } from './clock.js';

seedDefaultUser();
seedAiUser();

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express();
app.use(express.json());

app.use(express.static(path.resolve(__dirname, '../../client/dist')));

app.get('/', (req, res) => {
  res.json({ message: 'Go server is running!' });
});

app.get('/db-test', (req, res) => {
  try {
    db.prepare(`
      INSERT INTO events (game_id, move_number, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'perm-test',
      1,
      'TEST',
      JSON.stringify({ ok: true }),
      Date.now()
    );

    res.json({ ok: true });
  } catch (error) {
    res.json({ error });
  }
});

interface GameRow {
  id: string;
  size: number;
  status: string;
  result: string | null;
  handicap: number;
  title: string | null;
  created_at: number;
  updated_at: number;
  black_user_id: string | null;
  white_user_id: string | null;
  pending_undo_by: string | null;
  end_reason: string | null;
  pending_reopen_by: string | null;
  time_control: string | null;
  main_time_seconds: number | null;
  byoyomi_seconds: number | null;
  byoyomi_periods: number | null;
  black_time_remaining_ms: number | null;
  white_time_remaining_ms: number | null;
  black_periods_left: number | null;
  white_periods_left: number | null;
  turn_started_at: number | null;
}

function getGameRow(id: string): GameRow | undefined {
  return db.prepare(`
    SELECT id, size, status, result, handicap, title, created_at, updated_at,
           black_user_id, white_user_id, pending_undo_by, end_reason, pending_reopen_by,
           time_control, main_time_seconds, byoyomi_seconds, byoyomi_periods,
           black_time_remaining_ms, white_time_remaining_ms, black_periods_left, white_periods_left, turn_started_at
    FROM games WHERE id = ?
  `).get(id) as GameRow | undefined;
}

function getUsername(userId: string | null): string | null {
  if (!userId) {
    return null;
  }
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  return row?.username ?? null;
}

interface Participants {
  black_user_id: string | null;
  white_user_id: string | null;
}

// 'both' covers local games, where one account plays both colors.
function getMyColor(game: Participants, userId: string | null): 'black' | 'white' | 'both' | null {
  if (!userId) {
    return null;
  }
  const isBlack = game.black_user_id === userId;
  const isWhite = game.white_user_id === userId;
  if (isBlack && isWhite) return 'both';
  if (isBlack) return 'black';
  if (isWhite) return 'white';
  return null;
}

function canActAsColor(game: Participants, userId: string, color: Color): boolean {
  return color === 'black' ? game.black_user_id === userId : game.white_user_id === userId;
}

function isParticipant(game: Participants, userId: string): boolean {
  return game.black_user_id === userId || game.white_user_id === userId;
}

function isAiOpponentGame(game: Participants): boolean {
  const aiId = getAiUserId();
  return game.black_user_id === aiId || game.white_user_id === aiId;
}

function getClockState(game: GameRow, color: Color): ClockState {
  return {
    remainingMs: (color === 'black' ? game.black_time_remaining_ms : game.white_time_remaining_ms) ?? 0,
    periodsLeft: (color === 'black' ? game.black_periods_left : game.white_periods_left) ?? 0,
  };
}

// Lazily resolves a timed-out game: called at the top of every route that
// reads or acts on a game, so nobody needs an active connection watching a
// clock tick down in real time for a timeout to actually take effect — the
// next request against this game (from anyone, for any reason) will catch
// it. A periodic sweep (below) additionally catches games nobody happens to
// be looking at.
function withTimeoutCheck(game: GameRow): GameRow {
  if (game.status !== 'in_progress' || game.main_time_seconds === null) {
    return game;
  }

  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  const state = getClockState(game, currentColor);
  const elapsedMs = Date.now() - (game.turn_started_at ?? Date.now());

  if (!hasTimedOut(state, game.byoyomi_seconds ?? 0, elapsedMs)) {
    return game;
  }

  const winner: Color = currentColor === 'black' ? 'white' : 'black';
  const winnerLabel = winner === 'black' ? 'Black' : 'White';
  const loserLabel = currentColor === 'black' ? 'Black' : 'White';
  const result = `${winnerLabel} wins on time (${loserLabel} ran out)`;
  const now = Date.now();

  db.prepare('UPDATE games SET status = ?, result = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', result, 'timeout', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  return { ...game, status: 'finished', result, end_reason: 'timeout' };
}

// Periodically catches timeouts in games nobody is actively viewing —
// otherwise a clock could visibly show 0:00 to nobody, forever, since
// withTimeoutCheck only runs when a request touches that specific game.
function sweepTimeouts(): void {
  const rows = db.prepare(`
    SELECT id FROM games WHERE status = 'in_progress' AND main_time_seconds IS NOT NULL
  `).all() as { id: string }[];

  for (const row of rows) {
    const game = getGameRow(row.id);
    if (game) {
      withTimeoutCheck(game);
    }
  }
}

const MAX_TITLE_LENGTH = 100;

function sanitizeTitle(rawTitle: unknown): string | null {
  if (typeof rawTitle !== 'string') {
    return null;
  }
  const trimmed = rawTitle.trim().slice(0, MAX_TITLE_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

// Standard handicap star points, verified against the canonical 19x19 table
// (Wikipedia: "Handicapping in Go") and the equivalent 3-3/4-4 convention
// used for 9x9/13x13. Coordinates are 0-indexed [x, y].
interface StarPoints {
  upperRight: [number, number];
  lowerLeft: [number, number];
  lowerRight: [number, number];
  upperLeft: [number, number];
  center: [number, number];
  leftMid?: [number, number];
  rightMid?: [number, number];
  topMid?: [number, number];
  bottomMid?: [number, number];
}

const STAR_POINTS: Record<number, StarPoints> = {
  9: {
    upperRight: [6, 2], lowerLeft: [2, 6], lowerRight: [6, 6], upperLeft: [2, 2],
    center: [4, 4],
  },
  13: {
    upperRight: [9, 3], lowerLeft: [3, 9], lowerRight: [9, 9], upperLeft: [3, 3],
    center: [6, 6],
  },
  19: {
    upperRight: [15, 3], lowerLeft: [3, 15], lowerRight: [15, 15], upperLeft: [3, 3],
    center: [9, 9],
    leftMid: [3, 9], rightMid: [15, 9], topMid: [9, 3], bottomMid: [9, 15],
  },
};

// Handicap stone placement order, per the standard table: corners fill
// upper-right, lower-left, lower-right, upper-left; center is included only
// for odd handicaps 5/7/9; side points are added as left+right at 6, then
// top+bottom at 8.
function getHandicapPoints(size: number, handicap: number): [number, number][] {
  const sp = STAR_POINTS[size];
  if (!sp || handicap < 2) {
    return [];
  }

  const corners: [number, number][] = [sp.upperRight, sp.lowerLeft, sp.lowerRight, sp.upperLeft];
  const points = corners.slice(0, Math.min(handicap, 4));

  if (handicap >= 6 && sp.leftMid && sp.rightMid) {
    points.push(sp.leftMid, sp.rightMid);
  }
  if (handicap >= 8 && sp.topMid && sp.bottomMid) {
    points.push(sp.topMid, sp.bottomMid);
  }
  if (handicap === 5 || handicap === 7 || handicap === 9) {
    points.push(sp.center);
  }

  return points;
}

// In a handicap game Black's extra stones are already an advantage, so
// White moves first. Shifting the move number by one flips the parity that
// `getCurrentColor`/`validateMove` use, without changing how move numbers
// are actually stored.
function turnMoveNumber(moveNumber: number, handicap: number): number {
  return handicap >= 2 ? moveNumber + 1 : moveNumber;
}

// The next move number is tracked via `events` (which logs every action,
// including passes/resigns), while the board only reflects actual stone
// placements — so a pass must still advance the turn without touching it.
function getNextMoveNumber(gameId: string): number {
  const row = db.prepare(`
    SELECT MAX(move_number) as maxMoveNumber FROM events WHERE game_id = ?
  `).get(gameId) as { maxMoveNumber: number | null };

  return (row.maxMoveNumber ?? 0) + 1;
}

function getCurrentBoard(gameId: string, size: number): Board {
  const row = db.prepare(`
    SELECT state FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number DESC
    LIMIT 1
  `).get(gameId) as { state: string } | undefined;

  return row ? (JSON.parse(row.state) as Board) : createEmptyBoard(size);
}

// Every position the game has passed through so far, for the situational
// superko check. Hashes come straight from the `snapshots.hash` column
// (computed once at write time) rather than being recomputed here.
function getGameHistory(gameId: string, size: number, handicap: number): PositionRecord[] {
  const rows = db.prepare(`
    SELECT move_number, state, hash FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId) as { move_number: number; state: string; hash: string }[];

  const history: PositionRecord[] = [];

  // Handicap games already have a move_number = 0 snapshot; plain games
  // start from an empty board that was never itself written to a row.
  if (rows.length === 0 || rows[0].move_number !== 0) {
    const emptyBoard = createEmptyBoard(size);
    history.push({
      board: emptyBoard,
      hash: hashBoard(emptyBoard).toString(),
      nextColor: getCurrentColor(turnMoveNumber(1, handicap)),
    });
  }

  for (const row of rows) {
    history.push({
      board: JSON.parse(row.state) as Board,
      hash: row.hash,
      nextColor: getCurrentColor(turnMoveNumber(row.move_number + 1, handicap)),
    });
  }

  return history;
}

function getLastEventType(gameId: string, moveNumber: number): string | undefined {
  const row = db.prepare(`
    SELECT event_type FROM events WHERE game_id = ? AND move_number = ?
  `).get(gameId, moveNumber) as { event_type: string } | undefined;

  return row?.event_type;
}

// The game replayed as a flat move list for GNU Go to `play` back in via
// GTP before it's asked to generate its own move — handicap stones count
// as black plays, passes carry a null point.
function getReplayMoves(gameId: string): ReplayMove[] {
  const events = db.prepare(`
    SELECT event_type, payload FROM events WHERE game_id = ? ORDER BY move_number ASC
  `).all(gameId) as { event_type: string; payload: string }[];

  const moves: ReplayMove[] = [];
  for (const event of events) {
    const payload = JSON.parse(event.payload) as {
      color?: Color;
      x?: number;
      y?: number;
      points?: [number, number][];
    };
    if (event.event_type === 'HANDICAP' && payload.points) {
      for (const [x, y] of payload.points) {
        moves.push({ color: 'black', point: { x, y } });
      }
    } else if (event.event_type === 'MOVE' && payload.color && payload.x !== undefined && payload.y !== undefined) {
      moves.push({ color: payload.color, point: { x: payload.x, y: payload.y } });
    } else if (event.event_type === 'PASS' && payload.color) {
      moves.push({ color: payload.color, point: null });
    }
  }
  return moves;
}

// Cumulative stones each color has captured over the whole game so far,
// derived fresh from the event log rather than tracked separately — the
// event log is already the source of truth for what each move captured.
function getCumulativeCaptures(gameId: string): Captures {
  const rows = db.prepare(`
    SELECT payload FROM events WHERE game_id = ? AND event_type = 'MOVE'
  `).all(gameId) as { payload: string }[];

  const captures: Captures = { black: 0, white: 0 };
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { color?: Color; capturedPoints?: Point[] };
    const count = payload.capturedPoints?.length ?? 0;
    if (payload.color === 'black') {
      captures.black += count;
    } else if (payload.color === 'white') {
      captures.white += count;
    }
  }

  return captures;
}

interface MoveHistoryEntry {
  moveNumber: number;
  board: Board;
  eventType: string;
  color: Color | null;
  point: Point | null;
  capturedPoints: Point[];
}

// The full move-by-move record for the "review" feature: every event the
// game has logged, paired with the board as it stood right after. Passes
// and resigns don't have their own snapshot, so their board is carried
// forward from the last actual placement.
function getMoveHistory(gameId: string, size: number): MoveHistoryEntry[] {
  const events = db.prepare(`
    SELECT move_number, event_type, payload FROM events
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId) as { move_number: number; event_type: string; payload: string }[];

  const snapshotRows = db.prepare(`
    SELECT move_number, state FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId) as { move_number: number; state: string }[];

  const boardByMove = new Map<number, Board>();
  for (const row of snapshotRows) {
    boardByMove.set(row.move_number, JSON.parse(row.state) as Board);
  }

  const history: MoveHistoryEntry[] = [];
  let lastBoard = createEmptyBoard(size);

  // Handicap games log their setup as move 0; plain games start from an
  // empty board that was never itself written to a row.
  if (events.length === 0 || events[0].move_number !== 0) {
    history.push({ moveNumber: 0, board: lastBoard, eventType: 'START', color: null, point: null, capturedPoints: [] });
  }

  for (const event of events) {
    const payload = JSON.parse(event.payload) as {
      color?: Color;
      x?: number;
      y?: number;
      capturedPoints?: Point[];
    };
    const board = boardByMove.get(event.move_number) ?? lastBoard;
    lastBoard = board;

    history.push({
      moveNumber: event.move_number,
      board,
      eventType: event.event_type,
      color: payload.color ?? null,
      point:
        event.event_type === 'MOVE' && payload.x !== undefined && payload.y !== undefined
          ? { x: payload.x, y: payload.y }
          : null,
      capturedPoints: payload.capturedPoints ?? [],
    });
  }

  return history;
}

interface MoveApplyResult {
  board: Board;
  moveNumber: number;
  capturedPoints: Point[];
  nextColor: Color;
  captures: Captures;
}

// Deducts the mover's thinking time from their clock and resets the turn
// timer for whoever moves next. A no-op for untimed games. `game` is
// expected to have already passed withTimeoutCheck, so elapsedMs here is
// guaranteed to fit their budget.
function advanceClock(game: GameRow, color: Color, now: number): void {
  if (game.main_time_seconds === null) {
    return;
  }
  const elapsedMs = now - (game.turn_started_at ?? now);
  const next = deductClock(getClockState(game, color), game.byoyomi_seconds ?? 0, elapsedMs);

  if (color === 'black') {
    db.prepare('UPDATE games SET black_time_remaining_ms = ?, black_periods_left = ?, turn_started_at = ? WHERE id = ?')
      .run(next.remainingMs, next.periodsLeft, now, game.id);
  } else {
    db.prepare('UPDATE games SET white_time_remaining_ms = ?, white_periods_left = ?, turn_started_at = ? WHERE id = ?')
      .run(next.remainingMs, next.periodsLeft, now, game.id);
  }
}

// Shared by the human-facing /moves endpoint and the AI trigger below, so
// there's exactly one place that writes a MOVE event to the log.
function applyMoveToGame(
  game: GameRow,
  x: number,
  y: number,
  color: Color,
): { ok: true; result: MoveApplyResult } | { ok: false; error: string } {
  const board = getCurrentBoard(game.id, game.size);
  const history = getGameHistory(game.id, game.size, game.handicap);
  const moveNumber = getNextMoveNumber(game.id);
  const validation = validateMove(board, { x, y }, color, turnMoveNumber(moveNumber, game.handicap), history);
  if (!validation.valid) {
    return { ok: false, error: validation.error! };
  }

  const newBoard = validation.board!;
  const capturedPoints = validation.capturedPoints!;
  const now = Date.now();

  db.prepare(`
    INSERT INTO snapshots (game_id, move_number, state, hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, JSON.stringify(newBoard), validation.hash!, now);

  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'MOVE', JSON.stringify({ x, y, color, capturedPoints }), now);

  advanceClock(game, color, now);

  db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  return {
    ok: true,
    result: {
      board: newBoard,
      moveNumber,
      capturedPoints,
      nextColor: getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap)),
      captures: getCumulativeCaptures(game.id),
    },
  };
}

function applyPassToGame(game: GameRow, color: Color): { status: string; nextColor: Color } {
  const moveNumber = getNextMoveNumber(game.id);
  const now = Date.now();

  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'PASS', JSON.stringify({ color }), now);

  advanceClock(game, color, now);

  // Two consecutive passes end play and move into the scoring phase, where
  // dead stones get marked before the final result is computed — see
  // POST /api/games/:id/finalize-scoring.
  const previousEventType = getLastEventType(game.id, moveNumber - 1);
  const status = previousEventType === 'PASS' ? 'scoring' : 'in_progress';

  db.prepare('UPDATE games SET status = ?, result = ?, updated_at = ? WHERE id = ?')
    .run(status, null, now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  return { status, nextColor: getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap)) };
}

function applyResignToGame(game: GameRow, color: Color): string {
  const now = Date.now();
  const moveNumber = getNextMoveNumber(game.id);

  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'RESIGN', JSON.stringify({ color }), now);

  const gameResult = `${color === 'black' ? 'Black' : 'White'} resigned`;
  db.prepare('UPDATE games SET status = ?, result = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', gameResult, 'resign', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  return gameResult;
}

// Lower level = faster and weaker (GNU Go's own description) — the main
// lever against the deep-reading blowups that make some positions slow.
// Trading some strength for reliability by default; both tunable without a
// code change if you want to dial strength back up (more hang risk) or
// down further (less).
const GNUGO_LEVEL = Number(process.env.GNUGO_LEVEL) || 5;
const GNUGO_RETRY_LEVEL = Number(process.env.GNUGO_RETRY_LEVEL) || 1;
const GNUGO_RETRY_TIMEOUT_MS = 5000;

// Called (fire-and-forget) after any action that might hand the turn to
// the AI — a human move/pass, or game creation when the AI plays first.
// No-ops immediately unless it's actually the AI's turn.
async function maybeTriggerAiMove(gameId: string): Promise<void> {
  let game = getGameRow(gameId);
  if (!game || game.status !== 'in_progress') {
    return;
  }
  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    return;
  }

  const aiId = getAiUserId();
  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  const colorUserId = currentColor === 'black' ? game.black_user_id : game.white_user_id;
  if (colorUserId !== aiId) {
    return;
  }

  const baseRequest = {
    size: game.size,
    komi: getKomi(game.handicap),
    moves: getReplayMoves(game.id),
    colorToMove: currentColor,
  };

  // Never a random move: on failure, retry once at a much lower level —
  // still a genuine GNU Go move, just faster and weaker, which is also far
  // less likely to hit the same reading blowup a second time. If that also
  // fails, the game is left waiting rather than forcing a move through —
  // the human can still Undo and play something else in the meantime.
  let aiResult: AiMoveResult;
  try {
    aiResult = await generateAiMove({ ...baseRequest, level: GNUGO_LEVEL });
  } catch (err) {
    console.error(
      `GNU Go (level ${GNUGO_LEVEL}) failed to respond (${(err as Error).message}) — retrying at level ${GNUGO_RETRY_LEVEL}.`,
    );
    try {
      aiResult = await generateAiMove({ ...baseRequest, level: GNUGO_RETRY_LEVEL }, GNUGO_RETRY_TIMEOUT_MS);
    } catch (retryErr) {
      console.error(
        `GNU Go retry at level ${GNUGO_RETRY_LEVEL} also failed (${(retryErr as Error).message}) — giving up for now.`,
      );
      return;
    }
  }

  // Re-check: state may have moved on (e.g. an undo), or the AI's own clock
  // may have run out, while GNU Go was thinking.
  let freshGame = getGameRow(game.id);
  if (!freshGame || freshGame.status !== 'in_progress') {
    return;
  }
  freshGame = withTimeoutCheck(freshGame);
  if (freshGame.status !== 'in_progress') {
    return;
  }

  if (aiResult.type === 'move') {
    const applied = applyMoveToGame(freshGame, aiResult.point.x, aiResult.point.y, currentColor);
    if (!applied.ok) {
      console.error(`GNU Go proposed an illegal move (${applied.error}).`);
    }
  } else if (aiResult.type === 'resign') {
    applyResignToGame(freshGame, currentColor);
  } else {
    applyPassToGame(freshGame, currentColor);
  }
}

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 6;

app.post('/api/auth/register', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (username.length < MIN_USERNAME_LENGTH) {
    res.status(400).json({ error: `Username must be at least ${MIN_USERNAME_LENGTH} characters` });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    res.status(400).json({ error: 'Username is already taken' });
    return;
  }

  const id = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, username, hashPassword(password), Date.now());

  const token = createSession(id);
  setSessionCookie(res, token);
  res.status(201).json({ id, username });
});

app.post('/api/auth/login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username) as
    | { id: string; username: string; password_hash: string }
    | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    destroySession(token);
  }
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: getSessionUser(req) });
});

app.get('/api/games', (req, res) => {
  const currentUser = getSessionUser(req);
  const ids = db.prepare('SELECT id FROM games ORDER BY updated_at DESC').all() as { id: string }[];
  const rows = ids.map((row) => withTimeoutCheck(getGameRow(row.id)!));

  res.json(rows.map((row) => ({
    id: row.id,
    size: row.size,
    status: row.status,
    result: row.result,
    handicap: row.handicap,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blackUsername: getUsername(row.black_user_id),
    whiteUsername: getUsername(row.white_user_id),
    myColor: getMyColor(row, currentUser?.id ?? null),
    isAiOpponent: isAiOpponentGame(row),
    timeControl: row.time_control,
  })));
});

app.post('/api/games', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const size = Number(req.body?.size) || 19;
  // Handicap placement is only defined for boards with a known star-point layout
  const handicap = STAR_POINTS[size] ? Math.max(0, Number(req.body?.handicap) || 0) : 0;
  const title = sanitizeTitle(req.body?.title);
  const timeControlName: TimeControlName = req.body?.timeControl === 'standard' || req.body?.timeControl === 'correspondence'
    ? req.body.timeControl
    : 'unlimited';
  const preset = resolveTimeControl(timeControlName);

  let blackUserId = user.id;
  let whiteUserId = user.id;

  // 'random' is nigiri — the traditional stone-guessing method — for anyone
  // who doesn't care which color they get.
  const resolveColor = (requested: unknown): Color =>
    requested === 'random' ? (Math.random() < 0.5 ? 'black' : 'white') : requested === 'white' ? 'white' : 'black';

  if (req.body?.mode === 'remote') {
    const opponentUsername =
      typeof req.body?.opponentUsername === 'string' ? req.body.opponentUsername.trim() : '';

    if (!opponentUsername) {
      res.status(400).json({ error: "Opponent's username is required for a remote game" });
      return;
    }
    if (req.body?.color !== 'black' && req.body?.color !== 'white' && req.body?.color !== 'random') {
      res.status(400).json({ error: 'Choose which color you will play' });
      return;
    }

    const opponent = db.prepare('SELECT id FROM users WHERE username = ?').get(opponentUsername) as
      | { id: string }
      | undefined;
    if (!opponent) {
      res.status(400).json({ error: `No user named "${opponentUsername}"` });
      return;
    }
    if (opponent.id === user.id) {
      res.status(400).json({ error: 'Invite a different user, not yourself' });
      return;
    }

    const color = resolveColor(req.body.color);
    blackUserId = color === 'black' ? user.id : opponent.id;
    whiteUserId = color === 'white' ? user.id : opponent.id;
  } else if (req.body?.mode === 'gnugo') {
    if (!(await isGnuGoAvailable())) {
      res.status(400).json({ error: 'GNU Go is not installed on the server — AI games are unavailable.' });
      return;
    }
    const color = resolveColor(req.body?.color);
    const aiId = getAiUserId();
    blackUserId = color === 'black' ? user.id : aiId;
    whiteUserId = color === 'white' ? user.id : aiId;
  }

  const id = randomUUID();
  const now = Date.now();
  const initialTimeMs = preset ? preset.mainTimeSeconds * 1000 : null;
  const initialPeriods = preset ? preset.byoyomiPeriods : null;

  db.prepare(`
    INSERT INTO games (
      id, size, handicap, title, created_at, updated_at, status, black_user_id, white_user_id,
      time_control, main_time_seconds, byoyomi_seconds, byoyomi_periods,
      black_time_remaining_ms, white_time_remaining_ms, black_periods_left, white_periods_left, turn_started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, size, handicap, title, now, now, 'in_progress', blackUserId, whiteUserId,
    preset ? timeControlName : null,
    preset ? preset.mainTimeSeconds : null,
    preset ? preset.byoyomiSeconds : null,
    initialPeriods,
    initialTimeMs, initialTimeMs, initialPeriods, initialPeriods, now,
  );

  const board = createEmptyBoard(size);
  const handicapPoints = getHandicapPoints(size, handicap);
  for (const [x, y] of handicapPoints) {
    board[y][x] = 'black';
  }

  if (handicapPoints.length > 0) {
    db.prepare(`
      INSERT INTO snapshots (game_id, move_number, state, hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 0, JSON.stringify(board), hashBoard(board).toString(), now);

    db.prepare(`
      INSERT INTO events (game_id, move_number, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 0, 'HANDICAP', JSON.stringify({ handicap, points: handicapPoints }), now);
  }

  broadcastGamesListUpdate();

  res.status(201).json({
    id,
    size,
    handicap,
    title,
    status: 'in_progress',
    board,
    blackUsername: getUsername(blackUserId),
    whiteUsername: getUsername(whiteUserId),
  });

  // No-op unless the AI was just assigned the color that moves first
  // (always true for AI-as-black; true for AI-as-white in a handicap game).
  maybeTriggerAiMove(id);
});

app.get('/api/games/:id', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }
  game = withTimeoutCheck(game);

  const board = getCurrentBoard(game.id, game.size);
  const moveNumber = getNextMoveNumber(game.id);
  const currentUser = getSessionUser(req);

  res.json({
    id: game.id,
    size: game.size,
    status: game.status,
    result: game.result,
    handicap: game.handicap,
    title: game.title,
    board,
    currentColor: getCurrentColor(turnMoveNumber(moveNumber, game.handicap)),
    captures: getCumulativeCaptures(game.id),
    blackUsername: getUsername(game.black_user_id),
    whiteUsername: getUsername(game.white_user_id),
    myColor: getMyColor(game, currentUser?.id ?? null),
    pendingUndoBy: game.pending_undo_by,
    endReason: game.end_reason,
    pendingReopenBy: game.pending_reopen_by,
    isAiOpponent: isAiOpponentGame(game),
    timeControl: game.time_control,
    mainTimeSeconds: game.main_time_seconds,
    byoyomiSeconds: game.byoyomi_seconds,
    byoyomiPeriods: game.byoyomi_periods,
    blackTimeRemainingMs: game.black_time_remaining_ms,
    whiteTimeRemainingMs: game.white_time_remaining_ms,
    blackPeriodsLeft: game.black_periods_left,
    whitePeriodsLeft: game.white_periods_left,
    turnStartedAt: game.turn_started_at,
  });
});

app.patch('/api/games/:id', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    res.status(403).json({ error: 'Only players in this game can edit it' });
    return;
  }

  const title = sanitizeTitle(req.body?.title);
  db.prepare('UPDATE games SET title = ? WHERE id = ?').run(title, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ title });
});

app.get('/api/games/:id/history', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  res.json({ size: game.size, moves: getMoveHistory(game.id, game.size) });
});

app.delete('/api/games/:id', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    res.status(403).json({ error: 'Only players in this game can delete it' });
    return;
  }

  db.prepare('DELETE FROM events WHERE game_id = ?').run(game.id);
  db.prepare('DELETE FROM snapshots WHERE game_id = ?').run(game.id);
  db.prepare('DELETE FROM games WHERE id = ?').run(game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.status(204).end();
});

app.post('/api/games/:id/moves', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    res.status(400).json({ error: 'Game is not in progress' });
    return;
  }
  if (game.pending_undo_by) {
    res.status(400).json({ error: 'An undo request is pending confirmation' });
    return;
  }

  const { x, y, color } = req.body ?? {};
  if (typeof x !== 'number' || typeof y !== 'number' || (color !== 'black' && color !== 'white')) {
    res.status(400).json({ error: 'Invalid move payload' });
    return;
  }
  if (!canActAsColor(game, user.id, color)) {
    res.status(403).json({ error: `You are not playing as ${color} in this game` });
    return;
  }

  const applied = applyMoveToGame(game, x, y, color);
  if (!applied.ok) {
    res.status(400).json({ error: applied.error });
    return;
  }

  res.json(applied.result);

  maybeTriggerAiMove(game.id);
});

app.post('/api/games/:id/pass', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    res.status(400).json({ error: 'Game is not in progress' });
    return;
  }
  if (game.pending_undo_by) {
    res.status(400).json({ error: 'An undo request is pending confirmation' });
    return;
  }

  const { color } = req.body ?? {};
  if (color !== 'black' && color !== 'white') {
    res.status(400).json({ error: 'Invalid color' });
    return;
  }
  if (!canActAsColor(game, user.id, color)) {
    res.status(403).json({ error: `You are not playing as ${color} in this game` });
    return;
  }

  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  if (color !== currentColor) {
    res.status(400).json({ error: `It is ${currentColor}'s turn` });
    return;
  }

  const applied = applyPassToGame(game, color);

  res.json({
    status: applied.status,
    result: null,
    nextColor: applied.nextColor,
  });

  if (applied.status === 'in_progress') {
    maybeTriggerAiMove(game.id);
  }
});

app.post('/api/games/:id/finalize-scoring', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    res.status(403).json({ error: 'Only players in this game can finalize scoring' });
    return;
  }

  if (game.status !== 'scoring') {
    res.status(400).json({ error: 'Game is not in the scoring phase' });
    return;
  }
  if (game.pending_undo_by) {
    res.status(400).json({ error: 'An undo request is pending confirmation' });
    return;
  }

  const rawDeadPoints: unknown[] = Array.isArray(req.body?.deadPoints) ? req.body.deadPoints : [];
  const deadPoints: Point[] = rawDeadPoints
    .map((p: unknown) => (p && typeof p === 'object' ? (p as { x: unknown; y: unknown }) : null))
    .filter((p: { x: unknown; y: unknown } | null): p is { x: unknown; y: unknown } => p !== null)
    .map((p: { x: unknown; y: unknown }) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter(
      (p: Point) =>
        Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < game.size && p.y >= 0 && p.y < game.size,
    );

  const board = getCurrentBoard(game.id, game.size);
  const { board: effectiveBoard, captures: adjustedCaptures } = applyDeadStones(
    board,
    getCumulativeCaptures(game.id),
    deadPoints,
  );

  const score = scoreBoard(effectiveBoard, adjustedCaptures, getKomi(game.handicap));
  const winnerLabel = score.winner === 'black' ? 'Black' : 'White';
  const gameResult = `${winnerLabel} wins by ${score.margin.toFixed(1)} (B: ${score.black}, W: ${score.white})`;

  const now = Date.now();
  db.prepare('UPDATE games SET status = ?, result = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', gameResult, 'scoring', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ status: 'finished', result: gameResult, captures: adjustedCaptures });
});

// Lets a mismarked scoring result be redone: reopens a game that finished
// via the scoring phase back into 'scoring', with the board and move
// history untouched, so dead stones can be re-marked and finalized again.
// Not offered for games that ended by resignation or timeout — there's no
// scoring to redo. Negotiates the same way undo does: immediate for a
// local/AI game, request-then-confirm between two different players.
app.post('/api/games/:id/reopen-scoring', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    res.status(403).json({ error: 'Only players in this game can redo scoring' });
    return;
  }
  if (game.status !== 'finished' || game.end_reason !== 'scoring') {
    res.status(400).json({ error: 'Only a game finished by scoring can be reopened' });
    return;
  }
  if (game.pending_undo_by) {
    res.status(400).json({ error: 'An undo request is pending confirmation' });
    return;
  }

  const isImmediate = game.black_user_id === game.white_user_id || isAiOpponentGame(game);
  const myColor: Color = game.black_user_id === user.id ? 'black' : 'white';

  if (!isImmediate) {
    if (!game.pending_reopen_by) {
      db.prepare('UPDATE games SET pending_reopen_by = ? WHERE id = ?').run(myColor, game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'requested', pendingReopenBy: myColor });
      return;
    }
    if (game.pending_reopen_by === myColor) {
      db.prepare('UPDATE games SET pending_reopen_by = NULL WHERE id = ?').run(game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'cancelled', pendingReopenBy: null });
      return;
    }
    // Otherwise myColor is the other player, confirming — fall through and reopen.
  }

  const now = Date.now();
  db.prepare('UPDATE games SET status = ?, result = NULL, end_reason = NULL, pending_reopen_by = NULL, updated_at = ? WHERE id = ?')
    .run('scoring', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ action: 'confirmed', status: 'scoring', result: null, pendingReopenBy: null });
});

// A single endpoint drives the whole undo negotiation: in a local game (one
// account playing both colors) or an AI game (there's no second human to
// ask) it undoes immediately, same as before. In a remote game between two
// different accounts, the first call files a request and the *other*
// player must call this same endpoint to confirm it — calling it again as
// the original requester cancels the request instead.
app.post('/api/games/:id/undo', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    res.status(403).json({ error: 'Only players in this game can undo moves' });
    return;
  }

  // Undo is otherwise allowed regardless of status (e.g. undoing a
  // resignation), so only block it here if the clock just now — as of this
  // very check — ran out and ended the game; a pre-existing finished/scoring
  // status should fall through exactly as before.
  const statusBeforeTimeoutCheck = game.status;
  game = withTimeoutCheck(game);
  if (statusBeforeTimeoutCheck === 'in_progress' && game.status === 'finished') {
    res.status(400).json({ error: 'Game is not in progress' });
    return;
  }
  if (game.pending_reopen_by) {
    res.status(400).json({ error: 'A redo-scoring request is pending confirmation' });
    return;
  }

  const lastEvent = db.prepare(`
    SELECT move_number, event_type FROM events WHERE game_id = ?
    ORDER BY move_number DESC LIMIT 1
  `).get(game.id) as { move_number: number; event_type: string } | undefined;

  // move_number 0 is the handicap setup, not a player action — nothing to undo past it.
  if (!lastEvent || lastEvent.event_type === 'HANDICAP') {
    res.status(400).json({ error: 'Nothing to undo' });
    return;
  }

  const isImmediate = game.black_user_id === game.white_user_id || isAiOpponentGame(game);
  const myColor: Color = game.black_user_id === user.id ? 'black' : 'white';

  if (!isImmediate) {
    if (!game.pending_undo_by) {
      db.prepare('UPDATE games SET pending_undo_by = ? WHERE id = ?').run(myColor, game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'requested', pendingUndoBy: myColor });
      return;
    }
    if (game.pending_undo_by === myColor) {
      db.prepare('UPDATE games SET pending_undo_by = NULL WHERE id = ?').run(game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'cancelled', pendingUndoBy: null });
      return;
    }
    // Otherwise myColor is the other player, confirming — fall through and perform the undo.
  }

  const now = Date.now();
  db.prepare('DELETE FROM events WHERE game_id = ? AND move_number = ?').run(game.id, lastEvent.move_number);
  db.prepare('DELETE FROM snapshots WHERE game_id = ? AND move_number = ?').run(game.id, lastEvent.move_number);
  // Whoever's turn it now is gets a freshly-started clock reading from this
  // moment — there's no historical timing to restore for an undone move.
  db.prepare('UPDATE games SET status = ?, result = ?, pending_undo_by = NULL, updated_at = ?, turn_started_at = ? WHERE id = ?')
    .run('in_progress', null, now, now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  const board = getCurrentBoard(game.id, game.size);
  const nextMoveNumber = getNextMoveNumber(game.id);

  res.json({
    action: 'confirmed',
    board,
    status: 'in_progress',
    result: null,
    currentColor: getCurrentColor(turnMoveNumber(nextMoveNumber, game.handicap)),
    captures: getCumulativeCaptures(game.id),
    pendingUndoBy: null,
  });

  // If what got undone was the AI's own move, it's the AI's turn again —
  // nothing else would prompt it to move, so ask it to reconsider now.
  maybeTriggerAiMove(game.id);
});

app.post('/api/games/:id/resign', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    res.status(400).json({ error: 'Game is not in progress' });
    return;
  }
  if (game.pending_undo_by) {
    res.status(400).json({ error: 'An undo request is pending confirmation' });
    return;
  }

  const { color } = req.body ?? {};
  if (color !== 'black' && color !== 'white') {
    res.status(400).json({ error: 'Invalid color' });
    return;
  }
  if (!canActAsColor(game, user.id, color)) {
    res.status(403).json({ error: `You are not playing as ${color} in this game` });
    return;
  }

  const gameResult = applyResignToGame(game, color);

  res.json({ status: 'finished', result: gameResult });
});

// For React Router — serve index.html for all non-API routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../client/dist/index.html'));
});

const httpServer = createServer(app);
attachWebSocketServer(httpServer);

const TIMEOUT_SWEEP_INTERVAL_MS = 10_000;
setInterval(sweepTimeouts, TIMEOUT_SWEEP_INTERVAL_MS);

httpServer.listen(port, () => {
  console.log(`Server running on port ${port}; db path: ${dbPath}`);
});
