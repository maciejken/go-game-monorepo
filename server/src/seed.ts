import { randomBytes, randomUUID } from 'crypto';
import db from './db.js';
import { hashPassword } from './auth.js';

const DEFAULT_USERNAME = process.env.DEFAULT_USERNAME;
const DEFAULT_USER_PASSWORD = process.env.DEFAULT_USER_PASSWORD;

// Every game created before multi-user auth existed was really just one
// person playing both sides on the same device — that maps directly onto
// today's "local game" shape (black_user_id === white_user_id). Seeding a
// default account and backfilling old rows onto it keeps that history
// playable without inventing per-game ownership after the fact.
//
// The password is never hardcoded: it comes from DEFAULT_USER_PASSWORD if
// set, otherwise a random one is generated and printed once — the only
// place it's ever recoverable, since only its hash is stored.
export function seedDefaultUser(): void {
  if (!DEFAULT_USERNAME) {
    console.warn(
      'DEFAULT_USERNAME is not set — skipping default-user seeding. ' +
        'Any pre-auth games will stay unowned until this is set and the server is restarted.',
    );
    return;
  }

  let defaultUser = db.prepare('SELECT id FROM users WHERE username = ?').get(DEFAULT_USERNAME) as
    | { id: string }
    | undefined;

  if (!defaultUser) {
    const password = DEFAULT_USER_PASSWORD || randomBytes(9).toString('base64url');
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      DEFAULT_USERNAME,
      hashPassword(password),
      Date.now(),
    );
    defaultUser = { id };

    if (!DEFAULT_USER_PASSWORD) {
      console.log('');
      console.log(`Created default user "${DEFAULT_USERNAME}" (owns all pre-auth games) with password: ${password}`);
      console.log('This is shown once — save it now. Set DEFAULT_USER_PASSWORD to control it instead.');
      console.log('');
    }
  }

  db.prepare('UPDATE games SET black_user_id = ?, white_user_id = ? WHERE black_user_id IS NULL')
    .run(defaultUser.id, defaultUser.id);
}
