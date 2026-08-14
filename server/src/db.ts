import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { hashBoard, type Board } from 'shared';

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
`);

// Migrate older `games` tables that predate the `size`/`result` columns
const gamesColumns = new Set(
  (db.prepare('PRAGMA table_info(games)').all() as { name: string }[]).map((column) => column.name),
);
if (!gamesColumns.has('size')) {
  db.exec('ALTER TABLE games ADD COLUMN size INTEGER NOT NULL DEFAULT 19');
}
if (!gamesColumns.has('result')) {
  db.exec('ALTER TABLE games ADD COLUMN result TEXT');
}
if (!gamesColumns.has('handicap')) {
  db.exec('ALTER TABLE games ADD COLUMN handicap INTEGER NOT NULL DEFAULT 0');
}

// Migrate older `snapshots` tables that predate the `hash` column (used for
// situational superko checks), backfilling it for any existing rows.
const snapshotsColumns = new Set(
  (db.prepare('PRAGMA table_info(snapshots)').all() as { name: string }[]).map((column) => column.name),
);
if (!snapshotsColumns.has('hash')) {
  db.exec("ALTER TABLE snapshots ADD COLUMN hash TEXT NOT NULL DEFAULT ''");

  const existingSnapshots = db.prepare('SELECT rowid, state FROM snapshots').all() as {
    rowid: number;
    state: string;
  }[];
  const updateHash = db.prepare('UPDATE snapshots SET hash = ? WHERE rowid = ?');
  for (const snapshot of existingSnapshots) {
    const board = JSON.parse(snapshot.state) as Board;
    updateHash.run(hashBoard(board).toString(), snapshot.rowid);
  }
}

export default db;