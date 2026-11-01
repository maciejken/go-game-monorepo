#!/usr/bin/env node
// Scoring between two players, end to end against a running server: the dead
// and seki marks are shared, and the game ends only when both have said the
// score is right. A game with nobody else to agree — on one device — ends the
// way it always did.
//
//   node scripts/check-server-scoring.mjs [baseUrl]
//
// Starts nothing: point it at a server with a scratch database.
const base = process.argv[2] ?? 'http://localhost:3010';

const failures = [];
let checked = 0;
function expect(condition, describe) {
  checked += 1;
  if (!condition) {
    failures.push(describe);
  }
}

function session() {
  let cookie = '';
  return async function call(method, urlPath, body) {
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
  };
}

const keys = (points) => (points ?? []).map((p) => `${p.x},${p.y}`).sort().join(' ');
const suffix = Date.now().toString(36).slice(-5);
const password = 'password123';
const alice = session();
const bobby = session();
const eve = session();
await alice('POST', '/api/auth/register', { username: `sa${suffix}`, password });
await bobby('POST', '/api/auth/register', { username: `sb${suffix}`, password });
await eve('POST', '/api/auth/register', { username: `sc${suffix}`, password });

// A position with something to mark: black at E5 and G7, white at C3, then two passes.
const created = await alice('POST', '/api/games', {
  size: 9, mode: 'remote', color: 'black', timeControl: 'unlimited', opponentUsername: `sb${suffix}`,
});
const gameId = created.body?.id;
await bobby('POST', `/api/games/${gameId}/respond-invite`, { accept: true });
await alice('POST', `/api/games/${gameId}/moves`, { x: 4, y: 4, color: 'black' });
await bobby('POST', `/api/games/${gameId}/moves`, { x: 2, y: 2, color: 'white' });
await alice('POST', `/api/games/${gameId}/moves`, { x: 6, y: 6, color: 'black' });
await bobby('POST', `/api/games/${gameId}/pass`, { color: 'white' });
const scoring = await alice('POST', `/api/games/${gameId}/pass`, { color: 'black' });
expect(scoring.body?.status === 'scoring', `two passes should start scoring: ${JSON.stringify(scoring.body)}`);

const stateOf = async (who) => (await who('GET', `/api/games/${gameId}`)).body;
const fresh = await stateOf(alice);
expect(fresh?.scoringMarks && keys(fresh.scoringMarks.dead) === '' && keys(fresh.scoringMarks.seki) === '', `scoring starts unmarked: ${JSON.stringify(fresh?.scoringMarks)}`);
expect(JSON.stringify(fresh?.scoringConfirmedBy) === '[]', `and unagreed: ${JSON.stringify(fresh?.scoringConfirmedBy)}`);

// --- Marks are shared, and only stones can carry one ---------------------
const mark = (who, mode, points, marked = true) =>
  who('POST', `/api/games/${gameId}/scoring-marks`, { mode, points, marked });

const first = await mark(alice, 'dead', [{ x: 2, y: 2 }]);
expect(first.status === 200, `marking a group dead: got ${first.status} (${first.body?.error})`);
expect(keys((await stateOf(bobby))?.scoringMarks?.dead) === '2,2', `the other player sees it: ${JSON.stringify((await stateOf(bobby))?.scoringMarks)}`);

await mark(alice, 'dead', [{ x: 0, y: 0 }]); // an empty point
expect(keys((await stateOf(alice))?.scoringMarks?.dead) === '2,2', 'an empty point is not a mark');

// Two players marking different groups both get what they marked.
await mark(bobby, 'dead', [{ x: 4, y: 4 }]);
await mark(alice, 'seki', [{ x: 6, y: 6 }]);
const both = (await stateOf(alice))?.scoringMarks;
expect(keys(both?.dead) === '2,2 4,4' && keys(both?.seki) === '6,6', `marks from both players add up: ${JSON.stringify(both)}`);

// A group is dead or in seki, never both.
await mark(bobby, 'seki', [{ x: 4, y: 4 }]);
const exclusive = (await stateOf(alice))?.scoringMarks;
expect(keys(exclusive?.dead) === '2,2' && keys(exclusive?.seki) === '4,4 6,6', `seki takes a group out of dead: ${JSON.stringify(exclusive)}`);
await mark(alice, 'seki', [{ x: 4, y: 4 }], false);
expect(keys((await stateOf(bobby))?.scoringMarks?.seki) === '6,6', 'unmarking removes it');
await mark(alice, 'seki', [{ x: 6, y: 6 }], false);
await mark(alice, 'dead', [{ x: 4, y: 4 }]);

