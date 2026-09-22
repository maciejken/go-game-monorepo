import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import db from './db.js';

const SESSION_COOKIE = 'go_session';
// "Permanent until logout" — a far-future expiry so the cookie survives
// browser restarts instead of behaving like a session-only cookie.
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;

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
  return token;
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
    WHERE sessions.token = ?
  `).get(token) as SessionUser | undefined;

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
