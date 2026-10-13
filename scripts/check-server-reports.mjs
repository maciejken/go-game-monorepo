#!/usr/bin/env node
// Reporting a player, end to end against a running server. The point of a
// report, as against a block, is that it doesn't only hide the content
// from the person who objected to it — so most of this is about the
// record surviving, who may read it, and the block that can ride along.
//
//   node scripts/check-server-reports.mjs [baseUrl]
//
// Starts nothing: point it at a server with a scratch database. The admin
// half is skipped unless the server was started with ADMIN_USERNAME.
const base = process.argv[2] ?? 'http://localhost:3010';
const adminName = process.argv[3] ?? process.env.ADMIN_USERNAME ?? null;

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
const reporterName = `ra${suffix}`;
const targetName = `rb${suffix}`;

const reporter = session();
const target = session();
await reporter('POST', '/api/auth/register', { username: reporterName, password });
await target('POST', '/api/auth/register', { username: targetName, password });

// --- A report is accepted, and asks nothing of the reporter first ------

const plain = await reporter('POST', '/api/reports', { username: targetName, reason: 'username' });
expect(plain.status === 200, `reporting: got ${plain.status} (${plain.body?.error})`);
expect(plain.body?.reported === true, `reporting answered ${JSON.stringify(plain.body)}`);

// Reporting is not blocking: without asking, nothing about who may invite
// whom has changed.
const blocks = await reporter('GET', '/api/blocks');
expect(
  Array.isArray(blocks.body) && !blocks.body.includes(targetName),
  `a plain report blocked somebody: ${JSON.stringify(blocks.body)}`,
);

// --- The block that can ride along, in the same request ----------------

const withBlock = await reporter('POST', '/api/reports', {
  username: targetName,
  reason: 'behaviour',
  note: '  said something awful  ',
  block: true,
});
expect(withBlock.status === 200, `reporting with a block: got ${withBlock.status} (${withBlock.body?.error})`);
const afterBlock = await reporter('GET', '/api/blocks');
expect(
  Array.isArray(afterBlock.body) && afterBlock.body.includes(targetName),
  `block: true did not block: ${JSON.stringify(afterBlock.body)}`,
);

// And it blocks the way the blocks endpoint does — a pending invitation
// between the two goes with it, rather than only new ones being stopped.
const third = session();
const thirdName = `rc${suffix}`;
await third('POST', '/api/auth/register', { username: thirdName, password });
const invited = await third('POST', '/api/games', {
  size: 9,
  mode: 'remote',
  color: 'black',
  timeControl: 'unlimited',
  opponentUsername: reporterName,
});
expect(typeof invited.body?.id === 'string', `couldn't create an invitation (${JSON.stringify(invited.body)})`);
await reporter('POST', '/api/reports', { username: thirdName, reason: 'behaviour', block: true });
const goneGame = await reporter('GET', `/api/games/${invited.body?.id}`);
expect(goneGame.status === 404, `the pending invitation survived the block: got ${goneGame.status}`);

// --- What is refused ---------------------------------------------------

const self = await reporter('POST', '/api/reports', { username: reporterName, reason: 'username' });
expect(self.status === 400, `reporting yourself: got ${self.status}`);

const nobody = await reporter('POST', '/api/reports', { username: 'nosuchperson', reason: 'username' });
expect(nobody.status === 404, `reporting a nonexistent user: got ${nobody.status}`);

const nonsense = await reporter('POST', '/api/reports', { username: targetName, reason: 'because' });
expect(nonsense.status === 400, `an invented reason: got ${nonsense.status}`);

const anonymous = session();
const loggedOut = await anonymous('POST', '/api/reports', { username: targetName, reason: 'username' });
expect(loggedOut.status === 401, `reporting while logged out: got ${loggedOut.status}`);

// --- The queue is not public -------------------------------------------

const asReporter = await reporter('GET', '/api/reports');
expect(asReporter.status === 403, `an ordinary account read the report queue: got ${asReporter.status}`);
const asNobody = await anonymous('GET', '/api/reports');
expect(asNobody.status === 401, `a logged-out request read the report queue: got ${asNobody.status}`);

if (adminName) {
  const admin = session();
  // The suite runs on a scratch database, so the admin account named by
  // ADMIN_USERNAME has to be made first. Registering signs you in, which
  // is also why it is used instead of logging in: the login limiter is 5
  // per 15 minutes per address, and every checker shares 127.0.0.1.
  const signUp = await admin('POST', '/api/auth/register', { username: adminName, password });
  const signedIn =
    signUp.status < 300 ? signUp : await admin('POST', '/api/auth/login', { username: adminName, password });
  expect(signedIn.status < 300, `couldn't sign the admin in (${signedIn.body?.error})`);
  const queue = await admin('GET', '/api/reports');
  expect(queue.status === 200, `the admin couldn't read the queue: got ${queue.status}`);
  const mine = Array.isArray(queue.body) ? queue.body.filter((row) => row.reporter === reporterName) : [];
  expect(mine.length === 3, `the queue holds ${mine.length} of this run's reports, expected 3`);
  const noted = mine.find((row) => row.reason === 'behaviour' && row.target === targetName);
  // Trimmed on the way in, so the note reads as written rather than as typed.
  expect(noted?.note === 'said something awful', `the note came back as ${JSON.stringify(noted?.note)}`);
  expect(noted?.handled_at === null, 'a new report is already marked handled');
}

if (failures.length === 0) {
  console.log(`Reports are recorded, private, and not merely a block (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
