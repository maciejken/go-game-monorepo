#!/usr/bin/env node
// Where the database's size actually is, so a decision about it can be
// made from numbers rather than a hunch.
//
//   DB_PATH=/home/pi/projects/go-server/data/go.db node scripts/db-stats.mjs
//
// Reads nothing but counts and lengths: safe to run against the live
// database while the server is serving.
import fs from 'fs';
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH || './data/go.db';

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);

// The text columns are where the bytes are — a board or an event payload
// is JSON — so summing their lengths accounts for nearly all of a table.
const rows = [];
for (const table of tables) {
  const count = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count;
  const textColumns = db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .filter((column) => /TEXT|BLOB/i.test(column.type))
    .map((column) => `COALESCE(LENGTH("${column.name}"), 0)`);
  const bytes = textColumns.length
    ? db.prepare(`SELECT SUM(${textColumns.join(' + ')}) AS bytes FROM "${table}"`).get().bytes ?? 0
    : 0;
  rows.push({ table, count, bytes });
}

rows.sort((a, b) => b.bytes - a.bytes);

const fileSize = fs.statSync(dbPath).size;
const walPath = `${dbPath}-wal`;
const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

console.log(`${dbPath}: ${mb(fileSize)}${walSize ? ` (+ ${mb(walSize)} of WAL)` : ''}\n`);
console.log('table'.padEnd(20) + 'rows'.padStart(10) + 'text bytes'.padStart(14));
for (const row of rows) {
  console.log(row.table.padEnd(20) + String(row.count).padStart(10) + mb(row.bytes).padStart(14));
}

// Snapshots are the one table that grows with every move of every game
// rather than with the number of games, so it is worth its own line.
const snapshots = db
  .prepare(
    `SELECT COUNT(*) AS count,
            COUNT(DISTINCT game_id) AS games,
            AVG(LENGTH(state)) AS averageBytes
       FROM snapshots`,
  )
  .get();
if (snapshots.count > 0) {
  console.log(
    `\nsnapshots: ${snapshots.count} boards across ${snapshots.games} games, ` +
      `${(snapshots.averageBytes / 1024).toFixed(1)} kB each on average`,
  );
  // What prune-snapshots would remove: a finished game's boards except
  // its last, which is kept so opening the game doesn't replay it. The
  // rest of the table is either that last board or a game still being
  // played, and neither is waste.
  const prunable = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(s.state)), 0) AS bytes
         FROM snapshots s JOIN games g ON g.id = s.game_id
        WHERE g.status = 'finished'
          AND s.move_number < (SELECT MAX(move_number) FROM snapshots WHERE game_id = s.game_id)`,
    )
    .get();
  console.log(
    prunable.count > 0
      ? `  of which ${prunable.count} (${mb(prunable.bytes)}) belong to finished games and can be pruned`
      : '  nothing to prune: what is left is each finished game\'s last board and the games still being played',
  );
}

db.close();
