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
// between the two goes with it, rather than only new ones being stopped —
// except the one the report was made from, which the reporter is still
// looking at: it goes when they reject it, not when the report is sent.
const third = session();
const thirdName = `rc${suffix}`;
await third('POST', '/api/auth/register', { username: thirdName, password });
const invited = await third('POST', '/api/games', {
  size: 9,
  mode: 'remote',
  color: 'black',
  timeControl: 'unlimited',
  opponentUsername: reporterName,
  title: 'Rude title',
});
expect(typeof invited.body?.id === 'string', `couldn't create an invitation (${JSON.stringify(invited.body)})`);
// A shared tag, which is the kind both players see — a personal one is
// the creator's alone and could not have been what the reporter objected to.
await third('POST', `/api/games/${invited.body?.id}/tags`, { tag: 'rudetag', isPublic: true });
// Reported from the invitation, where the offending text is seen: the
// report names the game, and the block must leave it standing.
await reporter('POST', '/api/reports', {
  username: thirdName,
  reason: 'game_text',
  gameId: invited.body?.id,
  block: true,
});
const keptGame = await reporter('GET', `/api/games/${invited.body?.id}`);
expect(keptGame.status === 200, `the reported invitation was deleted by the report: got ${keptGame.status}`);
const otherInvite = await third('POST', '/api/games', {
  size: 9,
  mode: 'remote',
  color: 'black',
  timeControl: 'unlimited',
  opponentUsername: reporterName,
});
// The block is in force, so a second invitation cannot even be sent.
expect(otherInvite.status === 400, `inviting a blocker: got ${otherInvite.status}`);
const rejected = await reporter('POST', `/api/games/${invited.body?.id}/respond-invite`, { accept: false });
expect(rejected.status < 300, `rejecting the reported invitation: got ${rejected.status}`);
const goneGame = await reporter('GET', `/api/games/${invited.body?.id}`);
expect(goneGame.status === 404, `the rejected invitation survived: got ${goneGame.status}`);

// --- What is refused ---------------------------------------------------

const self = await reporter('POST', '/api/reports', { username: reporterName, reason: 'username' });
expect(self.status === 400, `reporting yourself: got ${self.status}`);

const nobody = await reporter('POST', '/api/reports', { username: 'nosuchperson', reason: 'username' });
expect(nobody.status === 404, `reporting a nonexistent user: got ${nobody.status}`);

const nonsense = await reporter('POST', '/api/reports', { username: targetName, reason: 'because' });
expect(nonsense.status === 400, `an invented reason: got ${nonsense.status}`);

// GNU Go is an account like any other as far as the table is concerned,
// and nothing about it is anybody's doing: the server named it and it
// writes no titles or tags, so there is nothing to act on.
const robot = await reporter('POST', '/api/reports', { username: 'gnugo', reason: 'username' });
expect(robot.status === 400, `reporting the computer opponent: got ${robot.status}`);
// And the server says which account that is, which is how a client knows
// not to offer the buttons in the first place — on the profile, since
// that is the screen with the buttons on it.
const found = await reporter('GET', '/api/users/search?q=gnugo');
const robotRow = Array.isArray(found.body) ? found.body.find((row) => row.username === 'gnugo') : undefined;
expect(robotRow !== undefined, 'the computer opponent is missing from search, so the check above proves nothing');
expect(robotRow?.isAi === true, `search does not mark the computer opponent: ${JSON.stringify(robotRow)}`);