// --- Agreeing -------------------------------------------------------------
const confirm = (who, confirmed = true) => who('POST', `/api/games/${gameId}/scoring-confirm`, { confirmed });
const one = await confirm(alice);
expect(one.status === 200 && one.body?.status === 'scoring', `one player agreeing does not end it: ${JSON.stringify(one.body)}`);
expect(JSON.stringify((await stateOf(bobby))?.scoringConfirmedBy) === '["black"]', `the other player sees who agreed: ${JSON.stringify((await stateOf(bobby))?.scoringConfirmedBy)}`);

await confirm(alice, false);
expect(JSON.stringify((await stateOf(alice))?.scoringConfirmedBy) === '[]', 'agreement can be taken back');

await confirm(alice);
await mark(bobby, 'dead', [{ x: 6, y: 6 }]); // changes the score alice agreed to
expect(JSON.stringify((await stateOf(alice))?.scoringConfirmedBy) === '[]', `changing a mark takes everybody's agreement back: ${JSON.stringify((await stateOf(alice))?.scoringConfirmedBy)}`);
await mark(bobby, 'dead', [{ x: 6, y: 6 }], false);

// The old way of ending a shared game, on one player's say, is closed.
const legacy = await alice('POST', `/api/games/${gameId}/finalize-scoring`, { deadPoints: [], sekiPoints: [] });
expect(legacy.status === 400, `finalize-scoring in a game between two players: got ${legacy.status}`);

// Somebody who is not playing may look, and may not mark or agree.
expect((await mark(eve, 'dead', [{ x: 2, y: 2 }])).status === 403, 'a spectator marked a group');
expect((await confirm(eve)).status === 403, 'a spectator agreed to a score');

// --- Both agreeing ends it, on the marks as they stand --------------------
await confirm(alice);
const ended = await confirm(bobby);
expect(ended.body?.status === 'finished', `both agreeing ends the game: ${JSON.stringify(ended.body)}`);
// E5 and C3 dead: black's G7 alone owns the board (80 points) and has taken the
// stone of white's that was marked dead (1); white has the one black stone (1) and komi.
expect(ended.body?.result === 'Black wins by 73.5 (B: 81, W: 7.5)', `the result is counted from the shared marks: ${ended.body?.result}`);
const done = await stateOf(alice);
expect(done?.status === 'finished' && done?.scoringMarks === null, `a finished game carries no marks: ${JSON.stringify(done?.scoringMarks)}`);

// --- Reopening keeps the marks and asks again -----------------------------
await bobby('POST', `/api/games/${gameId}/reopen-scoring`);
await alice('POST', `/api/games/${gameId}/reopen-scoring`);
const reopened = await stateOf(alice);
expect(reopened?.status === 'scoring', `reopened: ${reopened?.status}`);
expect(keys(reopened?.scoringMarks?.dead) === '2,2 4,4', `the marks it was finished with are the place to start: ${JSON.stringify(reopened?.scoringMarks)}`);
expect(JSON.stringify(reopened?.scoringConfirmedBy) === '[]', 'but nobody has agreed yet');
expect((await mark(alice, 'seki', [{ x: 8, y: 8 }])).status === 200, 'marking works in a reopened game');

// --- One device: nobody to agree, so one player's say ends it ------------
const local = await alice('POST', '/api/games', { size: 9, mode: 'local', color: 'black', timeControl: 'unlimited' });
const localId = local.body?.id;
await alice('POST', `/api/games/${localId}/moves`, { x: 4, y: 4, color: 'black' });
await alice('POST', `/api/games/${localId}/pass`, { color: 'white' });
await alice('POST', `/api/games/${localId}/pass`, { color: 'black' });
const localState = (await alice('GET', `/api/games/${localId}`)).body;
expect(localState?.status === 'scoring' && localState?.scoringMarks === null, `a game on one device keeps its marks on the device: ${JSON.stringify(localState?.scoringMarks)}`);
expect((await alice('POST', `/api/games/${localId}/scoring-marks`, { mode: 'dead', points: [{ x: 4, y: 4 }], marked: true })).status === 400, 'shared marks are for two players');
const localEnd = await alice('POST', `/api/games/${localId}/finalize-scoring`, { deadPoints: [], sekiPoints: [] });
expect(localEnd.status === 200 && localEnd.body?.status === 'finished', `finalize-scoring on one device: ${JSON.stringify(localEnd.body)}`);

if (failures.length === 0) {
  console.log(`Scoring between two players is agreed, not raced (${checked} assertions).`);
  process.exit(0);
}
console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
