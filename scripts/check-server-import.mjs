#!/usr/bin/env node
// Publishes games to a running server the way a device does — POST
// /api/games/import — and checks what comes back out of the ordinary game
// endpoints afterwards. A published game is one the server never refereed,
// so what matters here is that it refuses the logs it should and that the
// ones it accepts read back as real games: right result, right board, right
// history.
//
//   node scripts/check-server-import.mjs [baseUrl]
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
  // A server that fell over answers with an HTML error page. That is a
  // result like any other here, and worth reporting as one rather than
  // crashing the checker on it.
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: { error: text.slice(0, 120) } };
  }
}

const move = (color, x, y) => ({ type: 'move', color, x, y });
const pass = (color) => ({ type: 'pass', color });

// Nobody is logged in yet: publishing is not something a passer-by may do.
const anonymous = await call('POST', '/api/games/import', {
  size: 9,
  events: [move('black', 0, 0), { type: 'resign', color: 'white' }],
});
expect(anonymous.status === 401, `anonymous publish: got ${anonymous.status}, expected 401`);

// Usernames here are capped at 12 characters.
const username = `imp${Date.now().toString(36).slice(-6)}`;
await call('POST', '/api/auth/register', { username, password: 'password123' });
await call('POST', '/api/auth/login', { username, password: 'password123' });

// A game that ended by resignation.
const resigned = await call('POST', '/api/games/import', {
  size: 9,
  handicap: 0,
  komi: 6.5,
  title: 'Published resignation',
  tags: ['offline'],
  events: [move('black', 2, 2), move('white', 6, 6), { type: 'resign', color: 'white' }],
});
expect(resigned.status === 201, `resignation: got ${resigned.status} (${resigned.body?.error})`);

if (resigned.body?.id) {
  const state = (await call('GET', `/api/games/${resigned.body.id}`)).body;
  expect(state.status === 'finished', `resignation: status ${state.status}, expected finished`);
  expect(state.shortResult === 'B+R', `resignation: shortResult ${state.shortResult}, expected B+R`);
  expect(state.board?.[2]?.[2] === 'black', 'resignation: black stone missing from the published board');
  expect(state.board?.[6]?.[6] === 'white', 'resignation: white stone missing from the published board');
  expect(state.title === 'Published resignation', `resignation: title ${state.title}`);
  expect(
    Array.isArray(state.tags) && state.tags.includes('offline'),
    `resignation: tags ${JSON.stringify(state.tags)}, expected to include offline`,
  );
  // The log is what everything else is derived from, so it has to be there
  // move for move — review mode steps through exactly these.
  const history = (await call('GET', `/api/games/${resigned.body.id}/history`)).body;
  const types = history.moves.map((entry) => entry.eventType);
  expect(
    JSON.stringify(types) === JSON.stringify(['START', 'MOVE', 'MOVE', 'RESIGN']),
    `resignation: history ${JSON.stringify(types)}`,
  );
  // And it belongs to the person who published it, in their list.
  const list = (await call('GET', '/api/games?scope=mine')).body;
  expect(
    list.some((game) => game.id === resigned.body.id),
    'resignation: the published game is missing from the publisher\'s list',
  );
}

// A game that was played out and counted. Black fills the left three
// columns of a 9x9 board, white the right three, and the middle column is
// left empty — a position with no dead stones to argue about.
const countedEvents = [];
for (let y = 0; y < 9; y += 1) {
  for (let x = 0; x < 3; x += 1) {
    countedEvents.push(move('black', x, y));
    countedEvents.push(move('white', 8 - x, y));
  }
}
countedEvents.push(pass('black'), pass('white'));

const counted = await call('POST', '/api/games/import', {
  size: 9,
  handicap: 0,
  komi: 6.5,
  events: countedEvents,
  deadPoints: [],
  sekiPoints: [],
});
expect(counted.status === 201, `counted: got ${counted.status} (${counted.body?.error})`);

if (counted.body?.id) {
  const state = (await call('GET', `/api/games/${counted.body.id}`)).body;
  expect(state.status === 'finished', `counted: status ${state.status}, expected finished`);
  // 27 stones plus 9 points of territory each, and komi decides it: white
  // by 6.5. The server counts this itself — the request said nothing about
  // a result.
  expect(state.shortResult === 'W+6.5', `counted: shortResult ${state.shortResult}, expected W+6.5`);
}

// A handicap game: the placement is the server's to make, so the stones are
// on the board even though the request never described them.
const handicapGame = await call('POST', '/api/games/import', {
  size: 9,
  handicap: 4,
  komi: 0.5,
  events: [move('white', 4, 4), { type: 'resign', color: 'white' }],
});
expect(handicapGame.status === 201, `handicap: got ${handicapGame.status} (${handicapGame.body?.error})`);
if (handicapGame.body?.id) {
  const state = (await call('GET', `/api/games/${handicapGame.body.id}`)).body;
  expect(state.board?.[2]?.[2] === 'black', 'handicap: the placement is missing from the published board');
  expect(state.shortResult === 'B+R', `handicap: shortResult ${state.shortResult}, expected B+R`);
}

// What must not get through. Every one of these is a log a device could
// send but no game could have produced.
const refusals = [
  {
    what: 'a game that never ended',
    body: { size: 9, events: [move('black', 2, 2), move('white', 6, 6)] },
  },
  {
    what: 'playing out of turn',
    body: { size: 9, events: [move('black', 2, 2), move('black', 3, 3), { type: 'resign', color: 'white' }] },
  },
  {
    what: 'two stones on one point',
    body: { size: 9, events: [move('black', 2, 2), move('white', 2, 2), { type: 'resign', color: 'white' }] },
  },
  {
    what: 'a stone off the board',
    body: { size: 9, events: [move('black', 20, 20), { type: 'resign', color: 'white' }] },
  },
  {
    // Black to play and a legal point: nothing but "the game is over"
    // stands in the way of this one.
    what: 'a move after the game ended',
    body: {
      size: 9,
      events: [move('black', 2, 2), { type: 'resign', color: 'white' }, move('black', 4, 4)],
    },
  },
  {
    what: 'suicide',
    body: {
      size: 9,
      events: [
        move('black', 1, 0),
        move('white', 8, 8),
        move('black', 0, 1),
        move('white', 0, 0),
        { type: 'resign', color: 'black' },
      ],
    },
  },
  {
    what: 'a board size nobody plays on',
    body: { size: 11, events: [{ type: 'resign', color: 'white' }] },
  },
  {
    what: 'a game with no moves at all',
    body: { size: 9, events: 'all of them' },
  },
];

for (const refusal of refusals) {
  const response = await call('POST', '/api/games/import', refusal.body);
  expect(
    response.status === 400,
    `${refusal.what}: got ${response.status} (${JSON.stringify(response.body)}), expected a refusal`,
  );
}

// Nothing that was refused left a game behind.
const finalList = (await call('GET', '/api/games?scope=mine')).body;
expect(
  finalList.length === 3,
  `after the refusals: ${finalList.length} games in the list, expected the 3 that were accepted`,
);

if (failures.length === 0) {
  console.log(`Server accepts and refuses published games as it should (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
