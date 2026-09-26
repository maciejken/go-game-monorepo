#!/usr/bin/env node
// Sets a password from the server's own machine, for the one case the
// recovery code can't cover: somebody lost both. Run it on the box, as the
// user the server runs as.
//
//   DB_PATH=/home/pi/projects/go-server/data/go.db \
//     node scripts/set-password.mjs <username> [newPassword]
//
// With no password given, one is generated and printed. Every other
// session for that account is ended, the same as a password change through
// the app.
//
// It imports the server's own hashing rather than reimplementing it: the
// stored format is salt:scrypt(password, salt, 64) with Node's defaults,
// and a second implementation of that is a second thing to get wrong.
import { randomBytes } from 'crypto';
import { hashPassword } from '../server/dist/auth.js';
import db from '../server/dist/db.js';

const [username, givenPassword] = process.argv.slice(2);

if (!username) {
  console.error('usage: node scripts/set-password.mjs <username> [newPassword]');
  process.exit(2);
}

const user = db
  .prepare('SELECT id, username, deleted_at FROM users WHERE username = ?')
  .get(username);

if (!user) {
  console.error(`No account called "${username}".`);
  process.exit(1);
}
if (user.deleted_at) {
  console.error(`"${username}" is a deleted account, not a person. Nothing to set.`);
  process.exit(1);
}

// Long enough that it doesn't matter that it travels by whatever means you
// use to tell them.
const password = givenPassword ?? randomBytes(9).toString('base64url');

db.transaction(() => {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
})();

console.log(`Password set for ${user.username}. Every session was ended.`);
if (!givenPassword) {
  console.log(`New password: ${password}`);
}
