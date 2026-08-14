import express from 'express';
import db from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createEmptyBoard, getCurrentColor, hashBoard, scoreBoard, validateMove, } from 'shared';
import { dbPath, port } from './config.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
    `).run('perm-test', 1, 'TEST', JSON.stringify({ ok: true }), Date.now());
        res.json({ ok: true });
    }
    catch (error) {
        res.json({ error });
    }
});
function getGameRow(id) {
    return db.prepare('SELECT id, size, status, result, handicap, title FROM games WHERE id = ?').get(id);
}
const MAX_TITLE_LENGTH = 100;
function sanitizeTitle(rawTitle) {
    if (typeof rawTitle !== 'string') {
        return null;
    }
    const trimmed = rawTitle.trim().slice(0, MAX_TITLE_LENGTH);
    return trimmed.length > 0 ? trimmed : null;
}
const STAR_POINTS = {
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
function getHandicapPoints(size, handicap) {
    const sp = STAR_POINTS[size];
    if (!sp || handicap < 2) {
        return [];
    }
    const corners = [sp.upperRight, sp.lowerLeft, sp.lowerRight, sp.upperLeft];
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
function turnMoveNumber(moveNumber, handicap) {
    return handicap >= 2 ? moveNumber + 1 : moveNumber;
}
// The next move number is tracked via `events` (which logs every action,
// including passes/resigns), while the board only reflects actual stone
// placements — so a pass must still advance the turn without touching it.
function getNextMoveNumber(gameId) {
    const row = db.prepare(`
    SELECT MAX(move_number) as maxMoveNumber FROM events WHERE game_id = ?
  `).get(gameId);
    return (row.maxMoveNumber ?? 0) + 1;
}
function getCurrentBoard(gameId, size) {
    const row = db.prepare(`
    SELECT state FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number DESC
    LIMIT 1
  `).get(gameId);
    return row ? JSON.parse(row.state) : createEmptyBoard(size);
}
// Every position the game has passed through so far, for the situational
// superko check. Hashes come straight from the `snapshots.hash` column
// (computed once at write time) rather than being recomputed here.
function getGameHistory(gameId, size, handicap) {
    const rows = db.prepare(`
    SELECT move_number, state, hash FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId);
    const history = [];
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
            board: JSON.parse(row.state),
            hash: row.hash,
            nextColor: getCurrentColor(turnMoveNumber(row.move_number + 1, handicap)),
        });
    }
    return history;
}
// Standard Japanese-rules komi: 6.5 for an even game, 0.5 for a handicap
// game (just enough to avoid a tie — Black's handicap stones are the real
// compensation there).
function getKomi(handicap) {
    return handicap >= 2 ? 0.5 : 6.5;
}
function getLastEventType(gameId, moveNumber) {
    const row = db.prepare(`
    SELECT event_type FROM events WHERE game_id = ? AND move_number = ?
  `).get(gameId, moveNumber);
    return row?.event_type;
}
// Cumulative stones each color has captured over the whole game so far,
// derived fresh from the event log rather than tracked separately — the
// event log is already the source of truth for what each move captured.
function getCumulativeCaptures(gameId) {
    const rows = db.prepare(`
    SELECT payload FROM events WHERE game_id = ? AND event_type = 'MOVE'
  `).all(gameId);
    const captures = { black: 0, white: 0 };
    for (const row of rows) {
        const payload = JSON.parse(row.payload);
        const count = payload.capturedPoints?.length ?? 0;
        if (payload.color === 'black') {
            captures.black += count;
        }
        else if (payload.color === 'white') {
            captures.white += count;
        }
    }
    return captures;
}
// The full move-by-move record for the "review" feature: every event the
// game has logged, paired with the board as it stood right after. Passes
// and resigns don't have their own snapshot, so their board is carried
// forward from the last actual placement.
function getMoveHistory(gameId, size) {
    const events = db.prepare(`
    SELECT move_number, event_type, payload FROM events
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId);
    const snapshotRows = db.prepare(`
    SELECT move_number, state FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId);
    const boardByMove = new Map();
    for (const row of snapshotRows) {
        boardByMove.set(row.move_number, JSON.parse(row.state));
    }
    const history = [];
    let lastBoard = createEmptyBoard(size);
    // Handicap games log their setup as move 0; plain games start from an
    // empty board that was never itself written to a row.
    if (events.length === 0 || events[0].move_number !== 0) {
        history.push({ moveNumber: 0, board: lastBoard, eventType: 'START', color: null, point: null, capturedPoints: [] });
    }
    for (const event of events) {
        const payload = JSON.parse(event.payload);
        const board = boardByMove.get(event.move_number) ?? lastBoard;
        lastBoard = board;
        history.push({
            moveNumber: event.move_number,
            board,
            eventType: event.event_type,
            color: payload.color ?? null,
            point: event.event_type === 'MOVE' && payload.x !== undefined && payload.y !== undefined
                ? { x: payload.x, y: payload.y }
                : null,
            capturedPoints: payload.capturedPoints ?? [],
        });
    }
    return history;
}
app.get('/api/games', (req, res) => {
    const rows = db.prepare(`
    SELECT id, size, status, result, handicap, title, created_at, updated_at FROM games
    ORDER BY updated_at DESC
  `).all();
    res.json(rows.map((row) => ({
        id: row.id,
        size: row.size,
        status: row.status,
        result: row.result,
        handicap: row.handicap,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    })));
});
app.post('/api/games', (req, res) => {
    const size = Number(req.body?.size) || 19;
    // Handicap placement is only defined for boards with a known star-point layout
    const handicap = STAR_POINTS[size] ? Math.max(0, Number(req.body?.handicap) || 0) : 0;
    const title = sanitizeTitle(req.body?.title);
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
    INSERT INTO games (id, size, handicap, title, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, size, handicap, title, now, now, 'in_progress');
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
    res.status(201).json({ id, size, handicap, title, status: 'in_progress', board });
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
        title: game.title,
        board,
        currentColor: getCurrentColor(turnMoveNumber(moveNumber, game.handicap)),
        captures: getCumulativeCaptures(game.id),
    });
});
app.patch('/api/games/:id', (req, res) => {
    const game = getGameRow(req.params.id);
    if (!game) {
        res.status(404).json({ error: 'Game not found' });
        return;
    }
    const title = sanitizeTitle(req.body?.title);
    db.prepare('UPDATE games SET title = ? WHERE id = ?').run(title, game.id);
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
    const history = getGameHistory(game.id, game.size, game.handicap);
    const moveNumber = getNextMoveNumber(game.id);
    const result = validateMove(board, { x, y }, color, turnMoveNumber(moveNumber, game.handicap), history);
    if (!result.valid) {
        res.status(400).json({ error: result.error });
        return;
    }
    const newBoard = result.board;
    const capturedPoints = result.capturedPoints;
    const now = Date.now();
    db.prepare(`
    INSERT INTO snapshots (game_id, move_number, state, hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, JSON.stringify(newBoard), result.hash, now);
    db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'MOVE', JSON.stringify({ x, y, color, capturedPoints }), now);
    db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(now, game.id);
    res.json({
        board: newBoard,
        moveNumber,
        capturedPoints,
        nextColor: getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap)),
        captures: getCumulativeCaptures(game.id),
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
    // Two consecutive passes end the game — score the final position
    const previousEventType = getLastEventType(game.id, moveNumber - 1);
    const status = previousEventType === 'PASS' ? 'finished' : 'in_progress';
    let gameResult = null;
    if (status === 'finished') {
        const board = getCurrentBoard(game.id, game.size);
        const score = scoreBoard(board, getCumulativeCaptures(game.id), getKomi(game.handicap));
        const winnerLabel = score.winner === 'black' ? 'Black' : 'White';
        gameResult = `${winnerLabel} wins by ${score.margin.toFixed(1)} (B: ${score.black}, W: ${score.white})`;
    }
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
