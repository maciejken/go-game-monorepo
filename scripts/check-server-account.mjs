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

// --- A preset only ever offers a game this server can start -------------

// This server runs without GNU Go (nothing sets GNUGO_ENABLED), so the
// preset a brand-new account gets must not name it: the clients show that
// mode as the chosen one, and creating the game would then be refused.
const gnugoOff = (await stayer('GET', '/api/auth/me')).body?.features?.gnugo === false;
expect(gnugoOff, 'these checks assume a server without GNU Go, and this one has it');
const freshPreset = await stayer('GET', '/api/quick-game-preset');
expect(
  freshPreset.body?.mode !== 'gnugo',
  `a server without GNU Go hands a new account mode "${freshPreset.body?.mode}"`,
);
// And one asked for anyway comes back as what was actually stored.
const askedForGnugo = await stayer('PUT', '/api/quick-game-preset', {
  mode: 'gnugo',
  size: 9,
  handicap: 0,
  komi: 6.5,
  gnugoLevel: 5,
});
expect(askedForGnugo.status === 200, `saving a gnugo preset: got ${askedForGnugo.status}`);
expect(
  askedForGnugo.body?.mode !== 'gnugo',
  `a server without GNU Go stored mode "${askedForGnugo.body?.mode}"`,
);
const reread = await stayer('GET', '/api/quick-game-preset');
expect(reread.body?.mode !== 'gnugo', `and reads it back as "${reread.body?.mode}"`);

