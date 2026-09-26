import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import db from './db.js';

const SESSION_COOKIE = 'go_session';
// Long enough that nobody is asked to log in again in normal use (a
// correspondence game can sit for weeks), short enough that a token that
// leaks doesn't stay valid forever. The cookie and the row agree, so a
// browser that ignores Max-Age still can't use an expired session.
const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const COOKIE_MAX_AGE_SECONDS = SESSION_LIFETIME_MS / 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) {
    return false;
  }
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// Crockford base32 without the letters that get misread — no I, L, O or U
// — so a code can be written down, read back over the phone and typed
// without anyone wondering about a zero.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LENGTH = 4;

// 16 characters of that alphabet: 80 bits, which no amount of guessing
// against a rate-limited endpoint will find.
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH);
  const characters = Array.from(bytes, (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += RECOVERY_GROUP_LENGTH) {
    groups.push(characters.slice(index, index + RECOVERY_GROUP_LENGTH).join(''));
  }
  return groups.join('-');
}

// Typed by a person who has just lost their password: case and grouping
// are noise, and so is the odd space.
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return hashPassword(normalizeRecoveryCode(code));
}

export function verifyRecoveryCode(code: string, stored: string): boolean {
  return verifyPassword(normalizeRecoveryCode(code), stored);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

export interface SessionUser {
  id: string;
  username: string;
  // Which of their own tags marks a game as a favourite, or null while
  // they haven't chosen one — the clients ask them to when they first
  // reach for the star.
  favouriteTag: string | null;
}

// `Secure` — the app now supports HTTPS, so the session cookie should
// never go over a plain connection.
export function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function createSession(userId: string): string {
  const token = randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  // Cheap to do here rather than on a timer: logins are rare, and this
  // keeps the table from growing forever with sessions nobody logged out
  // of. Only expired rows go — other devices stay logged in.
  pruneExpiredSessions();
  return token;
}

export function pruneExpiredSessions(): void {
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_LIFETIME_MS);
}

// Every session but the one being kept — used when the password changes,
// so a stolen cookie stops working the moment its owner notices.
export function destroyOtherSessions(userId: string, keepToken: string | null): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken ?? '');
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function getSessionToken(req: Request): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

// Resolves the request's session cookie to the logged-in user, or null if
// there's no session / it doesn't match a live one.
export function getSessionUser(req: Request): SessionUser | null {
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }
  const row = db.prepare(`
    SELECT users.id as id, users.username as username, users.favourite_tag as favouriteTag
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.created_at >= ? AND users.deleted_at IS NULL
  `).get(token, Date.now() - SESSION_LIFETIME_MS) as SessionUser | undefined;

  return row ?? null;
}

// Sends 401 and returns null if there's no logged-in user; otherwise
// returns the user so the caller can proceed.
export function requireAuth(req: Request, res: Response): SessionUser | null {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Login required' });
    return null;
  }
  return user;
}
