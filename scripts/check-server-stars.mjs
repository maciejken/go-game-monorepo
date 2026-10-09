#!/usr/bin/env node
// Starring a game, end to end against a running server. Favourites were
// briefly implemented as "whichever tag you nominate", and the point of
// going back to a table of their own is that starring asks nothing of you
// first — so most of this is about what no longer has to be true.
//
//   node scripts/check-server-stars.mjs [baseUrl]
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
const playerName = `sp${suffix}`;
const watcherName = `sw${suffix}`;

const player = session();
const watcher = session();
await player('POST', '/api/auth/register', { username: playerName, password });
await watcher('POST', '/api/auth/register', { username: watcherName, password });

const game = (await player('POST', '/api/games', { size: 9, mode: 'local', color: 'black' })).body;
expect(typeof game?.id === 'string', `couldn't create a game to star (${JSON.stringify(game)})`);

const ids = async (as, scope) => {
  const response = await as('GET', `/api/games?scope=${scope}`);
  return Array.isArray(response.body) ? response.body.map((row) => row.id) : [];
};

// --- Starring asks nothing of you first ---------------------------------

// This account has nominated nothing and owns no tags. Under the previous
// design this very request was refused with "Choose which tag marks your
// favourites first", which is the whole reason for the change.
const starred = await player('POST', `/api/games/${game.id}/star`);
expect(starred.status === 200, `starring: got ${starred.status} (${starred.body?.error})`);
expect(starred.body?.starred === true, `starring answered ${JSON.stringify(starred.body)}`);

const afterStar = await player('GET', `/api/games/${game.id}`);
expect(afterStar.body?.starred === true, 'the game does not read back as starred');
expect((await ids(player, 'starred')).includes(game.id), 'a starred game is missing from scope=starred');

// And it leaves no trace on the game itself: a star is not a tag.
expect(
  Array.isArray(afterStar.body?.tags) && afterStar.body.tags.length === 0,
  `starring added tags: ${JSON.stringify(afterStar.body?.tags)}`,
);
const vocabulary = await player('GET', '/api/tags');
expect(
  Array.isArray(vocabulary.body?.tags) && vocabulary.body.tags.length === 0,
  `starring invented a tag: ${JSON.stringify(vocabulary.body?.tags)}`,
);

// --- Twice is once ------------------------------------------------------

const again = await player('POST', `/api/games/${game.id}/star`);
expect(again.status === 200, `starring twice: got ${again.status}`);
expect(
  (await ids(player, 'starred')).filter((id) => id === game.id).length === 1,
  'starring twice listed the game twice',
);

// --- It is one person's shortlist ---------------------------------------

expect(!(await ids(watcher, 'starred')).includes(game.id), "one person's star showed up in another's list");
const watcherSees = await watcher('GET', `/api/games/${game.id}`);
expect(watcherSees.body?.starred === false, "another user's star reads as this one's");

// Someone who isn't playing can star a game, which is how a game they are
// only watching reaches their own list.
const watcherStar = await watcher('POST', `/api/games/${game.id}/star`);
expect(watcherStar.status === 200, `a non-participant starring: got ${watcherStar.status}`);
expect((await ids(watcher, 'mine')).includes(game.id), "a watched game is missing from the watcher's games");

// --- Unstarring ---------------------------------------------------------

const removed = await player('DELETE', `/api/games/${game.id}/star`);
expect(removed.status === 200, `unstarring: got ${removed.status}`);
expect(removed.body?.starred === false, `unstarring answered ${JSON.stringify(removed.body)}`);
expect(!(await ids(player, 'starred')).includes(game.id), 'an unstarred game is still in scope=starred');
// The other person's star is untouched by it.
expect((await ids(watcher, 'starred')).includes(game.id), "unstarring took somebody else's star with it");
// Unstarring something that was never starred is not an error.
const spurious = await player('DELETE', `/api/games/${game.id}/star`);
expect(spurious.status === 200, `unstarring twice: got ${spurious.status}`);

// --- The obvious misuses ------------------------------------------------

const missing = await player('POST', '/api/games/does-not-exist/star');
expect(missing.status === 404, `starring a nonexistent game: got ${missing.status}`);

const anonymous = session();
for (const [method, urlPath] of [
  ['POST', `/api/games/${game.id}/star`],
  ['DELETE', `/api/games/${game.id}/star`],
]) {
  const response = await anonymous(method, urlPath);
  expect(response.status === 401, `${method} ${urlPath} while logged out: got ${response.status}`);
}

if (failures.length === 0) {
  console.log(`Starring is a list of its own again (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
