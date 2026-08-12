import express from 'express';
import db from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  createEmptyBoard,
  getCurrentColor,
  validateMove,
  type Board,
} from 'shared';

import { dbPath, port } from './config.js';

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
}

function getGameRow(id: string): GameRow | undefined {
  return db.prepare('SELECT id, size, status, result, handicap FROM games WHERE id = ?').get(id) as
    | GameRow
    | undefined;
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

function getLastEventType(gameId: string, moveNumber: number): string | undefined {
  const row = db.prepare(`
    SELECT event_type FROM events WHERE game_id = ? AND move_number = ?
  `).get(gameId, moveNumber) as { event_type: string } | undefined;

  return row?.event_type;
}

interface GameListRow {
  id: string;
  size: number;
  status: string;
  result: string | null;
  handicap: number;
  created_at: number;
  updated_at: number;
}

app.get('/api/games', (req, res) => {
  const rows = db.prepare(`
    SELECT id, size, status, result, handicap, created_at, updated_at FROM games
    ORDER BY updated_at DESC
  `).all() as GameListRow[];

  res.json(rows.map((row) => ({
    id: row.id,
    size: row.size,
    status: row.status,
    result: row.result,
    handicap: row.handicap,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })));
});

app.post('/api/games', (req, res) => {
  const size = Number(req.body?.size) || 19;
  // Handicap placement is only defined for boards with a known star-point layout
  const handicap = STAR_POINTS[size] ? Math.max(0, Number(req.body?.handicap) || 0) : 0;
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO games (id, size, handicap, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, size, handicap, now, now, 'in_progress');

  const board = createEmptyBoard(size);
  const handicapPoints = getHandicapPoints(size, handicap);
  for (const [x, y] of handicapPoints) {
    board[y][x] = 'black';
  }

  if (handicapPoints.length > 0) {
    db.prepare(`
      INSERT INTO snapshots (game_id, move_number, state, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, 0, JSON.stringify(board), now);

    db.prepare(`
      INSERT INTO events (game_id, move_number, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 0, 'HANDICAP', JSON.stringify({ handicap, points: handicapPoints }), now);
  }

  res.status(201).json({ id, size, handicap, status: 'in_progress', board });
});

app.get('/api/games/:id', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const board = getCurrentBoard(game.id, game.size);
  const moveNumber = getNextMoveNumber(game.id);

  res.json({
    id: game.id,
    size: game.size,
    status: game.status,
    result: game.result,
    handicap: game.handicap,
    board,
    currentColor: getCurrentColor(turnMoveNumber(moveNumber, game.handicap)),
  });
});

app.delete('/api/games/:id', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  db.prepare('DELETE FROM events WHERE game_id = ?').run(game.id);
  db.prepare('DELETE FROM snapshots WHERE game_id = ?').run(game.id);
  db.prepare('DELETE FROM games WHERE id = ?').run(game.id);

  res.status(204).end();
});

app.post('/api/games/:id/moves', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  if (game.status !== 'in_progress') {
    res.status(400).json({ error: 'Game is already finished' });
    return;
  }

  const { x, y, color } = req.body ?? {};
  if (typeof x !== 'number' || typeof y !== 'number' || (color !== 'black' && color !== 'white')) {
    res.status(400).json({ error: 'Invalid move payload' });
    return;
  }

  const board = getCurrentBoard(game.id, game.size);
  const moveNumber = getNextMoveNumber(game.id);
  const result = validateMove(board, { x, y }, color, turnMoveNumber(moveNumber, game.handicap));
  if (!result.valid) {
    res.status(400).json({ error: result.error });
    return;
  }

  board[y][x] = color;
  const now = Date.now();

  db.prepare(`
    INSERT INTO snapshots (game_id, move_number, state, created_at)
    VALUES (?, ?, ?, ?)
  `).run(game.id, moveNumber, JSON.stringify(board), now);

  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'MOVE', JSON.stringify({ x, y, color }), now);

  db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(now, game.id);

  res.json({
    board,
    moveNumber,
    nextColor: getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap)),
  });
});

app.post('/api/games/:id/pass', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  if (game.status !== 'in_progress') {
    res.status(400).json({ error: 'Game is already finished' });
    return;
  }

  const { color } = req.body ?? {};
  if (color !== 'black' && color !== 'white') {
    res.status(400).json({ error: 'Invalid color' });
    return;
  }

  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  if (color !== currentColor) {
    res.status(400).json({ error: `It is ${currentColor}'s turn` });
    return;
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'PASS', JSON.stringify({ color }), now);

  // Two consecutive passes end the game
  const previousEventType = getLastEventType(game.id, moveNumber - 1);
  const status = previousEventType === 'PASS' ? 'finished' : 'in_progress';
  const gameResult = status === 'finished' ? 'Both players passed' : null;

  db.prepare('UPDATE games SET status = ?, result = ?, updated_at = ? WHERE id = ?')
    .run(status, gameResult, now, game.id);

  res.json({
    status,
    result: gameResult,
    nextColor: getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap)),
  });
});

app.post('/api/games/:id/resign', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  if (game.status !== 'in_progress') {
    res.status(400).json({ error: 'Game is already finished' });
    return;
  }

  const { color } = req.body ?? {};
  if (color !== 'black' && color !== 'white') {
    res.status(400).json({ error: 'Invalid color' });
    return;
  }

  const now = Date.now();
  const moveNumber = getNextMoveNumber(game.id);
  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'RESIGN', JSON.stringify({ color }), now);

  const gameResult = `${color === 'black' ? 'Black' : 'White'} resigned`;
  db.prepare('UPDATE games SET status = ?, result = ?, updated_at = ? WHERE id = ?')
    .run('finished', gameResult, now, game.id);

  res.json({ status: 'finished', result: gameResult });
});

// For React Router — serve index.html for all non-API routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../client/dist/index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}; db path: ${dbPath}`);
});
