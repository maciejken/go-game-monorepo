#!/usr/bin/env node
// Drives shared/fixtures/game-flow.json through a running server's real HTTP
// API and checks what it answers. The same cases are checked against the
// Swift engine by scripts/check-swift-rules.sh, so "the device agrees with
// the server" is something the two together actually demonstrate.
//
//   node scripts/check-server-flow.mjs [baseUrl]
//
// Starts nothing: point it at a server with a scratch database, never at
// production — it creates games and plays them out.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://localhost:3010';
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'shared/fixtures/game-flow.json'), 'utf8'));

if (fixtures.version !== 1) {
  console.error(`fixtures are version ${fixtures.version}; this checker understands 1`);
  process.exit(2);
}

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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const username = `flow${Date.now().toString(36)}`;
await call('POST', '/api/auth/register', { username, password: 'password123' });
await call('POST', '/api/auth/login', { username, password: 'password123' });

for (const testCase of fixtures.cases) {
  // A local game: one account holds both colours, so every action in a
  // case can be sent by this one session.
  const created = await call('POST', '/api/games', {
    size: testCase.size,
    handicap: testCase.handicap,
    mode: 'local',
    color: 'black',
  });
  const gameId = created.body?.id;
  if (!gameId) {
    failures.push(`${testCase.name}: could not create the game (${JSON.stringify(created.body)})`);
    continue;
  }

  const opening = (await call('GET', `/api/games/${gameId}`)).body;
  expect(
    opening.currentColor === testCase.opening.currentColor,
    `${testCase.name} [opening]: currentColor ${opening.currentColor}, expected ${testCase.opening.currentColor}`,
  );
  expect(
    opening.status === testCase.opening.status,
    `${testCase.name} [opening]: status ${opening.status}, expected ${testCase.opening.status}`,
  );

  for (const [index, action] of testCase.actions.entries()) {
    const where = `${testCase.name} [action ${index + 1}: ${action.type} ${action.color}]`;
    let response;
    if (action.type === 'move') {
      response = await call('POST', `/api/games/${gameId}/moves`, { x: action.x, y: action.y, color: action.color });
    } else if (action.type === 'pass') {
      response = await call('POST', `/api/games/${gameId}/pass`, { color: action.color });
    } else {
      response = await call('POST', `/api/games/${gameId}/resign`, { color: action.color });
    }

    const expected = action.expect ?? {};
    if (expected.rejected) {
      expect(response.status >= 400, `${where}: expected a refusal, got ${response.status}`);
      expect(
        response.body?.errorKey === expected.rejected || response.body?.error === expected.rejected,
        `${where}: refused with "${response.body?.error}", expected "${expected.rejected}"`,
      );
    } else {
      expect(response.status < 400, `${where}: server refused it (${response.body?.error})`);
    }

    const state = (await call('GET', `/api/games/${gameId}`)).body;
    if (expected.status) {
      expect(state.status === expected.status, `${where}: status ${state.status}, expected ${expected.status}`);
    }
    if (expected.currentColor) {
      expect(
        state.currentColor === expected.currentColor,
        `${where}: currentColor ${state.currentColor}, expected ${expected.currentColor}`,
      );
    }
    if (expected.shortResult) {
      expect(
        state.shortResult === expected.shortResult,
        `${where}: shortResult ${state.shortResult}, expected ${expected.shortResult}`,
      );
    }
    if (expected.captures) {
      expect(
        state.captures?.black === expected.captures.black && state.captures?.white === expected.captures.white,
        `${where}: captures ${JSON.stringify(state.captures)}, expected ${JSON.stringify(expected.captures)}`,
      );
    }
  }
}

if (failures.length === 0) {
  console.log(`Server agrees with ${fixtures.cases.length} game-flow cases (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
