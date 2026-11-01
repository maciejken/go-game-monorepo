#!/usr/bin/env node
// What a tag may be, end to end against a running server: how long, and how
// many on a game. The length is repeated in the web client's input and the iOS
// app's field, which stop the typing; this is the one that actually refuses.
//
//   node scripts/check-server-tags.mjs [baseUrl]
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

const MAX_LENGTH = 16;
const suffix = Date.now().toString(36).slice(-5);
const player = session();
await player('POST', '/api/auth/register', { username: `tg${suffix}`, password: 'password123' });
const game = await player('POST', '/api/games', { size: 9, mode: 'local', color: 'black', timeControl: 'unlimited' });
const gameId = game.body?.id;
expect(typeof gameId === 'string', `couldn't create a game (${JSON.stringify(game.body)})`);

const atLimit = 'a'.repeat(MAX_LENGTH);
const overLimit = 'a'.repeat(MAX_LENGTH + 1);

const accepted = await player('POST', `/api/games/${gameId}/tags`, { tag: atLimit, isPublic: false });
expect(accepted.status < 300, `a ${MAX_LENGTH}-character tag: got ${accepted.status} (${accepted.body?.error})`);

const refused = await player('POST', `/api/games/${gameId}/tags`, { tag: overLimit, isPublic: false });
expect(refused.status === 400, `a ${MAX_LENGTH + 1}-character tag: got ${refused.status}`);
expect(
  refused.body?.errorParams?.[0] === String(MAX_LENGTH),
  `the refusal should name the limit ${MAX_LENGTH}: ${JSON.stringify(refused.body)}`,
);

// Tags that ride along on a new game are cleaned by the same rule, and a bad
// one is dropped rather than failing the game.
const withTags = await player('POST', '/api/games', {
  size: 9, mode: 'local', color: 'black', timeControl: 'unlimited', tags: [atLimit.replace(/a/, 'b'), overLimit],
});
expect(withTags.status === 201, `a game created with a too-long tag among its tags: got ${withTags.status}`);
const kept = (await player('GET', `/api/games/${withTags.body?.id}`)).body?.tags ?? [];
expect(kept.length === 1 && kept[0].length === MAX_LENGTH, `only the tag within the limit survives: ${JSON.stringify(kept)}`);

if (failures.length === 0) {
  console.log(`Tags are held to ${MAX_LENGTH} characters (${checked} assertions).`);
  process.exit(0);
}
console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
