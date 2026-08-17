import { randomBytes, randomUUID } from 'crypto';
import db from './db.js';
import { hashPassword } from './auth.js';
import { defaultUsername, defaultPassword } from './config.js';
// Every game created before multi-user auth existed was really just one
// person playing both sides on the same device — that maps directly onto
// today's "local game" shape (black_user_id === white_user_id). Seeding a
// default account and backfilling old rows onto it keeps that history
// playable without inventing per-game ownership after the fact.
//
// The password is never hardcoded: it comes from defaultPassword if
// set, otherwise a random one is generated and printed once — the only
// place it's ever recoverable, since only its hash is stored.
export function seedDefaultUser() {
    if (!defaultUsername) {
        console.warn('defaultUsername is not set — skipping default-user seeding. ' +
            'Any pre-auth games will stay unowned until this is set and the server is restarted.');
        return;
    }
    let defaultUser = db.prepare('SELECT id FROM users WHERE username = ?').get(defaultUsername);
    if (!defaultUser) {
        const password = defaultPassword || randomBytes(9).toString('base64url');
        const id = randomUUID();
        db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, defaultUsername, hashPassword(password), Date.now());
        defaultUser = { id };
        if (!defaultPassword) {
            console.log('');
            console.log(`Created default user "${defaultUsername}" (owns all pre-auth games) with password: ${password}`);
            console.log('This is shown once — save it now. Set defaultPassword to control it instead.');
            console.log('');
        }
    }
    db.prepare('UPDATE games SET black_user_id = ?, white_user_id = ? WHERE black_user_id IS NULL')
        .run(defaultUser.id, defaultUser.id);
}
const AI_USERNAME = 'gnugo';
let aiUserId = null;
// A reserved account representing the GNU Go engine as an opponent — not a
// real login (its password is a random value nobody is ever told), just a
// stable user id so AI games can reuse the existing black_user_id/
// white_user_id participant model without a schema change.
export function seedAiUser() {
    if (aiUserId) {
        return aiUserId;
    }
    let aiUser = db.prepare('SELECT id FROM users WHERE username = ?').get(AI_USERNAME);
    if (!aiUser) {
        const id = randomUUID();
        db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, AI_USERNAME, hashPassword(randomBytes(32).toString('hex')), Date.now());
        aiUser = { id };
    }
    aiUserId = aiUser.id;
    return aiUserId;
}
export function getAiUserId() {
    if (!aiUserId) {
        throw new Error('seedAiUser() must run before getAiUserId()');
    }
    return aiUserId;
}