// Nor does it offer the performance report, which is a separate switch
// again (GNUGO_DEBUG_PERFORMANCE) and off here too. A client reads the
// feature to decide whether to show the screen at all; the endpoint
// refuses either way, so neither is load-bearing on its own.
const features = (await stayer('GET', '/api/auth/me')).body?.features;
expect(
  features?.gnugoDebugPerformance === false,
  `features.gnugoDebugPerformance is ${features?.gnugoDebugPerformance}, expected false`,
);
const timings = await stayer('GET', `/api/games/${shared.id}/gnugo-timings`);
expect(timings.status === 404, `timings with the switch off: got ${timings.status}, expected 404`);
// Somebody else's list has this account on it, and should not keep it.
await stayer('POST', '/api/blocks', { username: leaverName });

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
// And it is reported as shared, which is what the clients mark it by.
expect(
  Array.isArray(sharedNow.body?.publicTags) && sharedNow.body.publicTags.includes('ours'),
  `shared game: publicTags ${JSON.stringify(sharedNow.body?.publicTags)}, expected to include "ours"`,
);
// The leaver's personal tag went with them, and was never shared.
expect(
  !sharedNow.body?.publicTags?.includes('mine') && !sharedNow.body?.tags?.includes('mine'),
  'shared game: the deleted account\'s personal tag is still on it',
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
// Nor anybody's block on the person who had the name before. This holds
// for two independent reasons — the rows go with the account, and the new
// owner has a different id anyway — so it passes even if the cleanup in
// DELETE /api/auth/me is removed. It is here for the promise, not as a
// guard on that statement.
const stayerBlocks = (await stayer('GET', '/api/blocks')).body;
expect(
  Array.isArray(stayerBlocks) && !stayerBlocks.includes(leaverName),
  `a deleted account is still on someone's blocked list: ${JSON.stringify(stayerBlocks)}`,
);
const retakenInvite = await reuse('POST', '/api/games', {
  size: 9,
  mode: 'remote',
  color: 'black',
  opponentUsername: stayerName,
});
expect(
  retakenInvite.status === 201,
  `re-registering the name: inherited the block too (${retakenInvite.status} ${retakenInvite.body?.error})`,
);

// --- Losing the password, and getting back in with the code -------------

const forgetful = session();
const forgetfulName = `fg${suffix}`;
const registered = await forgetful('POST', '/api/auth/register', {
  username: forgetfulName,
  password,
});
const firstCode = registered.body?.recoveryCode;
expect(typeof firstCode === 'string' && firstCode.length >= 16, `register: no recovery code (${firstCode})`);

// A code nobody was given doesn't open anything, and neither does a name
// that was never registered — and both are refused the same way.
const guessed = await forgetful('POST', '/api/auth/reset-password', {
  username: forgetfulName,
  recoveryCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
  newPassword: 'guessed-my-way-in',
});
expect(guessed.status === 400, `wrong code: got ${guessed.status}, expected a refusal`);
const nobody = await forgetful('POST', '/api/auth/reset-password', {
  username: `no${suffix}`,
  recoveryCode: firstCode,
  newPassword: 'guessed-my-way-in',
});
expect(nobody.status === 400, `unknown username: got ${nobody.status}, expected a refusal`);
expect(
  nobody.body?.error === guessed.body?.error,
  `unknown username answers "${nobody.body?.error}", a wrong code answers "${guessed.body?.error}" — they should match`,
);

// The real code sets a new password, and hands back the next one.
const reset = await forgetful('POST', '/api/auth/reset-password', {
  username: forgetfulName,
  // Typed by someone reading it off paper: lowercase, spaces, no dashes.
  recoveryCode: firstCode.toLowerCase().replace(/-/g, ' '),
  newPassword: 'brand-new-password',
});
expect(reset.status === 200, `reset: got ${reset.status} (${reset.body?.error})`);
const secondCode = reset.body?.recoveryCode;
expect(typeof secondCode === 'string' && secondCode !== firstCode, 'reset: no fresh code came back');

// The old password is gone, the new one works.
const stale = session();
const staleLogin = await stale('POST', '/api/auth/login', { username: forgetfulName, password });
expect(staleLogin.status >= 400, `after reset: the old password still logs in (${staleLogin.status})`);
const fresh = session();
const freshLogin = await fresh('POST', '/api/auth/login', {
  username: forgetfulName,
  password: 'brand-new-password',
});
expect(freshLogin.status < 400, `after reset: the new password doesn't log in (${freshLogin.body?.error})`);

// A code is spent once.
const reused = await fresh('POST', '/api/auth/reset-password', {
  username: forgetfulName,
  recoveryCode: firstCode,
  newPassword: 'third-password',
});
expect(reused.status === 400, `reusing a code: got ${reused.status}, expected a refusal`);

// The session that was open before the reset isn't any more.
const beforeReset = await forgetful('GET', '/api/auth/me');
expect(beforeReset.body?.user == null, 'after reset: the session from before is still signed in');

// A new code can be asked for with the password, and it replaces the last.
const regenerated = await fresh('POST', '/api/auth/recovery-code', { password: 'brand-new-password' });
expect(regenerated.status === 200, `new code: got ${regenerated.status} (${regenerated.body?.error})`);
expect(
  typeof regenerated.body?.recoveryCode === 'string' && regenerated.body.recoveryCode !== secondCode,
  'new code: the same code came back',
);
const supersededCode = await fresh('POST', '/api/auth/reset-password', {
  username: forgetfulName,
  recoveryCode: secondCode,
  newPassword: 'fourth-password',
});
expect(supersededCode.status === 400, `superseded code: got ${supersededCode.status}, expected a refusal`);
// ...and asking for one needs the password.
const noPassword = await fresh('POST', '/api/auth/recovery-code', { password: 'not-it' });
expect(noPassword.status === 400, `new code without the password: got ${noPassword.status}`);

// A deleted account keeps no key to anything.
const goner = session();
const gonerName = `gn${suffix}`;
const gonerCode = (await goner('POST', '/api/auth/register', { username: gonerName, password })).body?.recoveryCode;
await goner('DELETE', '/api/auth/me', { password });
const deadCode = await goner('POST', '/api/auth/reset-password', {
  username: gonerName,
  recoveryCode: gonerCode,
  newPassword: 'back-from-the-dead',
});
expect(deadCode.status === 400, `deleted account's code: got ${deadCode.status}, expected a refusal`);

// Guessing is throttled, whatever is being guessed.
let throttled = false;
for (let attempt = 0; attempt < 12; attempt += 1) {
  const response = await forgetful('POST', '/api/auth/reset-password', {
    username: forgetfulName,
    recoveryCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
    newPassword: 'guessed-my-way-in',
  });
  if (response.status === 429) {
    throttled = true;
    break;
  }
}
expect(throttled, 'guessing: a dozen attempts in a row were all allowed through');

if (failures.length === 0) {
  console.log(`Deleting an account and recovering one both behave (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
