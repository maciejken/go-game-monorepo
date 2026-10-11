#!/usr/bin/env node
// The progress series, end to end against a running server. GET
// /api/progress answers one question — "how have my games been going?" —
// and the whole value of the answer is in what it leaves out: a
// resignation has no margin to plot, and a 13x13 game against a stronger
// opponent isn't comparable with a 9x9 one. So most of this checks
// exclusions, and that the margin is told from the side of whoever asked.
//
//   node scripts/check-server-progress.mjs [baseUrl]
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

const suffix = Date.now().toString(36).slice(-5);
const password = 'password123';
const nameA = `pa${suffix}`;
const nameB = `pb${suffix}`;
const nameC = `pc${suffix}`;

const alice = session();
const bob = session();
const carol = session();
await alice('POST', '/api/auth/register', { username: nameA, password });
await bob('POST', '/api/auth/register', { username: nameB, password });
await carol('POST', '/api/auth/register', { username: nameC, password });

// Unlimited throughout: a clock that runs out mid-check would end a game
// by timeout, which is one of the things being excluded here, and it
// would do it to whichever game happened to be slowest.
const setPreset = (as, patch) =>
  as('PUT', '/api/quick-game-preset', {
    mode: 'remote',
    size: 9,
    handicap: 0,
    komi: 6.5,
    timeControl: 'unlimited',
    color: 'black',
    ...patch,
  });

const remoteGame = async (opponentName, opponent, patch = {}) => {
  const created = await alice('POST', '/api/games', {
    size: 9,
    komi: 6.5,
    mode: 'remote',
    color: 'black',
    timeControl: 'unlimited',
    opponentUsername: opponentName,
    ...patch,
  });
  const id = created.body?.id;
  expect(typeof id === 'string', `couldn't create a game against ${opponentName} (${JSON.stringify(created.body)})`);
  await opponent('POST', `/api/games/${id}/respond-invite`, { accept: true });
  return id;
};

// Two passes on a board nobody has played on: every point is neutral, so
// the whole result is the komi, and the margin is known without having to
// build territory.
const scoreOut = async (id, white) => {
  await alice('POST', `/api/games/${id}/pass`, { color: 'black' });
  await white('POST', `/api/games/${id}/pass`, { color: 'white' });
  const finished = await alice('POST', `/api/games/${id}/finalize-scoring`, { deadPoints: [], sekiPoints: [] });
  return finished.body?.result ?? '';
};

const progress = async (as) => (await as('GET', '/api/progress')).body;

const storedA = await setPreset(alice, { opponentUsername: nameB });
await setPreset(bob, { opponentUsername: nameA });
expect(storedA.body?.mode === 'remote', `the preset didn't store remote mode (${JSON.stringify(storedA.body)})`);
expect(storedA.body?.timeControl === null, `the preset didn't store an unlimited clock (${storedA.body?.timeControl})`);

// --- The series itself --------------------------------------------------

const counted = await remoteGame(nameB, bob);
const result = await scoreOut(counted, bob);
expect(result.startsWith('White wins by 6.5'), `an empty 9x9 with komi 6.5 scored as "${result}"`);

const forAlice = await progress(alice);
expect(forAlice?.games?.length === 1, `Alice's series has ${forAlice?.games?.length} games, expected 1`);
expect(forAlice?.games?.[0]?.gameId === counted, 'the scored game is missing from the series');
// She had black, and white won by the komi: from her side that is a loss
// by 6.5, and the sign is the entire point of the chart.
expect(forAlice?.games?.[0]?.margin === -6.5, `Alice's margin is ${forAlice?.games?.[0]?.margin}, expected -6.5`);
expect(forAlice?.games?.[0]?.opponent === nameB, `the opponent reads as ${forAlice?.games?.[0]?.opponent}`);
expect(typeof forAlice?.games?.[0]?.finishedAt === 'number', 'the entry has no finishedAt');
expect(forAlice?.preset?.size === 9 && forAlice?.preset?.mode === 'remote', 'the series does not echo the preset');

