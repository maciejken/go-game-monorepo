import express from 'express';
import rateLimit from 'express-rate-limit';
import db from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import fs from 'fs';
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

import { dbPath, port, httpsPort, keyPath, certPath } from './config.js';
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
import { isApnsConfigured, sendPushNotification } from './apns.js';
import { deductClock, hasTimedOut, resolveTimeControl, type ClockState, type TimeControlName } from './clock.js';

seedDefaultUser();
seedAiUser();

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express();
app.use(express.json());

// Lets certbot verify domain ownership in webroot mode.
app.use('/.well-known/acme-challenge', express.static('/etc/certbot-webroot/.well-known/acme-challenge'));

// Universal Links config for the iOS app (ios-app/, associated domain
// applinks:igo5.online): lets a plain https://igo5.online/games/<id> link
// (shared in a text/email/etc.) open straight into the app instead of a
// browser tab, no custom URL scheme needed. Must be served as exact JSON
// with no redirect — iOS fetches and caches this once per install, over a
// plain GET, before ever consulting the app's own entitlements. The appID
// here must exactly match the app's own application-identifier entitlement
// (team + bundle id) — iOS silently falls back to opening the link in
// Safari on any mismatch. The bundle id is com.maciejkedra.igo5 (renamed
// from the original com.maciejkedra.gogame, which turned out to be
// registered under a team this Mac's Xcode could never get a working
// certificate for via automatic signing) — this App ID + its provisioning
// profile were created manually on developer.apple.com under team
// H36M3YGDVV and installed via manual (not automatic) code signing in
// project.pbxproj, since automatic signing kept re-registering new
// identifiers under whichever team it preferred rather than the one with
// a usable certificate. Confirm with `codesign -d --entitlements :-
// <built .app>` on the actual currently-installed build if links ever
// stop working again.
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  res.type('application/json');
  res.json({
    applinks: {
      apps: [],
      details: [
        {
          appIDs: ['H36M3YGDVV.com.maciejkedra.igo5'],
          components: [{ '/': '/' }, { '/': '/games/*' }, { '/': '/profile/*' }],
        },
      ],
    },
  });
});

app.use(express.static(path.resolve(__dirname, '../../client/dist')));

