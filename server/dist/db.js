import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { hashBoard } from 'shared';
import { dbPath } from './config.js';
// Ensure directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
// Open database
const db = new Database(dbPath);
// Enable WAL mode (best for Raspberry Pi)
db.pragma('journal_mode = WAL');
// Recommended for Pi: good balance of safety + speed
db.pragma('synchronous = NORMAL');
// Optional: reduce fragmentation
db.pragma('auto_vacuum = FULL');
// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    move_number INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    game_id TEXT NOT NULL,
    move_number INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, move_number)
  );

  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- A user expressing interest in a game they're not playing in, so it
  -- still shows up in their filtered ("my games") home list.
  CREATE TABLE IF NOT EXISTS stars (
    user_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, game_id)
  );
`);
// Migrate older `games` tables that predate the `size`/`result` columns
const gamesColumns = new Set(db.prepare('PRAGMA table_info(games)').all().map((column) => column.name));
if (!gamesColumns.has('size')) {
    db.exec('ALTER TABLE games ADD COLUMN size INTEGER NOT NULL DEFAULT 19');
}
if (!gamesColumns.has('result')) {
    db.exec('ALTER TABLE games ADD COLUMN result TEXT');
}
if (!gamesColumns.has('handicap')) {
    db.exec('ALTER TABLE games ADD COLUMN handicap INTEGER NOT NULL DEFAULT 0');
}
if (!gamesColumns.has('title')) {
    db.exec('ALTER TABLE games ADD COLUMN title TEXT');
}
// Participant assignment (who may act as black/white) and the in-flight
// undo request/confirm flow between two different players.
if (!gamesColumns.has('black_user_id')) {
    db.exec('ALTER TABLE games ADD COLUMN black_user_id TEXT');
}
if (!gamesColumns.has('white_user_id')) {
    db.exec('ALTER TABLE games ADD COLUMN white_user_id TEXT');
}
if (!gamesColumns.has('pending_undo_by')) {
    db.exec('ALTER TABLE games ADD COLUMN pending_undo_by TEXT');
}
// Time control: NULL main_time_seconds means unlimited (no clock at all).
// Byoyomi covers all timed presets uniformly — "correspondence" is just
// byoyomi with 0 main time and a single very long period, so no separate
// mechanism is needed for it.
if (!gamesColumns.has('time_control')) {
    db.exec('ALTER TABLE games ADD COLUMN time_control TEXT');
}
if (!gamesColumns.has('main_time_seconds')) {
    db.exec('ALTER TABLE games ADD COLUMN main_time_seconds INTEGER');
}
if (!gamesColumns.has('byoyomi_seconds')) {
    db.exec('ALTER TABLE games ADD COLUMN byoyomi_seconds INTEGER');
}
if (!gamesColumns.has('byoyomi_periods')) {
    db.exec('ALTER TABLE games ADD COLUMN byoyomi_periods INTEGER');
}
if (!gamesColumns.has('black_time_remaining_ms')) {
    db.exec('ALTER TABLE games ADD COLUMN black_time_remaining_ms INTEGER');
}
if (!gamesColumns.has('white_time_remaining_ms')) {
    db.exec('ALTER TABLE games ADD COLUMN white_time_remaining_ms INTEGER');
}
if (!gamesColumns.has('black_periods_left')) {
    db.exec('ALTER TABLE games ADD COLUMN black_periods_left INTEGER');
}
if (!gamesColumns.has('white_periods_left')) {
    db.exec('ALTER TABLE games ADD COLUMN white_periods_left INTEGER');
}
if (!gamesColumns.has('turn_started_at')) {
    db.exec('ALTER TABLE games ADD COLUMN turn_started_at INTEGER');
}
// How a finished game ended ('scoring' | 'resign' | 'timeout') — lets the
// "reopen scoring" feature offer itself only for games that actually went
// through the scoring phase, not ones that ended by resignation or timeout.
if (!gamesColumns.has('end_reason')) {
    db.exec('ALTER TABLE games ADD COLUMN end_reason TEXT');
}
// Mirrors pending_undo_by's request/confirm negotiation, but for reopening
// a finished game back into the scoring phase — kept separate from
// pending_undo_by since the two are conceptually different actions that
// could otherwise collide on the same column.
if (!gamesColumns.has('pending_reopen_by')) {
    db.exec('ALTER TABLE games ADD COLUMN pending_reopen_by TEXT');
}
// Per-game GNU Go difficulty (1-10, GTP --level) — NULL means "use the
// server's GNUGO_LEVEL default" (irrelevant for non-gnugo games).
if (!gamesColumns.has('gnugo_level')) {
    db.exec('ALTER TABLE games ADD COLUMN gnugo_level INTEGER');
}
// Explicit per-game komi, chosen at creation time (6.5/5.5/0 for an even
// game, 0.5 for a handicap game) — NULL means "predates this setting",
// falling back to the handicap-derived default (see getKomi).
if (!gamesColumns.has('komi')) {
    db.exec('ALTER TABLE games ADD COLUMN komi REAL');
}
// Migrate older `snapshots` tables that predate the `hash` column (used for
// situational superko checks), backfilling it for any existing rows.
const snapshotsColumns = new Set(db.prepare('PRAGMA table_info(snapshots)').all().map((column) => column.name));
if (!snapshotsColumns.has('hash')) {
    db.exec("ALTER TABLE snapshots ADD COLUMN hash TEXT NOT NULL DEFAULT ''");
    const existingSnapshots = db.prepare('SELECT rowid, state FROM snapshots').all();
    const updateHash = db.prepare('UPDATE snapshots SET hash = ? WHERE rowid = ?');
    for (const snapshot of existingSnapshots) {
        const board = JSON.parse(snapshot.state);
        updateHash.run(hashBoard(board).toString(), snapshot.rowid);
    }
}
export default db;
