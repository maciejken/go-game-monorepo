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

  -- Free-text labels a player attaches to their own game ("teaching",
  -- "tournament"), searchable alongside the title and player names. Shared
  -- by both players rather than private per-user, matching the title they
  -- already share. tag_key is the lowercased tag, which is what the primary
  -- key dedupes on so "Teaching" and "teaching" can't both be added; tag
  -- keeps the casing it was entered with, for display.
  CREATE TABLE IF NOT EXISTS game_tags (
    game_id TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, tag_key)
  );

  -- One saved new-game configuration per user, for the iOS app's shake-to-
  -- play gesture: shaking creates a game from this rather than walking
  -- through the new-game form. Server-side rather than device-local so it
  -- follows the account, and one row per user because there is exactly one
  -- quick game — a list of presets would be a different feature.
  CREATE TABLE IF NOT EXISTS quick_game_presets (
    user_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    size INTEGER NOT NULL,
    handicap INTEGER NOT NULL,
    komi REAL NOT NULL,
    time_control TEXT,
    gnugo_level INTEGER,
    color TEXT NOT NULL,
    opponent_username TEXT,
    shake_to_play INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  -- Scoped credential for an external board-vision service: lets it submit
  -- moves for one specific game without a full player login. Valid for
  -- either color, since the camera identifies a move by stone color, not by
  -- which player placed it.
  CREATE TABLE IF NOT EXISTS vision_tokens (
    token TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- An iOS device's APNs token, so the server knows where to push "it's
  -- your turn" notifications. One user can have several rows (multiple
  -- devices); a token moves to a new owner if it's re-registered under a
  -- different logged-in user (e.g. a shared device, or a reinstall).
  CREATE TABLE IF NOT EXISTS device_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
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
// The level GNU Go is currently attempting (or last attempted) for the
// in-progress AI move — distinct from gnugo_level, the game's configured
// difficulty. Normally equal to it; only differs while a slow position has
// forced a step down in search of a response that returns in time (see
// maybeTriggerAiMove) — surfaced to the client so a human watching the
// board can see exactly when and how far that backoff happened.
if (!gamesColumns.has('ai_current_level')) {
  db.exec('ALTER TABLE games ADD COLUMN ai_current_level INTEGER');
}
// A remote-mode invite starts with invite_status 'pending' and
// invited_user_id set to the invited (not inviting) player's id, so that
// player can be shown a confirm/reject prompt before playing and the
// inviter — whichever of black_user_id/white_user_id isn't this one — can
// be told if it's declined. Both are cleared back to NULL on acceptance —
// there's nothing left to act on afterward, and NULL uniformly means "not
// an open invitation" for local/gnugo games and any game predating this
// feature.
if (!gamesColumns.has('invited_user_id')) {
  db.exec('ALTER TABLE games ADD COLUMN invited_user_id TEXT');
}
if (!gamesColumns.has('invite_status')) {
  db.exec('ALTER TABLE games ADD COLUMN invite_status TEXT');
}

// Whether other users can find and invite this one to a remote game —
// defaults to on (1) so existing accounts keep today's behavior.
const usersColumns = new Set(
  (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((column) => column.name),
);
if (!usersColumns.has('accepts_invitations')) {
  db.exec('ALTER TABLE users ADD COLUMN accepts_invitations INTEGER NOT NULL DEFAULT 1');
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