// Its id is only reachable through a game against it, so this part needs
// a server that actually has GNU Go. Skipped rather than failed where it
// is absent: the refusal above is the part that must hold everywhere.
const features = (await reporter('GET', '/api/auth/me')).body?.features;
if (features?.gnugo === true) {
  const aiGame = await reporter('POST', '/api/games', {
    size: 9,
    mode: 'gnugo',
    color: 'black',
    timeControl: 'unlimited',
  });
  // Black was asked for above, so the other side is the one to look up.
  const state = (await reporter('GET', `/api/games/${aiGame.body?.id}`)).body;
  const aiId = state?.whiteUserId;
  const profile = aiId ? (await reporter('GET', `/api/users/${aiId}`)).body : null;
  expect(profile?.username === 'gnugo', `the AI game's opponent is ${JSON.stringify(profile?.username)}`);
  expect(profile?.isAi === true, `the profile does not mark the computer opponent: ${JSON.stringify(profile)}`);
} else {
  console.log('  (no GNU Go on this server — skipped the AI profile check)');
}

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
  // What was reported outlives the game it was on: rejecting it deleted
  // that game, and the report still says what the title and tags were.
  const aboutGame = mine.find((row) => row.reason === 'game_text');
  expect(aboutGame?.game_title === 'Rude title', `the title was lost with the game: ${JSON.stringify(aboutGame?.game_title)}`);
  expect(
    JSON.stringify(aboutGame?.game_tags) === JSON.stringify(['rudetag']),
    `the tags were lost with the game: ${JSON.stringify(aboutGame?.game_tags)}`,
  );
  expect(aboutGame?.target === thirdName, `the target is ${JSON.stringify(aboutGame?.target)}`);
  const noTitle = mine.find((row) => row.reason === 'username');
  expect(noTitle?.game_title === null && Array.isArray(noTitle?.game_tags) && noTitle.game_tags.length === 0,
    `a report with no game carries ${JSON.stringify([noTitle?.game_title, noTitle?.game_tags])}`);
  const noted = mine.find((row) => row.reason === 'behaviour' && row.target === targetName);
  // Trimmed on the way in, so the note reads as written rather than as typed.
  expect(noted?.note === 'said something awful', `the note came back as ${JSON.stringify(noted?.note)}`);
  expect(noted?.handled_at === null, 'a new report is already marked handled');

  // --- Dealing with one takes it out of the queue, not out of the table -

  const handled = await admin('POST', `/api/reports/${noted?.id}/handled`);
  expect(handled.status === 204, `marking a report handled: got ${handled.status} (${handled.body?.error})`);
  const afterHandling = (await admin('GET', '/api/reports')).body ?? [];
  const sameReport = afterHandling.find((row) => row.id === noted?.id);
  expect(sameReport !== undefined, 'marking a report handled deleted it');
  expect(typeof sameReport?.handled_at === 'number', `handled_at is ${JSON.stringify(sameReport?.handled_at)}`);

  // Marking it again keeps the time it was first dealt with, so a second
  // tap can't rewrite when it happened.
  const firstTime = sameReport?.handled_at;
  const again = await admin('POST', `/api/reports/${noted?.id}/handled`);
  expect(again.status === 204, `marking a handled report again: got ${again.status}`);
  const afterTwice = ((await admin('GET', '/api/reports')).body ?? []).find((row) => row.id === noted?.id);
  expect(afterTwice?.handled_at === firstTime, 'marking twice moved the time it was handled');

  const missing = await admin('POST', '/api/reports/does-not-exist/handled');
  expect(missing.status === 404, `marking a nonexistent report: got ${missing.status}`);

  // And it is the admin's to do, like reading the queue.
  const byOther = await reporter('POST', `/api/reports/${noted?.id}/handled`);
  expect(byOther.status === 403, `an ordinary account marked a report handled: got ${byOther.status}`);

  // A report about the admin says so, so the page can leave out the one
  // action the server would refuse; the others say they are about somebody else.
  await target('POST', '/api/reports', { username: adminName, reason: 'behaviour' });
  const queueNow = (await admin('GET', '/api/reports')).body ?? [];
  const aboutAdmin = queueNow.find((row) => row.target === adminName);
  expect(aboutAdmin?.target_is_me === true, `a report about the admin isn't marked as theirs: ${JSON.stringify(aboutAdmin?.target_is_me)}`);
  expect(
    queueNow.filter((row) => row.target !== adminName).every((row) => row.target_is_me === false),
    'a report about somebody else is marked as the admin\'s own',
  );

  // --- Suspending: off the service, not out of the table ----------------

  const victim = session();
  const victimName = `rv${suffix}`;
  const victimId = (await victim('POST', '/api/auth/register', { username: victimName, password })).body?.id;
  // An invitation the victim sent, still waiting: it should not outlive
  // the suspension, since nobody could answer for them.
  const inFlight = await victim('POST', '/api/games', {
    size: 9,
    mode: 'remote',
    color: 'black',
    timeControl: 'unlimited',
    opponentUsername: reporterName,
  });
  expect(typeof inFlight.body?.id === 'string', `couldn't create the victim's invitation (${JSON.stringify(inFlight.body)})`);

  const ordinary = await reporter('POST', `/api/users/${victimId}/suspend`);
  expect(ordinary.status === 403, `an ordinary account suspended somebody: got ${ordinary.status}`);
  const adminSelf = await admin('POST', `/api/users/${signedIn.body?.id}/suspend`);
  expect(adminSelf.status === 400, `the admin suspended themselves: got ${adminSelf.status}`);
  const unknown = await admin('POST', '/api/users/no-such-id/suspend');
  expect(unknown.status === 404, `suspending a nonexistent user: got ${unknown.status}`);

  const suspend = await admin('POST', `/api/users/${victimId}/suspend`);
  expect(suspend.status === 204, `suspending: got ${suspend.status} (${suspend.body?.error})`);
  // Suspending twice is no harm, and keeps the first time.
  const suspendAgain = await admin('POST', `/api/users/${victimId}/suspend`);
  expect(suspendAgain.status === 204, `suspending twice: got ${suspendAgain.status}`);

  // Signed out at once, on the device that was in use.
  const whoAmI = await victim('GET', '/api/auth/me');
  expect(whoAmI.body?.user === null, `a suspended account kept its session: ${JSON.stringify(whoAmI.body?.user)}`);
  const stillActing = await victim('GET', '/api/blocks');
  expect(stillActing.status === 401, `a suspended account still reached the API: got ${stillActing.status}`);

  // Can't sign back in, and is told why — but only with the right password.
  const fresh = session();
  const refused = await fresh('POST', '/api/auth/login', { username: victimName, password });
  expect(refused.status === 403, `logging in while suspended: got ${refused.status}`);
  expect(
    refused.body?.errorParams?.[0] === 'support@igo5.online',
    `the refusal doesn't say where to write: ${JSON.stringify(refused.body)}`,
  );
  const wrongPassword = await fresh('POST', '/api/auth/login', { username: victimName, password: 'not-the-password' });
  expect(wrongPassword.status === 401, `a wrong password on a suspended account: got ${wrongPassword.status}`);

  // Gone from search and invitations, and the pending invitation with it.
  const search = await reporter('GET', `/api/users/search?q=${victimName}`);
  expect(
    Array.isArray(search.body) && !search.body.some((row) => row.username === victimName),
    `a suspended account is still in search: ${JSON.stringify(search.body)}`,
  );
  const inviteSuspended = await reporter('POST', '/api/games', {
    size: 9,
    mode: 'remote',
    color: 'black',
    timeControl: 'unlimited',
    opponentUsername: victimName,
  });
  expect(inviteSuspended.status === 400, `inviting a suspended account: got ${inviteSuspended.status}`);
  const goneInvite = await reporter('GET', `/api/games/${inFlight.body?.id}`);
  expect(goneInvite.status === 404, `the suspended account's invitation survived: got ${goneInvite.status}`);

  // The queue says so, for the report about them.
  await reporter('POST', '/api/reports', { username: victimName, reason: 'behaviour' });
  const aboutVictim = ((await admin('GET', '/api/reports')).body ?? []).find((row) => row.target === victimName);
  expect(
    typeof aboutVictim?.target_suspended_at === 'number',
    `the queue doesn't show the suspension: ${JSON.stringify(aboutVictim?.target_suspended_at)}`,
  );

  // And it can be lifted: the account is as it was.
  const lift = await admin('POST', `/api/users/${victimId}/unsuspend`);
  expect(lift.status === 204, `lifting the suspension: got ${lift.status}`);
  const back = await fresh('POST', '/api/auth/login', { username: victimName, password });
  expect(back.status === 200, `logging in after the suspension was lifted: got ${back.status}`);
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