// The same game, from the other side of the board.
const forBob = await progress(bob);
expect(forBob?.games?.length === 1, `Bob's series has ${forBob?.games?.length} games, expected 1`);
expect(forBob?.games?.[0]?.margin === 6.5, `Bob's margin is ${forBob?.games?.[0]?.margin}, expected +6.5`);
expect(forBob?.games?.[0]?.opponent === nameA, `Bob's opponent reads as ${forBob?.games?.[0]?.opponent}`);

// --- What has no number to plot ----------------------------------------

const resigned = await remoteGame(nameB, bob);
const resignation = await alice('POST', `/api/games/${resigned}/resign`, { color: 'black' });
expect(resignation.status === 200, `couldn't resign the game (${resignation.body?.error})`);
expect((await progress(alice))?.games?.length === 1, 'a resignation reached the series');

// A game still being played has no result at all.
const unfinished = await remoteGame(nameB, bob);
expect(typeof unfinished === 'string', 'could not create an unfinished game');
expect((await progress(alice))?.games?.length === 1, 'an unfinished game reached the series');

// --- What the preset filters out ---------------------------------------

// Bigger board: a margin there isn't comparable with a margin on 9x9,
// which is why the series is narrowed to one set of conditions.
const bigger = await remoteGame(nameB, bob, { size: 13 });
expect(
  (await scoreOut(bigger, bob)).startsWith('White wins by 6.5'),
  'the 13x13 game did not score as expected',
);
expect((await progress(alice))?.games?.length === 1, 'a game on another board size reached the series');

// Someone else entirely, with the preset still naming Bob.
await setPreset(carol, { opponentUsername: nameA });
const other = await remoteGame(nameC, carol);
expect((await scoreOut(other, carol)).startsWith('White wins by 6.5'), 'the game against Carol did not score');
const stillJustBob = await progress(alice);
expect(stillJustBob?.games?.length === 1, `a game against another opponent reached the series (${stillJustBob?.games?.length})`);
expect(stillJustBob?.games?.[0]?.gameId === counted, 'the wrong game survived the opponent filter');

// A game played alone is a different mode, so it is out while the preset
// says remote — and the only one in it once the preset says local.
const local = (await alice('POST', '/api/games', {
  size: 9,
  komi: 6.5,
  mode: 'local',
  color: 'black',
  timeControl: 'unlimited',
})).body?.id;
expect(typeof local === 'string', 'could not create a local game');
expect((await scoreOut(local, alice)).startsWith('White wins by 6.5'), 'the local game did not score');
expect((await progress(alice))?.games?.length === 1, 'a local game reached a remote series');

await setPreset(alice, { mode: 'local' });
const asLocal = await progress(alice);
expect(asLocal?.games?.length === 1, `the local series has ${asLocal?.games?.length} games, expected 1`);
expect(asLocal?.games?.[0]?.gameId === local, 'switching the preset to local did not switch the series');
expect(asLocal?.preset?.mode === 'local', `the echoed preset says ${asLocal?.preset?.mode}`);
// Nobody was on the other side of it, so there is no name to show.
expect(asLocal?.games?.[0]?.opponent === null, `a game played alone names ${asLocal?.games?.[0]?.opponent}`);

// Changing one number in the preset is enough to empty the series: these
// are the same games, under conditions they weren't played under.
await setPreset(alice, { mode: 'local', komi: 0.5 });
expect((await progress(alice))?.games?.length === 0, 'a different komi still matched the played games');

// --- Logged out ---------------------------------------------------------

const anonymous = session();
const refused = await anonymous('GET', '/api/progress');
expect(refused.status === 401, `GET /api/progress while logged out: got ${refused.status}`);

if (failures.length === 0) {
  console.log(`The progress series counts only what it can count (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
