#!/usr/bin/env node
// Replays every game from its event log and compares each position it
// produces against the board stored for that move. Run this before
// pruning snapshots: if every stored board can be reproduced, the stored
// ones are copies and deleting them loses nothing. If any can't, nothing
// should be deleted until we know why.
//
//   DB_PATH=/home/pi/projects/go-server/data/go.db node scripts/verify-replay.mjs
//
// Read-only, and safe against a live database.
import fs from 'fs';
import Database from 'better-sqlite3';
import { applyMove, createEmptyBoard, hashBoard } from '../shared/dist/index.js';

const dbPath = process.env.DB_PATH || './data/go.db';

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const games = db.prepare('SELECT id, size, handicap, status FROM games ORDER BY created_at').all();
const mismatches = [];
let comparedBoards = 0;
let comparedHashes = 0;

for (const game of games) {
  const events = db
    .prepare('SELECT move_number, event_type, payload FROM events WHERE game_id = ? ORDER BY move_number ASC')
    .all(game.id);
  const snapshots = db
    .prepare('SELECT move_number, state, hash FROM snapshots WHERE game_id = ? ORDER BY move_number ASC')
    .all(game.id);
  const stored = new Map(snapshots.map((row) => [row.move_number, row]));

  let board = createEmptyBoard(game.size);
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.event_type === 'HANDICAP') {
      board = createEmptyBoard(game.size);
      for (const [x, y] of payload.points ?? []) {
        board[y][x] = 'black';
      }
    } else if (event.event_type === 'MOVE') {
      board = applyMove(board, { x: payload.x, y: payload.y }, payload.color).board;
    } else {
      // A pass or a resignation leaves the position where it was.
      continue;
    }

    const row = stored.get(event.move_number);
    if (!row) {
      continue;
    }
    comparedBoards += 1;
    if (JSON.stringify(board) !== row.state) {
      mismatches.push(`${game.id} move ${event.move_number}: replayed board differs from the stored one`);
      continue;
    }
    if (row.hash) {
      comparedHashes += 1;
      if (hashBoard(board).toString() !== row.hash) {
        mismatches.push(`${game.id} move ${event.move_number}: replayed hash differs from the stored one`);
      }
    }
  }
}

db.close();

if (mismatches.length === 0) {
  console.log(
    `Every stored board is reproducible: ${comparedBoards} boards across ${games.length} games ` +
      `(${comparedHashes} hashes checked too). Pruning them loses nothing.`,
  );
  process.exit(0);
}

console.log(`${mismatches.length} of ${comparedBoards} stored boards could not be reproduced:`);
for (const mismatch of mismatches.slice(0, 20)) {
  console.log(`  - ${mismatch}`);
}
if (mismatches.length > 20) {
  console.log(`  … and ${mismatches.length - 20} more`);
}
console.log('\nDo not prune. Send this output on.');
process.exit(1);
