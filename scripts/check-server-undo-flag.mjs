#!/usr/bin/env node
// UNDO_ENABLED, end to end. The flag is read when the server starts, so this
// starts servers itself rather than being pointed at one: first with undo on,
// to leave a request waiting for an answer, then with it off on the same
// database, to see that the request no longer holds the game up.
//
//   node scripts/check-server-undo-flag.mjs [portOn] [portOff]
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portOn = Number(process.argv[2] ?? 3012);
const portOff = Number(process.argv[3] ?? 3013);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-flag-'));
const dbPath = path.join(workDir, 'undo.db');

const failures = [];
let checked = 0;
function expect(condition, describe) {
  checked += 1;
  if (!condition) {
    failures.push(describe);
  }
}

function start(port, extraEnv) {
  const child = spawn('npx', ['tsx', 'server/src/server.ts'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), REGISTER_RATE_LIMIT: '1000', LOGIN_RATE_LIMIT: '1000', ...extraEnv },
    stdio: 'ignore',
  });
  return child;
}

async function ready(port) {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://localhost:${port}/api/auth/me`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`server on ${port} did not start`);
}

function stop(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
}

function session(port) {
  let cookie = '';
  return async (method, urlPath, body) => {
    const response = await fetch(`http://localhost:${port}${urlPath}`, {
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

let server = null;
try {
  // --- On (the default): undo works, and a request blocks the game -------
  server = start(portOn, {});
  await ready(portOn);
  const alice = session(portOn);
  const bob = session(portOn);
  const password = 'password123';
  await alice('POST', '/api/auth/register', { username: 'alice', password });
  await bob('POST', '/api/auth/register', { username: 'bobby', password });

  const features = (await alice('GET', '/api/auth/me')).body?.features;
  expect(features?.undo === true, `undo should be on by default: ${JSON.stringify(features)}`);

  const created = await alice('POST', '/api/games', {
    size: 9, mode: 'remote', color: 'black', timeControl: 'unlimited', opponentUsername: 'bobby',
  });
  const gameId = created.body?.id;
  expect(typeof gameId === 'string', `couldn't create the game (${JSON.stringify(created.body)})`);
  await bob('POST', `/api/games/${gameId}/respond-invite`, { accept: true });
  const first = await alice('POST', `/api/games/${gameId}/moves`, { x: 4, y: 4, color: 'black' });
  expect(first.status === 200, `black's first move: got ${first.status}`);

  const requested = await bob('POST', `/api/games/${gameId}/undo`);
  expect(requested.body?.action === 'requested', `a request: ${JSON.stringify(requested.body)}`);
  const blocked = await bob('POST', `/api/games/${gameId}/moves`, { x: 2, y: 2, color: 'white' });
  expect(blocked.status === 400, `a move while a request waits: got ${blocked.status}`);

  await stop(server);
  server = null;

  // --- Off: the same database, the request gone, the endpoint closed -----
  server = start(portOff, { UNDO_ENABLED: 'false' });
  await ready(portOff);
  const bob2 = session(portOff);
  await bob2('POST', '/api/auth/login', { username: 'bobby', password });

  const offFeatures = (await bob2('GET', '/api/auth/me')).body?.features;
  expect(offFeatures?.undo === false, `UNDO_ENABLED=false should say so: ${JSON.stringify(offFeatures)}`);

  const state = (await bob2('GET', `/api/games/${gameId}`)).body;
  expect(state?.pendingUndoBy === null, `the waiting request survived the restart: ${JSON.stringify(state?.pendingUndoBy)}`);
  const free = await bob2('POST', `/api/games/${gameId}/moves`, { x: 2, y: 2, color: 'white' });
  expect(free.status === 200, `a move after the request was dropped: got ${free.status} (${free.body?.error})`);

  const refused = await bob2('POST', `/api/games/${gameId}/undo`);
  expect(refused.status === 403, `undo while switched off: got ${refused.status}`);
  expect(refused.body?.errorKey === 'Undo is turned off', `the refusal's key: ${JSON.stringify(refused.body)}`);
} finally {
  if (server) {
    await stop(server);
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (failures.length === 0) {
  console.log(`UNDO_ENABLED switches undo off, and drops a waiting request (${checked} assertions).`);
  process.exit(0);
}
console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
