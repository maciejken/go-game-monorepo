#!/usr/bin/env node
// Blocking, end to end against a running server. The point of the feature
// is what the blocked person can see: nothing. So most of what is checked
// here is that a block is indistinguishable from the account-wide
// "accepts invitations" switch being off — same absence from search, same
// refusal, same wording.
//
//   node scripts/check-server-blocks.mjs [baseUrl]
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

// One jar per person: several of these have to be logged in at once.
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

// Usernames are capped at 12 characters and are [a-z0-9_].
const hostName = `bh${suffix}`; // does the blocking
const pestName = `bp${suffix}`; // gets blocked
const otherName = `bo${suffix}`; // uninvolved, and must stay unaffected

const host = session();
const pest = session();
const other = session();

await host('POST', '/api/auth/register', { username: hostName, password });
await pest('POST', '/api/auth/register', { username: pestName, password });
await other('POST', '/api/auth/register', { username: otherName, password });

const invite = (as, opponentUsername) =>
  as('POST', '/api/games', { size: 9, mode: 'remote', color: 'black', opponentUsername });
const search = async (as, query) => {
  const response = await as('GET', `/api/users/search?q=${query}`);
  return Array.isArray(response.body) ? response.body.map((row) => row.username) : [];
};

// --- Before any of it, the two can see and invite each other ------------

expect((await search(pest, hostName)).includes(hostName), 'before blocking: the pest cannot even find the host');
const firstInvite = await invite(pest, hostName);
expect(firstInvite.status === 201, `before blocking: inviting failed (${firstInvite.status})`);
const pendingId = firstInvite.body?.id;

// --- The block ----------------------------------------------------------

const blocked = await host('POST', '/api/blocks', { username: pestName });
expect(blocked.status === 204, `blocking: got ${blocked.status} (${blocked.body?.error})`);

const list = await host('GET', '/api/blocks');
expect(
  Array.isArray(list.body) && list.body.includes(pestName),
  `the blocked list reads ${JSON.stringify(list.body)}, expected to include ${pestName}`,
);

// The invitation that was already waiting is gone — as it would never have
// existed had the block been in place. Quietly: the pest is not told.
if (pendingId) {
  const gone = await host('GET', `/api/games/${pendingId}`);
  expect(gone.status === 404, `after blocking: the pending invite survived (${gone.status})`);
}

// --- What the blocked person can tell -----------------------------------

expect(!(await search(pest, hostName)).includes(hostName), 'after blocking: the host still turns up in search');

const refused = await invite(pest, hostName);
expect(refused.status === 400, `after blocking: inviting got ${refused.status}, expected a refusal`);

// The wording has to match a name that was never registered, or the
// difference itself is the disclosure.
const unknown = await invite(pest, `zz${suffix}`);
expect(
  refused.body?.error === unknown.body?.error,
  `blocked answers "${refused.body?.error}", an unknown name answers "${unknown.body?.error}" — they should match`,
);

// Nothing about being blocked reaches the blocked account itself: it is
// still logged in, with a working session, and no endpoint tells it.
const pestStillIn = await pest('GET', '/api/auth/me');
expect(pestStillIn.body?.user?.username === pestName, 'the blocked account lost its session');

// --- Everyone else is unaffected ----------------------------------------

expect((await search(other, hostName)).includes(hostName), 'a block leaked onto an uninvolved user\'s search');
const bystander = await invite(other, hostName);
expect(bystander.status === 201, `an uninvolved user was refused too (${bystander.status})`);

// --- One direction only -------------------------------------------------

// Blocking says who may not invite *you*. It makes no claim on what you
// may do, so the host can still invite the pest.
const hostInvitesPest = await invite(host, pestName);
expect(hostInvitesPest.status === 201, `blocking also stopped the blocker inviting (${hostInvitesPest.status})`);

// --- Idempotence and the obvious misuses --------------------------------

const again = await host('POST', '/api/blocks', { username: pestName });
expect(again.status === 204, `blocking twice: got ${again.status}, expected it to be a no-op`);
const listAgain = await host('GET', '/api/blocks');
expect(
  listAgain.body?.filter((name) => name === pestName).length === 1,
  `blocking twice left ${JSON.stringify(listAgain.body)}`,
);

const self = await host('POST', '/api/blocks', { username: hostName });
expect(self.status === 400, `blocking yourself: got ${self.status}, expected a refusal`);

const nobody = await host('POST', '/api/blocks', { username: `no${suffix}` });
expect(nobody.status === 404, `blocking a nonexistent user: got ${nobody.status}`);

const anonymous = session();
for (const [method, urlPath, body] of [
  ['GET', '/api/blocks', undefined],
  ['POST', '/api/blocks', { username: hostName }],
  ['DELETE', `/api/blocks/${pestName}`, undefined],
]) {
  const response = await anonymous(method, urlPath, body);
  expect(response.status === 401, `${method} ${urlPath} while logged out: got ${response.status}`);
}

// --- Unblocking puts it all back ----------------------------------------

const unblocked = await host('DELETE', `/api/blocks/${pestName}`);
expect(unblocked.status === 204, `unblocking: got ${unblocked.status}`);
const emptied = await host('GET', '/api/blocks');
expect(
  Array.isArray(emptied.body) && emptied.body.length === 0,
  `after unblocking: the list reads ${JSON.stringify(emptied.body)}`,
);
expect((await search(pest, hostName)).includes(hostName), 'after unblocking: the host is still hidden');
const invitesAgain = await invite(pest, hostName);
expect(invitesAgain.status === 201, `after unblocking: inviting still refused (${invitesAgain.status})`);

// What a deleted account leaves on other people's blocked lists is
// checked in check-server-account.mjs, which already registers, deletes
// and re-registers an account — registration is rate limited per address,
// and the whole suite shares one.

if (failures.length === 0) {
  console.log(`Blocking hides exactly what it should (${checked} assertions).`);
  process.exit(0);
}

console.log(`${failures.length} of ${checked} assertions failed:`);
for (const failure of failures) {
  console.log(`  - ${failure}`);
}
process.exit(1);
