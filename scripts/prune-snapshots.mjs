#!/usr/bin/env node
// Deletes the stored boards that a finished game no longer needs. Every
// position is reproducible from the event log (see verify-replay.mjs, and
// run it first), a finished game has no superko left to check, and the
// last board is kept so the game still opens without replaying anything.
//
//   DB_PATH=… node scripts/prune-snapshots.mjs            # says what it would do
//   DB_PATH=… node scripts/prune-snapshots.mjs --apply    # does it
//
// With --apply it also VACUUMs, which is what actually returns the space
// to the filesystem: auto_vacuum was switched on after these tables
// existed, so SQLite has been keeping the freed pages. That rewrites the
// file and needs room for a second copy while it runs, so take a backup
// first — scripts/backup-db.mjs, which is safe to run against a live
// database.
import fs from 'fs';
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH || './data/go.db';
const apply = process.argv.includes('--apply');

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}.`);
  process.exit(1);
}

const db = new Database(dbPath);

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Everything except each finished game's last board. In-progress and
// scoring games keep all of theirs: they can still take a move, and the
// superko check reads them.
const doomed = db
  .prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(s.state)), 0) AS bytes
       FROM snapshots s
       JOIN games g ON g.id = s.game_id
      WHERE g.status = 'finished'
        AND s.move_number < (SELECT MAX(move_number) FROM snapshots WHERE game_id = s.game_id)`,
  )
  .get();

const before = fs.statSync(dbPath).size;
console.log(`${dbPath}: ${mb(before)}`);
console.log(`${doomed.count} stored boards from finished games, ${mb(doomed.bytes)} of board text`);

if (!apply) {
  console.log('\nNothing was changed. Run verify-replay.mjs first, then pass --apply.');
  db.close();
  process.exit(0);
}

const removed = db
  .prepare(
    `DELETE FROM snapshots
      WHERE rowid IN (
        SELECT s.rowid FROM snapshots s
          JOIN games g ON g.id = s.game_id
         WHERE g.status = 'finished'
           AND s.move_number < (SELECT MAX(move_number) FROM snapshots WHERE game_id = s.game_id)
      )`,
  )
  .run().changes;

console.log(`removed ${removed} rows; vacuuming…`);
db.exec('VACUUM');
db.close();

const after = fs.statSync(dbPath).size;
console.log(`${dbPath}: ${mb(before)} → ${mb(after)} (${mb(before - after)} returned)`);
