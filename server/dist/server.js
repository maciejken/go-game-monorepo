import express from 'express';
import db from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createEmptyBoard, getCurrentColor, validateMove, } from 'shared';
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
    return db.prepare('SELECT id, size, status FROM games WHERE id = ?').get(id);
}
function getLatestState(gameId, size) {
    const row = db.prepare(`
    SELECT move_number, state FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number DESC
    LIMIT 1
  `).get(gameId);
    if (!row) {
        return { board: createEmptyBoard(size), moveNumber: 1 };
    }
    return { board: JSON.parse(row.state), moveNumber: row.move_number + 1 };
}
app.get('/api/games', (req, res) => {
    const rows = db.prepare(`
    SELECT id, size, status, created_at, updated_at FROM games
    ORDER BY updated_at DESC
  `).all();
    res.json(rows.map((row) => ({
        id: row.id,
        size: row.size,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    })));
});
app.post('/api/games', (req, res) => {
    const size = Number(req.body?.size) || 19;
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
    INSERT INTO games (id, size, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, size, now, now, 'in_progress');
    res.status(201).json({ id, size, status: 'in_progress', board: createEmptyBoard(size) });
});
app.get('/api/games/:id', (req, res) => {
    const game = getGameRow(req.params.id);
    if (!game) {
        res.status(404).json({ error: 'Game not found' });
        return;
    }
    const { board, moveNumber } = getLatestState(game.id, game.size);
    res.json({
        id: game.id,
        size: game.size,
        status: game.status,
        board,
        currentColor: getCurrentColor(moveNumber),
    });
});
app.post('/api/games/:id/moves', (req, res) => {
    const game = getGameRow(req.params.id);
    if (!game) {
        res.status(404).json({ error: 'Game not found' });
        return;
    }
    const { x, y, color } = req.body ?? {};
    if (typeof x !== 'number' || typeof y !== 'number' || (color !== 'black' && color !== 'white')) {
        res.status(400).json({ error: 'Invalid move payload' });
        return;
    }
    const { board, moveNumber } = getLatestState(game.id, game.size);
    const result = validateMove(board, { x, y }, color, moveNumber);
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
    res.json({ board, moveNumber, nextColor: getCurrentColor(moveNumber + 1) });
});
// For React Router — serve index.html for all non-API routes
app.get('/{*path}', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../client/dist/index.html'));
});
app.listen(port, () => {
    console.log(`Server running on port ${port}; db path: ${dbPath}`);
});
