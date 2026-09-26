#!/usr/bin/env node
// Stored boards are a cache of what replaying the log produces, and
// scripts/prune-snapshots.mjs deletes them for finished games. This checks
// the two things that has to be true for that to be safe: review mode
// reads the same either way, and the superko rule still bites when there
// is nothing stored to compare against.
//
//   node scripts/check-server-replay.mjs <baseUrl> <dbPath>
//
// Needs the database file as well as the API, because pruning is the
// thing being tested.
import Database from 'better-sqlite3';

const base = process.argv[2] ?? 'http://localhost:3010';
const dbPath = process.argv[3];

const failures = [];
let checked = 0;

function expect(condition, describe) {
  checked += 1;
  if (!condition) {
    failures.push(describe);
  }
}

let cookie = '';

async function call(method, urlPath, body) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    cookie = setCookie.split(';')[0];
  }
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: { error: text.slice(0, 120) } };
  }
}

// Deletes every stored board for a game but its last, which is what
// pruning does to a finished one.
function pruneStoredBoards(gameId) {
  const db = new Database(dbPath);
  const removed = db
    .prepare(
      `DELETE FROM snapshots
        WHERE game_id = ?
          AND move_number < (SELECT MAX(move_number) FROM snapshots WHERE game_id = ?)`,
    )
    .run(gameId, gameId).changes;
  db.close();
  return removed;
}

const username = `rp${Date.now().toString(36).slice(-6)}`;
await call('POST', '/api/auth/register', { username, password: 'password123' });

// --- A finished game reads the same with its boards gone ----------------

const played = (await call('POST', '/api/games', { size: 9, handicap: 2, mode: 'local', color: 'black' })).body;
// A handicap game, so the replay has to get the placement and the
// white-moves-first numbering right as well as the moves.
// Black's second move takes the corner stone: a replay that places
// stones without resolving captures diverges here and nowhere else.
for (const [color, x, y] of [
  ['white', 0, 0],
  ['black', 1, 0],
  ['white', 8, 8],
  ['black', 0, 1],
  ['white', 4, 4],
  ['black', 5, 5],
]) {
  const response = await call('POST', `/api/games/${played.id}/moves`, { x, y, color });
  expect(response.status < 400, `playing out the finished game: ${color} ${x},${y} (${response.body?.error})`);
}
await call('POST', `/api/games/${played.id}/pass`, { color: 'white' });
await call('POST', `/api/games/${played.id}/pass`, { color: 'black' });
await call('POST', `/api/games/${played.id}/finalize-scoring`, { deadPoints: [], sekiPoints: [] });

const historyBefore = (await call('GET', `/api/games/${played.id}/history`)).body;
const stateBefore = (await call('GET', `/api/games/${played.id}`)).body;
expect(historyBefore?.moves?.length > 0, 'the finished game has no history to compare');

// The point of the exercise: what the replay produces has to equal what
// was stored at the time, position for position. Comparing the history
// with itself before and after pruning would pass just as happily with a
// replay that is wrong in the same way twice.
{
  const db = new Database(dbPath, { readonly: true });
  const snapshots = db
    .prepare('SELECT move_number, state FROM snapshots WHERE game_id = ? ORDER BY move_number')
    .all(played.id);
  db.close();
  expect(snapshots.length > 0, 'the finished game stored no boards to compare against');
  for (const snapshot of snapshots) {
    const entry = historyBefore.moves.find((move) => move.moveNumber === snapshot.move_number);
    expect(
      entry !== undefined && JSON.stringify(entry.board) === snapshot.state,
      `move ${snapshot.move_number}: the replayed board differs from the one that was stored`,
    );
  }
}

const removed = pruneStoredBoards(played.id);
expect(removed > 0, 'nothing was stored to prune');

const historyAfter = (await call('GET', `/api/games/${played.id}/history`)).body;
expect(
  JSON.stringify(historyBefore) === JSON.stringify(historyAfter),
  'review mode reads differently once the stored boards are gone',
);
const stateAfter = (await call('GET', `/api/games/${played.id}`)).body;
expect(
  JSON.stringify(stateBefore?.board) === JSON.stringify(stateAfter?.board),
  'the finished board changed once the stored boards were gone',
);

// --- Superko still bites with nothing stored ----------------------------

const ko = (await call('POST', '/api/games', { size: 9, mode: 'local', color: 'black' })).body;
// The ko shape from shared/fixtures/rules.json, up to Black's capture.
for (const [color, x, y] of [
  ['black', 3, 2],
  ['white', 4, 2],
  ['black', 2, 3],
  ['white', 5, 3],
  ['black', 3, 4],
  ['white', 4, 4],
  ['black', 8, 8],
  ['white', 3, 3],
  ['black', 4, 3],
]) {
  const response = await call('POST', `/api/games/${ko.id}/moves`, { x, y, color });
  expect(response.status < 400, `setting up the ko: ${color} ${x},${y} was refused (${response.body?.error})`);
}

const refusal = 'Move violates the superko rule (position already occurred)';
const withBoards = await call('POST', `/api/games/${ko.id}/moves`, { x: 3, y: 3, color: 'white' });
expect(withBoards.body?.error === refusal, `retaking the ko: "${withBoards.body?.error}", expected the superko refusal`);

pruneStoredBoards(ko.id);

const withoutBoards = await call('POST', `/api/games/${ko.id}/moves`, { x: 3, y: 3, color: 'white' });
expect(
  withoutBoards.body?.error === refusal,
  `retaking the ko with nothing stored: "${withoutBoards.body?.error}", expected the superko refusal`,
);

// And a legal move is still legal — the replay mustn't refuse everything.
const elsewhere = await call('POST', `/api/games/${ko.id}/moves`, { x: 0, y: 8, color: 'white' });
expect(elsewhere.status < 400, `playing elsewhere with nothing stored was refused (${elsewhere.body?.error})`);

if (failures.length === 0) {
  console.log(`Replaying the log stands in for the stored boards (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
