#!/usr/bin/env node
// Deleting an account, end to end against a running server. Half of a game
// belongs to somebody else, so what matters here is what survives: the
// account's own things go, the other player's game stays with an opponent
// that is no longer a person.
//
//   node scripts/check-server-account.mjs [baseUrl]
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

// One jar per person, so both stay logged in at once.
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
const leaverName = `go${suffix}`;
const stayerName = `st${suffix}`;
const password = 'password123';

const leaver = session();
const stayer = session();

await leaver('POST', '/api/auth/register', { username: leaverName, password });
await stayer('POST', '/api/auth/register', { username: stayerName, password });

// A game the leaver played alone: nobody else's record.
const solo = (await leaver('POST', '/api/games', { size: 9, mode: 'local', color: 'black' })).body;
await leaver('POST', `/api/games/${solo.id}/moves`, { x: 2, y: 2, color: 'black' });

// And a game against somebody who is staying.
const shared = (await leaver('POST', '/api/games', {
  size: 9,
  mode: 'remote',
  color: 'black',
  opponentUsername: stayerName,
})).body;
await stayer('POST', `/api/games/${shared.id}/respond-invite`, { accept: true });
await leaver('POST', `/api/games/${shared.id}/moves`, { x: 3, y: 3, color: 'black' });
await leaver('POST', `/api/games/${shared.id}/tags`, { tag: 'mine', isPublic: false });
await leaver('POST', `/api/games/${shared.id}/tags`, { tag: 'ours', isPublic: true });
await leaver('PUT', '/api/quick-game-preset', { mode: 'local', size: 9, handicap: 0, komi: 6.5 });

// The wrong password doesn't end an account.
const refused = await leaver('DELETE', '/api/auth/me', { password: 'not-the-password' });
expect(refused.status === 400, `wrong password: got ${refused.status}, expected a refusal`);
const stillThere = await leaver('GET', '/api/auth/me');
expect(stillThere.body?.user?.username === leaverName, 'wrong password: the account was ended anyway');

const deleted = await leaver('DELETE', '/api/auth/me', { password });
expect(deleted.status === 200, `delete: got ${deleted.status} (${deleted.body?.error})`);

// The session that did it is over.
const after = await leaver('GET', '/api/auth/me');
expect(after.body?.user == null, `after deleting: still signed in as ${after.body?.user?.username}`);

// And the credentials no longer open anything.
const loginAgain = await leaver('POST', '/api/auth/login', { username: leaverName, password });
expect(loginAgain.status >= 400, `after deleting: the old password still logs in (${loginAgain.status})`);

// The game played alone is gone.
const soloNow = await stayer('GET', `/api/games/${solo.id}`);
expect(soloNow.status === 404, `solo game: got ${soloNow.status}, expected it to be gone`);

// The shared game is the other player's too, so it stays — with an
// opponent that is no longer a person.
const sharedNow = await stayer('GET', `/api/games/${shared.id}`);
expect(sharedNow.status === 200, `shared game: got ${sharedNow.status}, expected it to survive`);
expect(
  sharedNow.body?.blackUsername?.startsWith('deleted_'),
  `shared game: opponent reads "${sharedNow.body?.blackUsername}", expected a deleted marker`,
);
expect(
  sharedNow.body?.blackUsername !== leaverName,
  'shared game: the deleted account\'s name is still on it',
);
// The board is untouched: deleting an account is not editing a game.
expect(sharedNow.body?.board?.[3]?.[3] === 'black', 'shared game: the moves went with the account');
// A tag put on the game for both players belongs to the one still here.
expect(
  Array.isArray(sharedNow.body?.tags) && sharedNow.body.tags.includes('ours'),
  `shared game: shared tags are ${JSON.stringify(sharedNow.body?.tags)}, expected to keep "ours"`,
);

// Nobody can find or invite what is left.
const search = await stayer('GET', `/api/users/search?q=${leaverName}`);
expect(
  Array.isArray(search.body) && search.body.length === 0,
  `search: still finds ${JSON.stringify(search.body)}`,
);

// The name is free again.
const reuse = session();
const retaken = await reuse('POST', '/api/auth/register', { username: leaverName, password });
expect(retaken.status < 400, `re-registering the name: got ${retaken.status} (${retaken.body?.error})`);
// And whoever takes it is a different person, with none of the games.
const retakenGames = (await reuse('GET', '/api/games?scope=mine')).body;
expect(
  Array.isArray(retakenGames) && retakenGames.length === 0,
  `re-registering the name: inherited ${retakenGames?.length} game(s)`,
);

if (failures.length === 0) {
  console.log(`Deleting an account leaves the right things behind (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