app.get('/', (req, res) => {
  res.json({ message: 'Go server is running!' });
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
  gnugo_level: number | null;
  komi: number | null;
  ai_current_level: number | null;
  invited_user_id: string | null;
  invite_status: string | null;
}

function getGameRow(id: string): GameRow | undefined {
  return db.prepare(`
    SELECT id, size, status, result, handicap, title, created_at, updated_at,
           black_user_id, white_user_id, pending_undo_by, end_reason, pending_reopen_by,
           time_control, main_time_seconds, byoyomi_seconds, byoyomi_periods,
           black_time_remaining_ms, white_time_remaining_ms, black_periods_left, white_periods_left, turn_started_at,
           gnugo_level, komi, ai_current_level, invited_user_id, invite_status
    FROM games WHERE id = ?
  `).get(id) as GameRow | undefined;
}

// True only for the invited side, and only until they respond — used to
// gate the confirm/reject prompt on the client. Not enforced server-side
// beyond that: nothing stops the invited player from moving without ever
// calling respond-invite, same trust level the rest of this API already
// extends to a logged-in participant.
function isPendingInviteFor(game: GameRow, userId: string | null): boolean {
  return game.invite_status === 'pending' && game.invited_user_id !== null && userId === game.invited_user_id;
}

// The other participant in a pending invite — used to notify them when the
// invited side declines. Assumes invite_status is 'pending' (so both
// black_user_id/white_user_id are the inviter and invitee, nobody else).
function inviterIdFor(game: GameRow): string | null {
  return game.invited_user_id === game.black_user_id ? game.white_user_id : game.black_user_id;
}

function setAiCurrentLevel(gameId: string, level: number): void {
  db.prepare('UPDATE games SET ai_current_level = ? WHERE id = ?').run(level, gameId);
  broadcastGameUpdate(gameId);
}

// Falls back to the handicap-derived default for games created before the
// explicit per-game komi setting existed.
function resolveKomi(game: GameRow): number {
  return game.komi ?? getKomi(game.handicap);
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

// A vision-service token authorizes moves for one specific game only, as
// either color — the camera identifies a move by stone color, not by which
// player physically placed it, so there's no single color to scope it to.
function isValidVisionToken(req: express.Request, gameId: string): boolean {
  const token = req.header('X-Vision-Token');
  if (!token) {
    return false;
  }
  const row = db.prepare('SELECT game_id FROM vision_tokens WHERE token = ?').get(token) as
    | { game_id: string }
    | undefined;
  return row?.game_id === gameId;
}

function isAiOpponentGame(game: Participants): boolean {
  const aiId = getAiUserId();
  return game.black_user_id === aiId || game.white_user_id === aiId;
}

// GNU Go is a single shared account (getAiUserId()), not one per player —
// gates new AI-game creation so it's only ever committed to one unfinished
// game at a time, server-wide, regardless of who's asking. "Open" covers
// both in_progress and scoring: nothing left for a human to do in either
// once the other player is GNU Go, since it can't mark dead stones either.
function hasOpenAiGame(): boolean {
  const aiId = getAiUserId();
  const row = db
    .prepare(
      `SELECT 1 FROM games
       WHERE status IN ('in_progress', 'scoring') AND (black_user_id = ? OR white_user_id = ?)
       LIMIT 1`,
    )
    .get(aiId, aiId);
  return row !== undefined;
}

// Sends to every device the user has registered — gameId rides along as
// custom push-payload data (see apns.ts) so a tap on the notification can
// take the iOS app straight to that game via DeepLinkRouter, the same
// mechanism a /games/<id> universal link uses.
function pushToUser(userId: string, alert: string, gameId: string): void {
  const tokens = db.prepare('SELECT token FROM device_tokens WHERE user_id = ?').all(userId) as {
    token: string;
  }[];
  for (const { token } of tokens) {
    sendPushNotification(token, alert, { gameId });
  }
}

// Pushes "it's your turn" to every device the color-to-move's player has
// registered — skipped for a local game (both colors are the same account,
// who obviously doesn't need telling) and whenever the *next* mover is the
// AI itself (no device to push to; maybeTriggerAiMove handles that turn
// instead, immediately, without waiting on a human). Deliberately not
// gated on isAiOpponentGame(game) generally: GNU Go's own move is applied
// via this same function (see applyMoveToGame's shared use below), fired
// off asynchronously after the human's move response already went out —
// so the human backgrounding the app right after their own move would
// otherwise never learn GNU Go replied.
function notifyOpponentOfMove(game: Participants & { id: string; title: string | null }, moverColor: Color, nextColor: Color): void {
  const opponentId = nextColor === 'black' ? game.black_user_id : game.white_user_id;
  const moverId = moverColor === 'black' ? game.black_user_id : game.white_user_id;
  const aiId = getAiUserId();
  if (!opponentId || opponentId === moverId || opponentId === aiId) {
    return;
  }

  const moverName = moverId === aiId ? 'GNU Go' : getUsername(moverId) ?? 'Your opponent';
  pushToUser(opponentId, `${moverName} moved${game.title ? ` in ${game.title}` : ''} — it's your turn.`, game.id);
}

// Resign ends the game outright rather than handing the turn back, so
// notifyOpponentOfMove's "it's your turn" framing doesn't fit — same
// opponent-lookup/local-game/AI guards, worded for the game having ended.
function notifyOpponentOfResign(game: Participants & { id: string; title: string | null }, resignedColor: Color): void {
  const resignedId = resignedColor === 'black' ? game.black_user_id : game.white_user_id;
  const opponentId = resignedColor === 'black' ? game.white_user_id : game.black_user_id;
  const aiId = getAiUserId();
  if (!opponentId || opponentId === resignedId || opponentId === aiId) {
    return;
  }

  const resignedName = getUsername(resignedId) ?? 'Your opponent';
  pushToUser(opponentId, `${resignedName} resigned${game.title ? ` in ${game.title}` : ''}.`, game.id);
}

// A new remote game has no prior move for notifyOpponentOfMove to hang an
// "it's your turn" push off of — without this, the invited side never
// learns about it until they happen to open the app themselves.
function notifyOfInvite(inviterId: string, invitedId: string, gameId: string, title: string | null): void {
  const inviterName = getUsername(inviterId) ?? 'Someone';
  pushToUser(invitedId, `${inviterName} invited you to a game${title ? ` — ${title}` : ''}.`, gameId);
}

function isStarred(gameId: string, userId: string | null): boolean {
  if (!userId) {
    return false;
  }
  return db
    .prepare('SELECT 1 FROM stars WHERE user_id = ? AND game_id = ?')
    .get(userId, gameId) !== undefined;
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
  const result = `${winnerLabel} wins on time`;
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

// The only board sizes the app actually supports — derived from
// STAR_POINTS so there's one source of truth, and used to validate
// client-supplied `size` on game creation (see POST /api/games).
const ALLOWED_BOARD_SIZES = Object.keys(STAR_POINTS).map(Number);

// Komi values that support correct classic scoring for an even (no
// handicap) game: 6.5/5.5 for area/territory rulesets that use a
// half-point komi to avoid ties, 0.5 for a minimal tie-breaker, and 0 for
// the no-komi classical rule.
const ALLOWED_KOMI_EVEN = [0, 0.5, 5.5, 6.5];

// A handicap game's stones are the real compensation, so komi there is
// only ever a tie-breaker: the standard 0.5, or 0 for no tie-breaker at all.
const ALLOWED_KOMI_HANDICAP = [0, 0.5];

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

// The most recent stone placed, for the live board's "last move" marker —
// review mode already gets this per-move from the history endpoint, but the
// live view has no reason to load the whole history just for this.
function getLastMovePoint(gameId: string): Point | null {
  const row = db.prepare(`
    SELECT payload FROM events WHERE game_id = ? AND event_type = 'MOVE'
    ORDER BY move_number DESC LIMIT 1
  `).get(gameId) as { payload: string } | undefined;

  if (!row) {
    return null;
  }
  const payload = JSON.parse(row.payload) as { x: number; y: number };
  return { x: payload.x, y: payload.y };
}

interface LastEvent {
  eventType: string;
  color: Color | null;
  point: Point | null;
  capturedPoints: Point[];
}

// The single most recent event of any type (move, pass, resign, handicap),
// for narrating live play to screen readers — unlike getLastMovePoint,
// this isn't limited to MOVE events, so a pass after the last stone is
// still reflected here.
function getLastEvent(gameId: string): LastEvent | null {
  const row = db.prepare(`
    SELECT event_type, payload FROM events WHERE game_id = ?
    ORDER BY move_number DESC LIMIT 1
  `).get(gameId) as { event_type: string; payload: string } | undefined;

  if (!row) {
    return null;
  }
  const payload = JSON.parse(row.payload) as {
    color?: Color;
    x?: number;
    y?: number;
    capturedPoints?: Point[];
  };
  return {
    eventType: row.event_type,
    color: payload.color ?? null,
    point:
      row.event_type === 'MOVE' && payload.x !== undefined && payload.y !== undefined
        ? { x: payload.x, y: payload.y }
        : null,
    capturedPoints: payload.capturedPoints ?? [],
  };
}

// Whether there's a player action to undo at all — false at the very start
// of a game, where the only event so far (if any) is the handicap setup.
function hasUndoableEvent(gameId: string): boolean {
  const lastEvent = db.prepare(`
    SELECT event_type FROM events WHERE game_id = ? ORDER BY move_number DESC LIMIT 1
  `).get(gameId) as { event_type: string } | undefined;

  return lastEvent !== undefined && lastEvent.event_type !== 'HANDICAP';
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

const SGF_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function toSgfCoord(x: number, y: number): string {
  return `${SGF_LETTERS[x]}${SGF_LETTERS[y]}`;
}

function escapeSgfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

// Parses our own free-text `result` strings (see applyResignToGame,
// withTimeoutCheck, and the finalize-scoring handler) back into the
// standard SGF RE[] convention (e.g. "B+R", "W+T", "B+6.5") — there's no
// structured winner/margin stored separately, only the composed sentence.
function deriveSgfResult(game: Pick<GameRow, 'result' | 'end_reason'>): string | null {
  if (!game.result) {
    return null;
  }
  if (game.end_reason === 'resign') {
    const match = /^(Black|White) resigned/.exec(game.result);
    return match ? `${match[1] === 'Black' ? 'W' : 'B'}+R` : null;
  }
  if (game.end_reason === 'timeout') {
    const match = /^(Black|White) wins on time/.exec(game.result);
    return match ? `${match[1] === 'Black' ? 'B' : 'W'}+T` : null;
  }
  if (game.end_reason === 'scoring') {
    const match = /^(Black|White) wins by ([\d.]+)/.exec(game.result);
    return match ? `${match[1] === 'Black' ? 'B' : 'W'}+${match[2]}` : null;
  }
  return null;
}

// Backs the profile page's games played/won/lost — reuses deriveSgfResult
// (the same free-text result parsing the SGF export already relies on)
// rather than storing a separate structured winner column. A finished game
// with no determinable winner (manually ended, no result) counts toward
// played but neither won nor lost. Local games (same user as both colors)
// are excluded entirely — only remote and vs-computer games count.
function getUserStats(userId: string): { played: number; won: number; lost: number } {
  const rows = db
    .prepare(
      `SELECT black_user_id, white_user_id, result, end_reason
       FROM games
       WHERE status = 'finished' AND black_user_id != white_user_id AND (black_user_id = ? OR white_user_id = ?)`,
    )
    .all(userId, userId) as Pick<GameRow, 'black_user_id' | 'white_user_id' | 'result' | 'end_reason'>[];

  let played = 0;
  let won = 0;
  let lost = 0;
  for (const row of rows) {
    played += 1;
    const sgfResult = deriveSgfResult(row);
    if (!sgfResult) {
      continue;
    }
    const winnerIsBlack = sgfResult.startsWith('B');
    if (winnerIsBlack ? row.black_user_id === userId : row.white_user_id === userId) {
      won += 1;
    } else if (winnerIsBlack ? row.white_user_id === userId : row.black_user_id === userId) {
      lost += 1;
    }
  }
  return { played, won, lost };
}

// Each player's own point total for a scored finish (e.g. "White wins by
// 6.5 (B: 0, W: 6.5)" -> { black: 0, white: 6.5 }) — parsed from the same
// sentence rather than stored separately. Resignation/timeout finishes
// have no per-player point total, so this is scoring-only.
function deriveScoreBreakdown(game: GameRow): { black: number; white: number } | null {
  if (!game.result || game.end_reason !== 'scoring') {
    return null;
  }
  const match = /\(B: ([\d.]+), W: ([\d.]+)\)/.exec(game.result);
  return match ? { black: Number(match[1]), white: Number(match[2]) } : null;
}

// Handicap stones are SGF setup properties (AB[]) on the root node, not
// moves — the real move sequence starts with White, same as in the app.
function generateSgf(game: GameRow): string {
  const events = db.prepare(`
    SELECT event_type, payload FROM events WHERE game_id = ? ORDER BY move_number ASC
  `).all(game.id) as { event_type: string; payload: string }[];

  const rootProps = ['GM[1]', 'FF[4]', 'CA[UTF-8]', `SZ[${game.size}]`, `KM[${resolveKomi(game)}]`];
  if (game.handicap > 0) {
    rootProps.push(`HA[${game.handicap}]`);
  }
  if (game.title) {
    rootProps.push(`GN[${escapeSgfText(game.title)}]`);
  }
  const blackName = getUsername(game.black_user_id);
  const whiteName = getUsername(game.white_user_id);
  if (blackName) {
    rootProps.push(`PB[${escapeSgfText(blackName)}]`);
  }
  if (whiteName) {
    rootProps.push(`PW[${escapeSgfText(whiteName)}]`);
  }
  const re = deriveSgfResult(game);
  if (re) {
    rootProps.push(`RE[${re}]`);
  }

  let moveNodes = '';
  for (const event of events) {
    const payload = JSON.parse(event.payload) as {
      color?: Color;
      x?: number;
      y?: number;
      points?: [number, number][];
    };
    if (event.event_type === 'HANDICAP' && payload.points) {
      const stones = payload.points.map(([x, y]) => `[${toSgfCoord(x, y)}]`).join('');
      rootProps.push(`AB${stones}`);
    } else if (event.event_type === 'MOVE' && payload.color && payload.x !== undefined && payload.y !== undefined) {
      moveNodes += `;${payload.color === 'black' ? 'B' : 'W'}[${toSgfCoord(payload.x, payload.y)}]`;
    } else if (event.event_type === 'PASS' && payload.color) {
      moveNodes += `;${payload.color === 'black' ? 'B' : 'W'}[]`;
    }
    // RESIGN adds no move node — it's already reflected in RE[] above.
  }

  return `(;${rootProps.join('')}${moveNodes})`;
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

  const nextColor = getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap));
  notifyOpponentOfMove(game, color, nextColor);

  return {
    ok: true,
    result: {
      board: newBoard,
      moveNumber,
      capturedPoints,
      nextColor,
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
  notifyOpponentOfResign(game, color);

  return gameResult;
}

// Lower level = faster and weaker (GNU Go's own description) — the main
// lever against the deep-reading blowups that make some positions slow.
// Trading some strength for reliability by default; both tunable without a
// code change if you want to dial strength back up (more hang risk) or
// down further (less).
const GNUGO_LEVEL = Number(process.env.GNUGO_LEVEL) || 5;
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
    komi: resolveKomi(game),
    moves: getReplayMoves(game.id),
    colorToMove: currentColor,
  };
  // Per-game difficulty, chosen at creation time — falls back to the
  // server's own default when the game predates this setting or didn't
  // specify one.
  const configuredLevel = game.gnugo_level ?? GNUGO_LEVEL;

  // Never a random move: on a timeout, step the level down by one (not
  // straight to the floor) and try again with a shorter budget — still a
  // genuine GNU Go move, just one step faster and weaker each time, which
  // is also progressively less likely to hit the same reading blowup
  // again. ai_current_level is updated (and broadcast) before every
  // attempt, so a human watching the board sees the backoff happen live
  // rather than a silent difficulty change. If level 1 itself fails, the
  // game is left waiting rather than forcing a move through — the human
  // can still Undo and play something else in the meantime.
  let level = configuredLevel;
  let aiResult: AiMoveResult;
  for (;;) {
    setAiCurrentLevel(game.id, level);
    try {
      aiResult =
        level === configuredLevel
          ? await generateAiMove({ ...baseRequest, level })
          : await generateAiMove({ ...baseRequest, level }, GNUGO_RETRY_TIMEOUT_MS);
      break;
    } catch (err) {
      if (level <= 1) {
        console.error(`GNU Go (level ${level}) failed to respond (${(err as Error).message}) — giving up for now.`);
        return;
      }
      console.error(
        `GNU Go (level ${level}) failed to respond (${(err as Error).message}) — retrying at level ${level - 1}.`,
      );
      level -= 1;
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
const MAX_USERNAME_LENGTH = 12;
const MIN_PASSWORD_LENGTH = 6;
// Generous but bounded — an unbounded password lets a client force
// expensive scrypt hashing over an arbitrarily large string on every
// register/login attempt.
const MAX_PASSWORD_LENGTH = 128;

app.post('/api/auth/register', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
    res.status(400).json({ error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters` });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters` });
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

// Standard login-throttling values (express-rate-limit's own canonical
// example, matching common OWASP-style guidance): 5 attempts per 15
// minutes per IP, to slow down password brute-forcing.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again later.' },
});

app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  // Reject oversized input before it ever reaches a DB lookup or a scrypt
  // hash comparison — a valid credential can never be this long anyway.
  if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

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

// The "Accept invitations" toggle — the only self-service account setting
// besides the password, hence living under /api/auth rather than needing a
// dedicated settings resource for just one field.
app.patch('/api/auth/me', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const acceptsInvitations = req.body?.acceptsInvitations;
  if (typeof acceptsInvitations !== 'boolean') {
    res.status(400).json({ error: 'acceptsInvitations must be a boolean' });
    return;
  }
  db.prepare('UPDATE users SET accepts_invitations = ? WHERE id = ?').run(acceptsInvitations ? 1 : 0, user.id);
  res.status(204).end();
});

// Requires the current password (not just a valid session) before setting
// a new one — same defense as any "change password" flow, since a session
// cookie alone (left logged in on a shared/unlocked device, say) shouldn't
// be enough to lock the real owner out.
app.post('/api/auth/password', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

  if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters` });
    return;
  }

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  res.json({ success: true });
});

// A 1-2 character query is too short to search the whole user base
// usefully (way too many matches), but is exactly enough to jog a memory
// of "who did I just play" — so under 3 characters, search is narrowed to
// opponents from games active within this window instead. Approximated as
// 90 days rather than exact calendar months, which would need actual date
// arithmetic for a distinction nobody would notice.
const RECENT_OPPONENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Backs the new-game form's opponent-username autocomplete. Registered
// before /api/users/:id so "search" doesn't get swallowed as an :id value.
// % and _ are escaped since usernames have no charset restriction beyond
// length — an unescaped one would otherwise act as a SQL LIKE wildcard.
app.get('/api/users/search', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    res.json([]);
    return;
  }
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  const pattern = `${escaped}%`;
  const aiId = getAiUserId();

  // accepts_invitations = 1 OR id = ? (self) so someone who's opted out
  // still finds themself — they're just invisible to everyone else. The
  // AI needs no such exception: its row defaults to accepts_invitations =
  // 1 and nothing ever changes it.
  if (query.length >= 3) {
    const rows = db
      .prepare(
        `SELECT id, username FROM users
         WHERE username LIKE ? ESCAPE '\\' AND (accepts_invitations = 1 OR id = ?)
         ORDER BY username LIMIT 10`,
      )
      .all(pattern, user.id) as { id: string; username: string }[];
    res.json(rows.map((row) => ({ username: row.username, isAi: row.id === aiId })));
    return;
  }

  const opponentRows = db
    .prepare(
      `SELECT DISTINCT u.id, u.username
       FROM games g
       JOIN users u ON u.id = CASE WHEN g.black_user_id = ? THEN g.white_user_id ELSE g.black_user_id END
       WHERE (g.black_user_id = ? OR g.white_user_id = ?)
         AND g.black_user_id != g.white_user_id
         AND g.updated_at >= ?
         AND u.username LIKE ? ESCAPE '\\'
         AND u.accepts_invitations = 1
       ORDER BY u.username
       LIMIT 10`,
    )
    .all(user.id, user.id, user.id, Date.now() - RECENT_OPPONENT_WINDOW_MS, pattern) as {
    id: string;
    username: string;
  }[];

  const results = opponentRows.map((row) => ({ username: row.username, isAi: row.id === aiId }));
  // A "me" shortcut on top of the recent-opponents list: typing "m"/"me"
  // (a prefix of the literal word "me") or a prefix of your own username
  // surfaces yourself first — you're never a "recent opponent" of your
  // own games, so the query above alone would never suggest you.
  const lowerQuery = query.toLowerCase();
  if ('me'.startsWith(lowerQuery) || user.username.toLowerCase().startsWith(lowerQuery)) {
    results.unshift({ username: user.username, isAi: false });
  }
  res.json(results);
});

// A profile page (web /profile/:id, iOS's Account tab and the same path as
// a universal link) — any logged-in user can look up any other user's
// public info by id, not just their own. The users table only has
// username and created_at beyond the id/password hash, so that's all this
// returns. acceptsInvitations is harmless to expose publicly (more a "do
// not disturb" flag than sensitive data) — returning it here means the
// profile page can show/edit it without a separate endpoint.
app.get('/api/users/:id', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const row = db
    .prepare('SELECT id, username, created_at, accepts_invitations FROM users WHERE id = ?')
    .get(req.params.id) as
    | { id: string; username: string; created_at: number; accepts_invitations: number }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const stats = getUserStats(row.id);
  res.json({
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    acceptsInvitations: row.accepts_invitations === 1,
    gamesPlayed: stats.played,
    gamesWon: stats.won,
    gamesLost: stats.lost,
  });
});

// Registers (or re-registers) an iOS device's APNs token against the
// logged-in user, so notifyOpponentOfMove knows where to push "it's your
// turn". A token is re-assigned to whichever user last registered it,
// covering both a reinstall and a shared device switching accounts.
app.post('/api/device-tokens', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const token = req.body?.token;
  if (typeof token !== 'string' || token.length === 0) {
    res.status(400).json({ error: 'Invalid device token' });
    return;
  }

  db.prepare(`
    INSERT INTO device_tokens (token, user_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at
  `).run(token, user.id, Date.now());

  res.status(204).end();
});

// A quick way to answer "did my device actually register a push token?"
// without needing device console access — registration itself is silent
// on success (see the iOS AppDelegate), so this is otherwise unobservable
// short of reading the games DB directly.
app.get('/api/device-tokens/mine', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM device_tokens WHERE user_id = ?').get(user.id) as {
    count: number;
  };
  res.json({ registered: row.count > 0, count: row.count });
});

// Pairs with the endpoint above: confirms whether *this running process*
// currently has all five APNS_* env vars loaded, without exposing their
// values — the two most common setup mistakes (a pm2 restart that didn't
// pick up an edited env file, or a var name typo) are otherwise invisible
// until a push silently no-ops.
app.get('/api/apns-status', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  res.json({ configured: isApnsConfigured() });
});

// Backs the new-game form's handicap/level auto-fill: given an opponent
// (by username, or the reserved AI account via `ai=1`), find the most
// recent game against that same opponent and return its handicap/gnugo
// level — or null if there's no prior game to base a prefill on. Reuses
// the exact username→id resolution POST /api/games's remote branch uses,
// so "no such user" behaves identically in both places.
app.get('/api/games/recent-vs', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  let opponentId: string;
  if (req.query.ai === '1') {
    opponentId = getAiUserId();
  } else {
    const opponentUsername = typeof req.query.opponentUsername === 'string' ? req.query.opponentUsername.trim() : '';
    if (!opponentUsername) {
      res.status(400).json({ error: 'opponentUsername or ai is required' });
      return;
    }
    const opponent = db.prepare('SELECT id FROM users WHERE username = ?').get(opponentUsername) as
      | { id: string }
      | undefined;
    if (!opponent) {
      res.status(404).json({ error: `No user named "${opponentUsername}"` });
      return;
    }
    opponentId = opponent.id;
  }

  const row = db
    .prepare(
      `SELECT handicap, gnugo_level FROM games
       WHERE (black_user_id = ? AND white_user_id = ?) OR (black_user_id = ? AND white_user_id = ?)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(user.id, opponentId, opponentId, user.id) as { handicap: number; gnugo_level: number | null } | undefined;

  res.json(row ? { handicap: row.handicap, gnugoLevel: row.gnugo_level } : null);
});

app.get('/api/games', (req, res) => {
  const currentUser = getSessionUser(req);
  // "mine" is meaningless without an identity to filter by — fall back to
  // the unfiltered list rather than showing an anonymous visitor nothing.
  const scope = req.query.scope === 'mine' && currentUser ? 'mine' : 'all';

  const ids = db.prepare('SELECT id FROM games ORDER BY updated_at DESC').all() as { id: string }[];
  let rows = ids.map((row) => withTimeoutCheck(getGameRow(row.id)!));

  if (scope === 'mine' && currentUser) {
    rows = rows.filter((row) => isParticipant(row, currentUser.id) || isStarred(row.id, currentUser.id));
  }

  // Pagination is opt-in via `limit` — omitting it (as the iOS app still
  // does) returns every matching game, exactly as before. When present, one
  // extra row beyond `limit` is included so the caller can tell whether
  // more pages remain (client/src/services/api.ts's listGames trims it off)
  // without needing a second response field or a page-count query.
  const limit = Number(req.query.limit);
  if (Number.isInteger(limit) && limit > 0) {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    rows = rows.slice(offset, offset + limit + 1);
  }

  res.json(rows.map((row) => ({
    id: row.id,
    size: row.size,
    status: row.status,
    result: row.result,
    // Standard-notation result (e.g. "B+2", "W+R") for the compact list
    // card — null for an unfinished game or one ended with no score.
    shortResult: deriveSgfResult(row),
    handicap: row.handicap,
    komi: resolveKomi(row),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blackUsername: getUsername(row.black_user_id),
    whiteUsername: getUsername(row.white_user_id),
    blackUserId: row.black_user_id,
    whiteUserId: row.white_user_id,
    myColor: getMyColor(row, currentUser?.id ?? null),
    isAiOpponent: isAiOpponentGame(row),
    gnugoLevel: row.gnugo_level,
    timeControl: row.time_control,
    starred: isStarred(row.id, currentUser?.id ?? null),
  })));
});

app.post('/api/games', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  // An unbounded size would let a client force an arbitrarily huge board
  // allocation (createEmptyBoard(size) is O(size^2)) — only the sizes the
  // client actually offers are valid, so anything else falls back to 19
  // rather than trusting the request.
  const requestedSize = Number(req.body?.size);
  const size = ALLOWED_BOARD_SIZES.includes(requestedSize) ? requestedSize : 19;
  // Handicap placement is only defined for boards with a known star-point layout
  const maxHandicap = size === 19 ? 9 : 5;
  const handicap = STAR_POINTS[size] ? Math.min(Math.max(0, Number(req.body?.handicap) || 0), maxHandicap) : 0;
  // A handicap game's komi is just a tie-breaker (0.5 or 0 — the handicap
  // stones are the real compensation); an even game picks from the values
  // that support correct classic scoring under each rule set. Anything
  // else the client sends falls back to the default for that case.
  const requestedKomi = Number(req.body?.komi);
  const allowedKomi = handicap > 0 ? ALLOWED_KOMI_HANDICAP : ALLOWED_KOMI_EVEN;
  const komi = allowedKomi.includes(requestedKomi) ? requestedKomi : handicap > 0 ? 0.5 : 6.5;
  const title = sanitizeTitle(req.body?.title);
  const timeControlName: TimeControlName = req.body?.timeControl === 'standard' || req.body?.timeControl === 'correspondence'
    ? req.body.timeControl
    : 'unlimited';
  const preset = resolveTimeControl(timeControlName);

  let blackUserId = user.id;
  let whiteUserId = user.id;
  let gnugoLevel: number | null = null;
  let invitedOpponentId: string | null = null;

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

    const opponent = db.prepare('SELECT id, accepts_invitations FROM users WHERE username = ?').get(opponentUsername) as
      | { id: string; accepts_invitations: number }
      | undefined;
    // Self-invite gets its own message regardless of the toggle — telling
    // someone their own account "isn't accepting invitations" would just
    // be confusing. A nonexistent username and an existing-but-opted-out
    // one deliberately share one message: distinguishing them would let
    // this endpoint be used to enumerate which usernames exist.
    if (opponent && opponent.id === user.id) {
      res.status(400).json({ error: 'Invite a different user, not yourself' });
      return;
    }
    if (!opponent || opponent.accepts_invitations !== 1) {
      res.status(400).json({ error: "Selected player isn't currently accepting invitations" });
      return;
    }

    const color = resolveColor(req.body.color);
    blackUserId = color === 'black' ? user.id : opponent.id;
    whiteUserId = color === 'white' ? user.id : opponent.id;
    invitedOpponentId = opponent.id;
  } else if (req.body?.mode === 'gnugo') {
    if (!(await isGnuGoAvailable())) {
      res.status(400).json({ error: 'GNU Go is not installed on the server — AI games are unavailable.' });
      return;
    }
    if (hasOpenAiGame()) {
      res.status(400).json({ error: 'GNU Go already has an open game — finish or delete it before starting another.' });
      return;
    }
    const color = resolveColor(req.body?.color);
    const aiId = getAiUserId();
    blackUserId = color === 'black' ? user.id : aiId;
    whiteUserId = color === 'white' ? user.id : aiId;

    const requestedLevel = Number(req.body?.level);
    if (Number.isInteger(requestedLevel) && requestedLevel >= 1 && requestedLevel <= 10) {
      gnugoLevel = requestedLevel;
    }
  }

  const id = randomUUID();
  const now = Date.now();
  const initialTimeMs = preset ? preset.mainTimeSeconds * 1000 : null;
  const initialPeriods = preset ? preset.byoyomiPeriods : null;

  db.prepare(`
    INSERT INTO games (
      id, size, handicap, title, created_at, updated_at, status, black_user_id, white_user_id,
      time_control, main_time_seconds, byoyomi_seconds, byoyomi_periods,
      black_time_remaining_ms, white_time_remaining_ms, black_periods_left, white_periods_left, turn_started_at,
      gnugo_level, komi, invited_user_id, invite_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, size, handicap, title, now, now, 'in_progress', blackUserId, whiteUserId,
    preset ? timeControlName : null,
    preset ? preset.mainTimeSeconds : null,
    preset ? preset.byoyomiSeconds : null,
    initialPeriods,
    // A pending invite hasn't started yet from the invited player's point of
    // view — turn_started_at stays NULL (computeLiveClock/withTimeoutCheck
    // both already treat that as "frozen, not ticking") until respond-invite
    // accepts it, so no clock time (or timeout) accrues against either
    // player before they've actually agreed to play.
    initialTimeMs, initialTimeMs, initialPeriods, initialPeriods, invitedOpponentId ? null : now,
    gnugoLevel, komi,
    invitedOpponentId,
    invitedOpponentId ? 'pending' : null,
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

  if (invitedOpponentId) {
    notifyOfInvite(user.id, invitedOpponentId, id, title);
  }

  res.status(201).json({
    id,
    size,
    handicap,
    title,
    status: 'in_progress',
    board,
    blackUsername: getUsername(blackUserId),
    whiteUsername: getUsername(whiteUserId),
    blackUserId,
    whiteUserId,
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
    komi: resolveKomi(game),
    title: game.title,
    board,
    currentColor: getCurrentColor(turnMoveNumber(moveNumber, game.handicap)),
    captures: getCumulativeCaptures(game.id),
    lastMove: getLastMovePoint(game.id),
    // For screen readers: a describable record of whatever happened most
    // recently (move/pass/resign), independent of the stone-marker-only
    // lastMove above.
    lastEvent: getLastEvent(game.id),
    // Standard-notation result (e.g. "W+6.5", "B+R") — same derivation the
    // SGF export uses, for a compact footer display next to the longer
    // free-text `result` sentence shown under the board.
    shortResult: deriveSgfResult(game),
    resultBreakdown: deriveScoreBreakdown(game),
    canUndo: hasUndoableEvent(game.id),
    blackUsername: getUsername(game.black_user_id),
    whiteUsername: getUsername(game.white_user_id),
    blackUserId: game.black_user_id,
    whiteUserId: game.white_user_id,
    myColor: getMyColor(game, currentUser?.id ?? null),
    pendingInviteResponse: isPendingInviteFor(game, currentUser?.id ?? null),
    pendingUndoBy: game.pending_undo_by,
    endReason: game.end_reason,
    pendingReopenBy: game.pending_reopen_by,
    isAiOpponent: isAiOpponentGame(game),
    gnugoLevel: game.gnugo_level,
    aiCurrentLevel: game.ai_current_level,
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

// Anyone can star a game they're not playing in — it's how a game they're
// just watching ends up in their "my games" list alongside ones they're
// actually a player in.
app.post('/api/games/:id/star', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  db.prepare('INSERT OR IGNORE INTO stars (user_id, game_id, created_at) VALUES (?, ?, ?)').run(
    user.id,
    game.id,
    Date.now(),
  );
  broadcastGamesListUpdate();

  res.json({ starred: true });
});

app.delete('/api/games/:id/star', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  db.prepare('DELETE FROM stars WHERE user_id = ? AND game_id = ?').run(user.id, game.id);
  broadcastGamesListUpdate();

  res.json({ starred: false });
});

app.get('/api/games/:id/history', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  res.json({ size: game.size, moves: getMoveHistory(game.id, game.size) });
});

// Mints a token an external board-vision service can use to submit moves
// for this one game (see isValidVisionToken) without a full player login.
app.post('/api/games/:id/vision-token', (req, res) => {
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
    res.status(403).json({ error: 'Only players in this game can create a vision token' });
    return;
  }

  const token = randomUUID();
  db.prepare('INSERT INTO vision_tokens (token, game_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    game.id,
    user.id,
    Date.now(),
  );

  res.status(201).json({ token });
});

// No auth required — same spectator model as viewing the game itself.
app.get('/api/games/:id/sgf', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const safeName = game.title?.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
  const filename = `${safeName || game.id}.sgf`;

  // application/x-go-sgf isn't a MIME type browsers recognize, which made
  // Chrome flag the download as an "unconfirmed"/potentially dangerous file
  // even though the header was present — text/plain is universally trusted
  // and SGF is plain text anyway.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(generateSgf(game));
});

// Shared by the plain delete route below and respond-invite's rejection —
// same effect either way: the game and everything recorded against it is
// gone.
function deleteGameRecord(gameId: string): void {
  db.prepare('DELETE FROM events WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM snapshots WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM stars WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
}

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

  deleteGameRecord(game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.status(204).end();
});

// Lets the invited side of a pending remote-game invite accept (just clears
// the pending flag — the game already plays normally either way) or reject
// (deletes the game outright, same as the plain delete route, plus a push
// telling the inviter it was declined — the invite's own push was the only
// sign they had of the game existing at all, so a silent deletion would
// otherwise look like it just vanished).
app.post('/api/games/:id/respond-invite', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isPendingInviteFor(game, user.id)) {
    res.status(400).json({ error: 'This game has no pending invitation for you' });
    return;
  }

  if (req.body?.accept === true) {
    // The clock (if any) starts counting from here, not from whenever the
    // invite was actually created — see the matching comment on the
    // INSERT in POST /api/games.
    db.prepare('UPDATE games SET invited_user_id = NULL, invite_status = NULL, turn_started_at = ? WHERE id = ?').run(
      Date.now(),
      game.id,
    );
    broadcastGameUpdate(game.id);
    res.json({ status: 'accepted' });
    return;
  }

  const inviterId = inviterIdFor(game);
  deleteGameRecord(game.id);
  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();
  if (inviterId) {
    const invitedName = getUsername(user.id) ?? 'The invited player';
    pushToUser(inviterId, `${invitedName} declined your invitation${game.title ? ` to ${game.title}` : ''}.`, game.id);
  }
  res.json({ status: 'rejected' });
});

// Dry-runs the same check applyMoveToGame does, without writing anything —
// the client's "confirm moves" setting uses this to show a move as valid
// (a placeable marker) or invalid (an immediate error) before the player
// actually commits it. This is the only way to include checks a client
// can't run on its own, like superko, which needs the full position
// history rather than just the current board.
app.post('/api/games/:id/moves/validate', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const visionAuthorized = isValidVisionToken(req, game.id);
  const user = visionAuthorized ? null : requireAuth(req, res);
  if (!visionAuthorized && !user) {
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
  if (!visionAuthorized && !canActAsColor(game, user!.id, color)) {
    res.status(403).json({ error: `You are not playing as ${color} in this game` });
    return;
  }

  const board = getCurrentBoard(game.id, game.size);
  const history = getGameHistory(game.id, game.size, game.handicap);
  const moveNumber = getNextMoveNumber(game.id);
  const validation = validateMove(board, { x, y }, color, turnMoveNumber(moveNumber, game.handicap), history);

  res.json(validation.valid ? { valid: true } : { valid: false, error: validation.error });
});

app.post('/api/games/:id/moves', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const visionAuthorized = isValidVisionToken(req, game.id);
  const user = visionAuthorized ? null : requireAuth(req, res);
  if (!visionAuthorized && !user) {
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
  if (!visionAuthorized && !canActAsColor(game, user!.id, color)) {
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

// Validates an arbitrary request body value as a Point[] on this game's
// board — anything malformed or out of bounds is silently dropped rather
// than rejecting the whole request, same tolerance finalize-scoring already
// had for deadPoints before this was pulled out to also validate sekiPoints.
function parsePointArray(value: unknown, size: number): Point[] {
  const raw: unknown[] = Array.isArray(value) ? value : [];
  return raw
    .map((p: unknown) => (p && typeof p === 'object' ? (p as { x: unknown; y: unknown }) : null))
    .filter((p: { x: unknown; y: unknown } | null): p is { x: unknown; y: unknown } => p !== null)
    .map((p: { x: unknown; y: unknown }) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter(
      (p: Point) => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < size && p.y >= 0 && p.y < size,
    );
}

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

  const deadPoints = parsePointArray(req.body?.deadPoints, game.size);
  // A group a player has directly declared to be in seki (a separate
  // scoring action from marking it dead) — these stay on the board, not
  // removed, but score nothing for either side. See scoreBoard/
  // findDeclaredSekiRegions in shared for how marking one side is enough.
  const sekiPoints = parsePointArray(req.body?.sekiPoints, game.size);

  const board = getCurrentBoard(game.id, game.size);
  const { board: effectiveBoard, captures: adjustedCaptures } = applyDeadStones(
    board,
    getCumulativeCaptures(game.id),
    deadPoints,
  );

  const score = scoreBoard(effectiveBoard, adjustedCaptures, resolveKomi(game), sekiPoints);
  const winnerLabel = score.winner === 'black' ? 'Black' : 'White';
  // No komi means every count involved is a whole number — showing a
  // trailing ".0" there would be noise rather than precision.
  const marginLabel = Number.isInteger(score.margin) ? String(score.margin) : score.margin.toFixed(1);
  const gameResult = `${winnerLabel} wins by ${marginLabel} (B: ${score.black}, W: ${score.white})`;

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
    res.status(403).json({ error: 'Only players in this game can reopen scoring' });
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
    SELECT move_number, event_type, payload FROM events WHERE game_id = ?
    ORDER BY move_number DESC LIMIT 1
  `).get(game.id) as { move_number: number; event_type: string; payload: string } | undefined;

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
  const moveNumbersToDelete = [lastEvent.move_number];

  // If GNU Go already answered the human's move before Undo was clicked —
  // a real race, since maybeTriggerAiMove fires immediately after every
  // move — a plain "undo the last event" would only remove GNU Go's reply
  // and leave the human's own move in place. Undo both together instead,
  // landing back at the human's own turn, which is what they actually
  // wanted to reconsider.
  if (isAiOpponentGame(game) && lastEvent.event_type === 'MOVE') {
    const aiId = getAiUserId();
    const aiColor: Color = game.black_user_id === aiId ? 'black' : 'white';
    const lastColor = (JSON.parse(lastEvent.payload) as { color?: Color }).color;

    if (lastColor === aiColor) {
      const precedingEvent = db.prepare(`
        SELECT event_type FROM events WHERE game_id = ? AND move_number = ?
      `).get(game.id, lastEvent.move_number - 1) as { event_type: string } | undefined;

      // Don't reach past the human's very first move into the handicap setup.
      if (precedingEvent && precedingEvent.event_type !== 'HANDICAP') {
        moveNumbersToDelete.push(lastEvent.move_number - 1);
      }
    }
  }

  for (const moveNumber of moveNumbersToDelete) {
    db.prepare('DELETE FROM events WHERE game_id = ? AND move_number = ?').run(game.id, moveNumber);
    db.prepare('DELETE FROM snapshots WHERE game_id = ? AND move_number = ?').run(game.id, moveNumber);
  }
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

// Immediately finishes a local game with no formal result — only makes
// sense for a game the caller plays entirely alone (black_user_id and
// white_user_id both their own id), since anyone else in the game would
// have no say in ending it this way.
app.post('/api/games/:id/end', (req, res) => {
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
  if (game.status === 'finished') {
    res.status(400).json({ error: 'Game is already finished' });
    return;
  }
  if (game.black_user_id !== user.id || game.white_user_id !== user.id) {
    res.status(403).json({ error: 'Only a local game can be ended this way' });
    return;
  }

  const now = Date.now();
  db.prepare('UPDATE games SET status = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', 'ended', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ status: 'finished', result: null });
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

// Optional — only starts when HTTPS_PORT/KEY_PATH/CERT_PATH are all set and
// the cert files actually exist, so local dev without certs isn't affected.
if (httpsPort && keyPath && certPath) {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const httpsServer = createHttpsServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      app,
    );
    attachWebSocketServer(httpsServer);
    httpsServer.listen(Number(httpsPort), () => {
      console.log(`HTTPS server running on port ${httpsPort}`);
    });
  } else {
    console.warn(`KEY_PATH/CERT_PATH set but not found at ${keyPath} / ${certPath} — skipping HTTPS server.`);
  }
}
