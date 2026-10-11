import express from 'express';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import db from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import fs from 'fs';
import {
  applyDeadStones,
  applyMove,
  BOARD_SIZES,
  deductClock,
  hasTimedOut,
  resolveTimeControl,
  createEmptyBoard,
  getHandicapPoints,
  getCurrentColor,
  getKomi,
  hashBoard,
  scoreBoard,
  validateMove,
  type Board,
  type Captures,
  type Color,
  type Point,
  type ClockState,
  type PositionRecord,
  type TimeControlName,
} from 'shared';

import {
  dbPath, port, httpsPort, keyPath, certPath, trustProxy, aasaApp, registerLimit, gnugoDebugPerformance,
} from './config.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  destroyOtherSessions,
  generateRecoveryCode,
  getSessionToken,
  getSessionUser,
  hashPassword,
  hashRecoveryCode,
  requireAuth,
  setSessionCookie,
  verifyPassword,
  verifyRecoveryCode,
} from './auth.js';
import { seedDefaultUser, seedAiUser, getAiUserId } from './seed.js';
import { attachWebSocketServer, broadcastGameUpdate, broadcastGamesListUpdate } from './ws.js';
import { generateAiMove, isGnuGoAvailable, type AiMoveOutcome, type AiMoveTimings, type ReplayMove } from './gnugo.js';
import { isApnsConfigured, sendPushNotification } from './apns.js';


seedDefaultUser();
seedAiUser();

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express();
app.use(express.json());

// Whether there is an HTTPS server to send people to — the same condition
// the listener below starts on, hoisted so the redirect can't point at a
// port nothing is serving. Local dev without certs keeps working over
// plain HTTP.
const httpsAvailable = Boolean(
  httpsPort && keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath),
);

// One hop: whatever proxy is in front. Anything further out could be
// spoofed by a client sending its own X-Forwarded-For.
if (trustProxy) {
  app.set('trust proxy', 1);
}

// TLS is in play either because this process serves it or because
// something in front does. Both cases want the same redirect and the same
// HSTS header; what differs is only who holds the certificate.
const servesOverTLS = httpsAvailable || trustProxy;

// The session cookie is Secure, so a login over plain HTTP silently fails
// to stick — and the password got there in clear anyway. Anything that
// arrives on the HTTP listener goes to HTTPS instead, except the two
// well-known paths: certbot's challenge has to answer over HTTP to issue
// the certificate in the first place, and iOS wants the app-site
// association served without a redirect.
app.use((req, res, next) => {
  if (!servesOverTLS || req.secure || req.path.startsWith('/.well-known/')) {
    next();
    return;
  }
  // 308 rather than 302: it keeps the method and body, so a POSTed login
  // is retried as a POST rather than silently becoming a GET.
  //
  // HTTPS_PORT is the port this process listens on, which is not
  // necessarily the one the world connects to: in production the router
  // forwards 443 here, so redirecting to HTTPS_PORT would send browsers to
  // a port nothing answers on from outside. The request itself says which
  // case we are in — a browser omits the port when it used the default, so
  // a Host with no port means "public, standard ports" and a Host with one
  // means a direct connection like a dev machine's :3000.
  const requestHost = req.headers.host ?? '';
  const [host, requestPort] = [requestHost.replace(/:\d+$/, ''), /:(\d+)$/.exec(requestHost)?.[1]];
  const port = requestPort ? `:${httpsPort}` : '';
  res.redirect(308, `https://${host}${port}${req.originalUrl}`);
});

// Set on everything, including the API and the static client. No CSP
// frame-src/script-src loopholes to keep track of: the page loads one
// bundled script from this origin and nothing else. 'unsafe-inline' is
// there for styles only, which React writes inline for things like the
// board's --cell size.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  next();
});

// Only over TLS, and only once TLS is actually available: telling a
// browser to refuse plain HTTP for six months is not something to do from
// a dev machine with no certificate.
app.use((req, res, next) => {
  if (servesOverTLS && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});

// Lets certbot verify domain ownership in webroot mode.
app.use('/.well-known/acme-challenge', express.static('/etc/certbot-webroot/.well-known/acme-challenge'));

// Universal Links and shared-password config for the iOS app (ios-app/,
// associated domains applinks: and webcredentials: on igo5.online). The
// first lets a plain https://igo5.online/games/<id> link open in the app
// rather than a browser tab; the second tells iOS the app and the site
// share an account, so a password saved for one is offered for the other
// and updating it in one updates it everywhere.
//
// The document itself is server/public/apple-app-site-association — it is
// configuration, not code. It is served from here rather than by
// express.static because the path Apple fetches has no file extension,
// which static would serve as application/octet-stream; iOS wants JSON.
// It must also arrive without a redirect: iOS fetches it once per install
// over a plain GET, before ever consulting the app's entitlements.
//
// The appIDs in it must exactly match the app's own
// application-identifier entitlement (team + bundle id) — iOS silently
// falls back to Safari, and forgets about shared passwords, on any
// mismatch. The bundle id is com.maciejkedra.igo5 (renamed from the
// original com.maciejkedra.gogame, which turned out to be registered
// under a team this Mac's Xcode could never get a working certificate for
// via automatic signing) — this App ID + its provisioning profile were
// created manually on developer.apple.com under team H36M3YGDVV and
// installed via manual (not automatic) code signing in project.pbxproj.
// Confirm with `codesign -d --entitlements :- <built .app>` on the
// actually-installed build if links or passwords ever stop working.
app.get('/.well-known/apple-app-site-association', (req, res) => {
  // Two builds, two app IDs: the production app and a test one pointed
  // at the test backend. Each host names only its own, because a host
  // that named both would let a link open whichever app happened to
  // claim it — the file is per-domain, and this server answers on more
  // than one.
  //
  // Which one is normally read off the host, but AASA_APP overrides it.
  // A server reached through a proxy sees whatever Host that proxy
  // forwards, and a rewritten one would quietly serve the wrong app ID —
  // a failure that then takes a day to undo, because iOS reads this file
  // through Apple's CDN. A machine that only ever serves one of the two
  // says so instead of inferring it.
  const isTestHost = (req.hostname ?? '').startsWith('test.');
  const wantsTestApp = aasaApp ? aasaApp === 'test' : isTestHost;
  const file = wantsTestApp ? 'apple-app-site-association.test' : 'apple-app-site-association';
  res.type('application/json');
  res.sendFile(path.resolve(__dirname, '../public', file));
});

// The two pages the App Store requires a link to, and the only pages here
// that aren't part of the client app. Plain files rather than React routes
// because App Review and anyone's browser must get them without running
// any JavaScript — and because they have to keep working whatever happens
// to the client build. Declared above the catch-all that hands every other
// path to React Router.
// English or Polish, guessed from Accept-Language and overridable with
// ?lang= — which the pages link to each other with, because a guess has
// to have a way out. Vary says so to Cloudflare, which would otherwise
// hand one visitor's language to the next.
function sendStaticPage(name: string) {
  return (req: Request, res: Response) => {
    const asked = typeof req.query.lang === 'string' ? req.query.lang : null;
    const prefersPolish = asked ? asked === 'pl' : /(^|[,\s])pl\b/i.test(req.headers['accept-language'] ?? '');
    res.setHeader('Vary', 'Accept-Language');
    res.sendFile(path.resolve(__dirname, '../public', prefersPolish ? `${name}.pl.html` : `${name}.html`));
  };
}

app.get('/privacy', sendStaticPage('privacy'));
app.get('/support', sendStaticPage('support'));

app.use(express.static(path.resolve(__dirname, '../../client/dist')));

app.get('/', (req, res) => {
  res.json({ message: 'Go server is running!' });
});

interface GameRow {
  id: string;
  size: number;
  status: string;
  result: string | null;
  handicap: number;
  title: string | null;
  created_at: number;
  updated_at: number;
  black_user_id: string | null;
  white_user_id: string | null;
  pending_undo_by: string | null;
  end_reason: string | null;
  pending_reopen_by: string | null;
  time_control: string | null;
  main_time_seconds: number | null;
  byoyomi_seconds: number | null;
  byoyomi_periods: number | null;
  black_time_remaining_ms: number | null;
  white_time_remaining_ms: number | null;
  black_periods_left: number | null;
  white_periods_left: number | null;
  turn_started_at: number | null;
  gnugo_level: number | null;
  komi: number | null;
  ai_current_level: number | null;
  invited_user_id: string | null;
  invite_status: string | null;
}

// Every error the clients put in front of a user goes out through here.
// `errorKey` is the English sentence with %@ where a value goes — the same
// shape the shared locale catalogues key on — so each client can translate
// it with its own copy rather than the server carrying nine translations
// of its own. `error` stays the ready-made English sentence, for anything
// reading the old shape and as the fallback when a client has no
// translation for the key.
//
// Values are always substituted as %@, never %lld: the key travels as text
// and a client formatting a string argument against %lld would crash.
function fail(res: Response, status: number, errorKey: string, params: (string | number)[] = []): void {
  let next = 0;
  const error = errorKey.replace(/%(?:\d+\$)?@/g, () => String(params[next++] ?? ''));
  res.status(status).json({ error, errorKey, errorParams: params.map((param) => String(param)) });
}

function getGameRow(id: string): GameRow | undefined {
  return db.prepare(`
    SELECT id, size, status, result, handicap, title, created_at, updated_at,
           black_user_id, white_user_id, pending_undo_by, end_reason, pending_reopen_by,
           time_control, main_time_seconds, byoyomi_seconds, byoyomi_periods,
           black_time_remaining_ms, white_time_remaining_ms, black_periods_left, white_periods_left, turn_started_at,
           gnugo_level, komi, ai_current_level, invited_user_id, invite_status
    FROM games WHERE id = ?
  `).get(id) as GameRow | undefined;
}

// True only for the invited side, and only until they respond — used to
// gate the confirm/reject prompt on the client. Not enforced server-side
// beyond that: nothing stops the invited player from moving without ever
// calling respond-invite, same trust level the rest of this API already
// extends to a logged-in participant.
function isPendingInviteFor(game: GameRow, userId: string | null): boolean {
  return game.invite_status === 'pending' && game.invited_user_id !== null && userId === game.invited_user_id;
}

// The other participant in a pending invite — used to notify them when the
// invited side declines. Assumes invite_status is 'pending' (so both
// black_user_id/white_user_id are the inviter and invitee, nobody else).
function inviterIdFor(game: GameRow): string | null {
  return game.invited_user_id === game.black_user_id ? game.white_user_id : game.black_user_id;
}

function setAiCurrentLevel(gameId: string, level: number): void {
  db.prepare('UPDATE games SET ai_current_level = ? WHERE id = ?').run(level, gameId);
  broadcastGameUpdate(gameId);
}

// Falls back to the handicap-derived default for games created before the
// explicit per-game komi setting existed.
function resolveKomi(game: GameRow): number {
  return game.komi ?? getKomi(game.handicap);
}

// Whether `blockerId` refuses invitations from `blockedId`. Asked in the
// username search and the invite guard, alongside accepts_invitations —
// the two together decide whether one person may invite another.
function hasBlocked(blockerId: string, blockedId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?')
    .get(blockerId, blockedId);
  return row !== undefined;
}

function getUsername(userId: string | null): string | null {
  if (!userId) {
    return null;
  }
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  return row?.username ?? null;
}

interface Participants {
  black_user_id: string | null;
  white_user_id: string | null;
}

// 'both' covers local games, where one account plays both colors.
function getMyColor(game: Participants, userId: string | null): 'black' | 'white' | 'both' | null {
  if (!userId) {
    return null;
  }
  const isBlack = game.black_user_id === userId;
  const isWhite = game.white_user_id === userId;
  if (isBlack && isWhite) return 'both';
  if (isBlack) return 'black';
  if (isWhite) return 'white';
  return null;
}

function canActAsColor(game: Participants, userId: string, color: Color): boolean {
  return color === 'black' ? game.black_user_id === userId : game.white_user_id === userId;
}

function isParticipant(game: Participants, userId: string): boolean {
  return game.black_user_id === userId || game.white_user_id === userId;
}

// A camera session is one sitting at a board, not an open-ended grant: a
// token that leaks (it travels in a header to a service on the local
// network) stops working the next day rather than never.
const VISION_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;

// A vision-service token authorizes moves for one specific game only, as
// either color — the camera identifies a move by stone color, not by which
// player physically placed it, so there's no single color to scope it to.
function isValidVisionToken(req: express.Request, gameId: string): boolean {
  const token = req.header('X-Vision-Token');
  if (!token) {
    return false;
  }
  const row = db
    .prepare('SELECT game_id FROM vision_tokens WHERE token = ? AND created_at >= ?')
    .get(token, Date.now() - VISION_TOKEN_LIFETIME_MS) as { game_id: string } | undefined;
  return row?.game_id === gameId;
}

function isAiOpponentGame(game: Participants): boolean {
  const aiId = getAiUserId();
  return game.black_user_id === aiId || game.white_user_id === aiId;
}

// GNU Go is a single shared account (getAiUserId()), not one per player —
// gates new AI-game creation so it's never committed to a second 'standard'
// (10-minute) game while one is already open, server-wide, regardless of
// who's asking. "Open" covers both in_progress and scoring: nothing left
// for a human to do in either once the other player is GNU Go, since it
// can't mark dead stones either. A correspondence or unlimited game against
// GNU Go is deliberately not "open" for this check — it can sit for days
// without demanding anything from it right now, unlike a short game that
// does want its attention/CPU, so it shouldn't block a fresh game.
function hasOpenAiGame(): boolean {
  const aiId = getAiUserId();
  const row = db
    .prepare(
      `SELECT 1 FROM games
       WHERE status IN ('in_progress', 'scoring') AND time_control = 'standard'
         AND (black_user_id = ? OR white_user_id = ?)
       LIMIT 1`,
    )
    .get(aiId, aiId);
  return row !== undefined;
}

// A human's equivalent of hasOpenAiGame, scoped to 'standard' (10-minute)
// games only — a short game wants real-time attention, so being invited to
// a second one while a first is still open isn't the same as juggling
// several unhurried correspondence games at once, which is completely
// normal and left alone here.
function hasOpenStandardGame(userId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM games
       WHERE status IN ('in_progress', 'scoring') AND time_control = 'standard'
         AND (black_user_id = ? OR white_user_id = ?)
       LIMIT 1`,
    )
    .get(userId, userId);
  return row !== undefined;
}

// Sends to every device the user has registered — gameId rides along as
// custom push-payload data (see apns.ts) so a tap on the notification can
// take the iOS app straight to that game via DeepLinkRouter, the same
// mechanism a /games/<id> universal link uses.
function pushToUser(userId: string, alert: string, gameId: string): void {
  const tokens = db.prepare('SELECT token FROM device_tokens WHERE user_id = ?').all(userId) as {
    token: string;
  }[];
  for (const { token } of tokens) {
    sendPushNotification(token, alert, { gameId });
  }
}

// Pushes "it's your turn" to every device the color-to-move's player has
// registered — skipped for a local game (both colors are the same account,
// who obviously doesn't need telling) and whenever the *next* mover is the
// AI itself (no device to push to; maybeTriggerAiMove handles that turn
// instead, immediately, without waiting on a human). Deliberately not
// gated on isAiOpponentGame(game) generally: GNU Go's own move is applied
// via this same function (see applyMoveToGame's shared use below), fired
// off asynchronously after the human's move response already went out —
// so the human backgrounding the app right after their own move would
// otherwise never learn GNU Go replied.
function notifyOpponentOfMove(game: Participants & { id: string; title: string | null }, moverColor: Color, nextColor: Color): void {
  const opponentId = nextColor === 'black' ? game.black_user_id : game.white_user_id;
  const moverId = moverColor === 'black' ? game.black_user_id : game.white_user_id;
  const aiId = getAiUserId();
  if (!opponentId || opponentId === moverId || opponentId === aiId) {
    return;
  }

  const moverName = moverId === aiId ? 'GNU Go' : getUsername(moverId) ?? 'Your opponent';
  pushToUser(opponentId, `${moverName} moved${game.title ? ` in ${game.title}` : ''} — it's your turn.`, game.id);
}

// Resign ends the game outright rather than handing the turn back, so
// notifyOpponentOfMove's "it's your turn" framing doesn't fit — same
// opponent-lookup/local-game/AI guards, worded for the game having ended.
function notifyOpponentOfResign(game: Participants & { id: string; title: string | null }, resignedColor: Color): void {
  const resignedId = resignedColor === 'black' ? game.black_user_id : game.white_user_id;
  const opponentId = resignedColor === 'black' ? game.white_user_id : game.black_user_id;
  const aiId = getAiUserId();
  if (!opponentId || opponentId === resignedId || opponentId === aiId) {
    return;
  }

  const resignedName = getUsername(resignedId) ?? 'Your opponent';
  pushToUser(opponentId, `${resignedName} resigned${game.title ? ` in ${game.title}` : ''}.`, game.id);
}

// A new remote game has no prior move for notifyOpponentOfMove to hang an
// "it's your turn" push off of — without this, the invited side never
// learns about it until they happen to open the app themselves.
function notifyOfInvite(inviterId: string, invitedId: string, gameId: string, title: string | null): void {
  const inviterName = getUsername(inviterId) ?? 'Someone';
  pushToUser(invitedId, `${inviterName} invited you to a game${title ? ` — ${title}` : ''}.`, gameId);
}

// A game this user starred: their own shortlist, which is also how a game
// they are only watching gets into their list at all.
function isStarred(gameId: string, userId: string | null): boolean {
  if (!userId) {
    return false;
  }
  return db.prepare('SELECT 1 FROM stars WHERE user_id = ? AND game_id = ?').get(userId, gameId) !== undefined;
}

function getClockState(game: GameRow, color: Color): ClockState {
  return {
    remainingMs: (color === 'black' ? game.black_time_remaining_ms : game.white_time_remaining_ms) ?? 0,
    periodsLeft: (color === 'black' ? game.black_periods_left : game.white_periods_left) ?? 0,
  };
}

// Lazily resolves a timed-out game: called at the top of every route that
// reads or acts on a game, so nobody needs an active connection watching a
// clock tick down in real time for a timeout to actually take effect — the
// next request against this game (from anyone, for any reason) will catch
// it. A periodic sweep (below) additionally catches games nobody happens to
// be looking at.
function withTimeoutCheck(game: GameRow): GameRow {
  if (game.status !== 'in_progress' || game.main_time_seconds === null) {
    return game;
  }

  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  const state = getClockState(game, currentColor);
  const elapsedMs = Date.now() - (game.turn_started_at ?? Date.now());

  if (!hasTimedOut(state, game.byoyomi_seconds ?? 0, elapsedMs)) {
    return game;
  }

  const winner: Color = currentColor === 'black' ? 'white' : 'black';
  const winnerLabel = winner === 'black' ? 'Black' : 'White';
  const result = `${winnerLabel} wins on time`;
  const now = Date.now();

  db.prepare('UPDATE games SET status = ?, result = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', result, 'timeout', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  return { ...game, status: 'finished', result, end_reason: 'timeout' };
}

// Periodically catches timeouts in games nobody is actively viewing —
// otherwise a clock could visibly show 0:00 to nobody, forever, since
// withTimeoutCheck only runs when a request touches that specific game.
function sweepTimeouts(): void {
  const rows = db.prepare(`
    SELECT id FROM games WHERE status = 'in_progress' AND main_time_seconds IS NOT NULL
  `).all() as { id: string }[];

  for (const row of rows) {
    const game = getGameRow(row.id);
    if (game) {
      withTimeoutCheck(game);
    }
  }
}

const MAX_TITLE_LENGTH = 100;

// Tags are meant to be short labels, not free text — the title already
// covers that. The charset is a deliberate allowlist rather than an escape
// pass: letters (any script, so "końcówka" works), digits, and the three
// separators below. Everything else — angle brackets, quotes, backslashes,
// control characters — is rejected outright, so a tag can never carry
// markup or an escape sequence into whatever renders it later. (Newlines
// and tabs are the exception: they collapse into a single space along with
// any other run of whitespace, since a pasted tag is far likelier than a
// deliberately multi-line one.)
const MAX_TAG_LENGTH = 24;
const MAX_TAGS_PER_GAME = 12;
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

// Returns the tag as it should be stored, or null if it isn't a usable tag.
// Internal runs of whitespace collapse to a single space so "two  words"
// and "two words" can't both exist.
function sanitizeTag(rawTag: unknown): string | null {
  if (typeof rawTag !== 'string') {
    return null;
  }
  const trimmed = rawTag.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// Mirrors the 3-character floor /api/users/search already applies, for the
// same reason: one or two letters match so much that the result is useless.
const MIN_SEARCH_LENGTH = 3;
const MAX_SEARCH_LENGTH = 100;

// Normalizes ?q= into either a usable search term or null. Over-long input
// is truncated rather than rejected, since a paste is far more likely than
// an attack and there's no reason to fail the whole request over it.
function searchQuery(rawQuery: unknown): string | null {
  if (typeof rawQuery !== 'string') {
    return null;
  }
  const trimmed = rawQuery.trim().slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  return trimmed.length >= MIN_SEARCH_LENGTH ? trimmed : null;
}

// Searching only ever matches what the searcher can see: the other
// player's personal tags are no more searchable than they are visible.
function matchesSearch(game: GameRow, query: string, viewerId: string | null): boolean {
  const haystack = [
    game.title,
    getUsername(game.black_user_id),
    getUsername(game.white_user_id),
    ...getGameTags(game.id, viewerId),
  ];
  return haystack.some((value) => value != null && value.toLowerCase().includes(query));
}

// A tag is either public (one row, owned by nobody, seen by anyone who can
// see the game) or personal (one row per owner, seen only by them). Both
// players can hold the same tag personally, so the same word can come back
// twice — deduped on the key it is stored under, keeping the first.
function getGameTags(gameId: string, viewerId: string | null): string[] {
  const rows = db
    .prepare(
      `SELECT tag, tag_key FROM game_tags
       WHERE game_id = ? AND (is_public = 1 OR user_id = ?)
       ORDER BY created_at ASC`,
    )
    .all(gameId, viewerId ?? '') as { tag: string; tag_key: string }[];
  // Keeps the first spelling of each key and drops later duplicates.
  const byKey = new Map<string, string>();
  for (const row of rows) {
    if (!byKey.has(row.tag_key)) {
      byKey.set(row.tag_key, row.tag);
    }
  }
  return [...byKey.values()];
}

// Which of a game's tags are on it for both players, as opposed to being
// one person's own. Returned alongside the tags rather than folded into
// them: a tag is a string everywhere in both clients, and the clients
// only need to know which of the strings they already have are shared.
function getPublicGameTags(gameId: string): string[] {
  const rows = db
    .prepare('SELECT tag, tag_key FROM game_tags WHERE game_id = ? AND is_public = 1 ORDER BY created_at ASC')
    .all(gameId) as { tag: string; tag_key: string }[];
  const byKey = new Map<string, string>();
  for (const row of rows) {
    if (!byKey.has(row.tag_key)) {
      byKey.set(row.tag_key, row.tag);
    }
  }
  return [...byKey.values()];
}

// ownerId null means public: one row, no owner, visible to anyone who can
// see the game.
function addGameTag(gameId: string, tag: string, ownerId: string | null, now: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO game_tags (game_id, tag_key, tag, user_id, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(gameId, tag.toLowerCase(), tag, ownerId ?? '', ownerId === null ? 1 : 0, now);
}

// Adds to the user's own vocabulary, or counts another use of a tag already
// in it. The casing and public/personal of the latest use win, so a tag
// re-shared after being personal is offered back as a shared one.
function rememberUserTag(userId: string, tag: string, isPublic: boolean, now: number): void {
  db.prepare(
    `INSERT INTO user_tags (user_id, tag_key, tag, is_public, use_count, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, tag_key) DO UPDATE SET
       tag = excluded.tag,
       is_public = excluded.is_public,
       use_count = use_count + 1,
       updated_at = excluded.updated_at`,
  ).run(userId, tag.toLowerCase(), tag, isPublic ? 1 : 0, now);
}

function sanitizeTitle(rawTitle: unknown): string | null {
  if (typeof rawTitle !== 'string') {
    return null;
  }
  const trimmed = rawTitle.trim().slice(0, MAX_TITLE_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

// Re-exported under the name the routes below already use; the table
// itself lives in shared, since the device-side engine needs the same
// handicap placement the server applies.
// How often a board is written down. A dozen moves of replay is a
// fraction of a millisecond; the alternative — one board per move — is
// a couple of kilobytes on every move of every game ever played, which
// is what made the snapshots table larger than everything else together.
const SNAPSHOT_INTERVAL = 12;

const ALLOWED_BOARD_SIZES = BOARD_SIZES;

// Komi values that support correct classic scoring for an even (no
// handicap) game: 6.5/5.5 for area/territory rulesets that use a
// half-point komi to avoid ties, 0.5 for a minimal tie-breaker, and 0 for
// the no-komi classical rule.
const ALLOWED_KOMI_EVEN = [0, 0.5, 5.5, 6.5];

// A handicap game's stones are the real compensation, so komi there is
// only ever a tie-breaker: the standard 0.5, or 0 for no tie-breaker at all.
const ALLOWED_KOMI_HANDICAP = [0, 0.5];

function turnMoveNumber(moveNumber: number, handicap: number): number {
  return handicap >= 2 ? moveNumber + 1 : moveNumber;
}

// The next move number is tracked via `events` (which logs every action,
// including passes/resigns), while the board only reflects actual stone
// placements — so a pass must still advance the turn without touching it.
function getNextMoveNumber(gameId: string): number {
  const row = db.prepare(`
    SELECT MAX(move_number) as maxMoveNumber FROM events WHERE game_id = ?
  `).get(gameId) as { maxMoveNumber: number | null };

  return (row.maxMoveNumber ?? 0) + 1;
}

// Boards are stored every SNAPSHOT_INTERVAL moves rather than every move,
// so the newest one can be a little behind: the moves logged after it are
// replayed onto it. That is a dozen applications of a rule at worst, and
// it is the difference between a game costing one stored board per move
// and one per dozen.
function getCurrentBoard(gameId: string, size: number): Board {
  const row = db.prepare(`
    SELECT move_number, state FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number DESC
    LIMIT 1
  `).get(gameId) as { move_number: number; state: string } | undefined;

  let board = row ? (JSON.parse(row.state) as Board) : createEmptyBoard(size);
  const since = row?.move_number ?? -1;

  const later = db
    .prepare(
      `SELECT event_type, payload FROM events
        WHERE game_id = ? AND move_number > ? AND event_type IN ('MOVE', 'HANDICAP')
        ORDER BY move_number ASC`,
    )
    .all(gameId, since) as { event_type: string; payload: string }[];

  for (const event of later) {
    const payload = JSON.parse(event.payload) as { color?: Color; x?: number; y?: number; points?: [number, number][] };
    if (event.event_type === 'HANDICAP') {
      board = createEmptyBoard(size);
      for (const [x, y] of payload.points ?? []) {
        board[y][x] = 'black';
      }
    } else if (payload.x !== undefined && payload.y !== undefined && payload.color) {
      board = applyMove(board, { x: payload.x, y: payload.y }, payload.color).board;
    }
  }

  return board;
}

// Every position the game has passed through so far, for the situational
// superko check. Hashes come straight from the `snapshots.hash` column
// (computed once at write time) rather than being recomputed here.
function getGameHistory(gameId: string, size: number, handicap: number): PositionRecord[] {
  const rows = db.prepare(`
    SELECT move_number, state, hash FROM snapshots
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId) as { move_number: number; state: string; hash: string }[];

  // A game whose snapshots have been pruned (see scripts/prune-snapshots)
  // still has its log, and the log is what the positions were made from.
  // Reading the rows stays the fast path for a game still being played,
  // which keeps every one of them.
  const stored = db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE game_id = ? AND event_type IN ('MOVE', 'HANDICAP')")
    .get(gameId) as { count: number };
  if (rows.length < stored.count) {
    return replayPositions(gameId, size, handicap).positions;
  }

  const history: PositionRecord[] = [];

  // Handicap games already have a move_number = 0 snapshot; plain games
  // start from an empty board that was never itself written to a row.
  if (rows.length === 0 || rows[0].move_number !== 0) {
    const emptyBoard = createEmptyBoard(size);
    history.push({
      board: emptyBoard,
      hash: hashBoard(emptyBoard).toString(),
      nextColor: getCurrentColor(turnMoveNumber(1, handicap)),
    });
  }

  for (const row of rows) {
    history.push({
      board: JSON.parse(row.state) as Board,
      hash: row.hash,
      nextColor: getCurrentColor(turnMoveNumber(row.move_number + 1, handicap)),
    });
  }

  return history;
}

function getLastEventType(gameId: string, moveNumber: number): string | undefined {
  const row = db.prepare(`
    SELECT event_type FROM events WHERE game_id = ? AND move_number = ?
  `).get(gameId, moveNumber) as { event_type: string } | undefined;

  return row?.event_type;
}

// The game replayed as a flat move list for GNU Go to `play` back in via
// GTP before it's asked to generate its own move — handicap stones count
// as black plays, passes carry a null point.
function getReplayMoves(gameId: string): ReplayMove[] {
  const events = db.prepare(`
    SELECT event_type, payload FROM events WHERE game_id = ? ORDER BY move_number ASC
  `).all(gameId) as { event_type: string; payload: string }[];

  const moves: ReplayMove[] = [];
  for (const event of events) {
    const payload = JSON.parse(event.payload) as {
      color?: Color;
      x?: number;
      y?: number;
      points?: [number, number][];
    };
    if (event.event_type === 'HANDICAP' && payload.points) {
      for (const [x, y] of payload.points) {
        moves.push({ color: 'black', point: { x, y } });
      }
    } else if (event.event_type === 'MOVE' && payload.color && payload.x !== undefined && payload.y !== undefined) {
      moves.push({ color: payload.color, point: { x: payload.x, y: payload.y } });
    } else if (event.event_type === 'PASS' && payload.color) {
      moves.push({ color: payload.color, point: null });
    }
  }
  return moves;
}

// Cumulative stones each color has captured over the whole game so far,
// derived fresh from the event log rather than tracked separately — the
// event log is already the source of truth for what each move captured.
function getCumulativeCaptures(gameId: string): Captures {
  const rows = db.prepare(`
    SELECT payload FROM events WHERE game_id = ? AND event_type = 'MOVE'
  `).all(gameId) as { payload: string }[];

  const captures: Captures = { black: 0, white: 0 };
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { color?: Color; capturedPoints?: Point[] };
    const count = payload.capturedPoints?.length ?? 0;
    if (payload.color === 'black') {
      captures.black += count;
    } else if (payload.color === 'white') {
      captures.white += count;
    }
  }

  return captures;
}

// The most recent stone placed, for the live board's "last move" marker —
// review mode already gets this per-move from the history endpoint, but the
// live view has no reason to load the whole history just for this.
function getLastMovePoint(gameId: string): Point | null {
  const row = db.prepare(`
    SELECT payload FROM events WHERE game_id = ? AND event_type = 'MOVE'
    ORDER BY move_number DESC LIMIT 1
  `).get(gameId) as { payload: string } | undefined;

  if (!row) {
    return null;
  }
  const payload = JSON.parse(row.payload) as { x: number; y: number };
  return { x: payload.x, y: payload.y };
}

interface LastEvent {
  eventType: string;
  color: Color | null;
  point: Point | null;
  capturedPoints: Point[];
}

// The single most recent event of any type (move, pass, resign, handicap),
// for narrating live play to screen readers — unlike getLastMovePoint,
// this isn't limited to MOVE events, so a pass after the last stone is
// still reflected here.
function getLastEvent(gameId: string): LastEvent | null {
  const row = db.prepare(`
    SELECT event_type, payload FROM events WHERE game_id = ?
    ORDER BY move_number DESC LIMIT 1
  `).get(gameId) as { event_type: string; payload: string } | undefined;

  if (!row) {
    return null;
  }
  const payload = JSON.parse(row.payload) as {
    color?: Color;
    x?: number;
    y?: number;
    capturedPoints?: Point[];
  };
  return {
    eventType: row.event_type,
    color: payload.color ?? null,
    point:
      row.event_type === 'MOVE' && payload.x !== undefined && payload.y !== undefined
        ? { x: payload.x, y: payload.y }
        : null,
    capturedPoints: payload.capturedPoints ?? [],
  };
}

// Whether there's a player action to undo at all — false at the very start
// of a game, where the only event so far (if any) is the handicap setup.
function hasUndoableEvent(gameId: string): boolean {
  const lastEvent = db.prepare(`
    SELECT event_type FROM events WHERE game_id = ? ORDER BY move_number DESC LIMIT 1
  `).get(gameId) as { event_type: string } | undefined;

  return lastEvent !== undefined && lastEvent.event_type !== 'HANDICAP';
}

interface MoveHistoryEntry {
  moveNumber: number;
  board: Board;
  eventType: string;
  color: Color | null;
  point: Point | null;
  capturedPoints: Point[];
}

// The full move-by-move record for the "review" feature: every event the
// game has logged, paired with the board as it stood right after. Passes
// and resigns don't have their own snapshot, so their board is carried
// forward from the last actual placement.
// Every position a game has been in, rebuilt from its log. The log is the
// source of truth — a stored board is only ever a copy of what replaying
// it produces — so this is what the history and the superko check are
// derived from once a game's snapshots have been pruned.
//
// Boards are keyed by the move number they follow: a pass or a
// resignation leaves the position alone, so those numbers map to the same
// board as the move before them.
function replayPositions(
  gameId: string,
  size: number,
  handicap: number,
): { boards: Map<number, Board>; positions: PositionRecord[] } {
  const events = db
    .prepare('SELECT move_number, event_type, payload FROM events WHERE game_id = ? ORDER BY move_number ASC')
    .all(gameId) as { move_number: number; event_type: string; payload: string }[];

  let board = createEmptyBoard(size);
  const boards = new Map<number, Board>();
  const positions: PositionRecord[] = [];

  // A plain game's first position is the empty board, which was never
  // written to a row; a handicap game's is the placement, logged as
  // move 0.
  if (events.length === 0 || events[0].move_number !== 0) {
    positions.push({
      board,
      hash: hashBoard(board).toString(),
      nextColor: getCurrentColor(turnMoveNumber(1, handicap)),
    });
  }

  for (const event of events) {
    const payload = JSON.parse(event.payload) as { color?: Color; x?: number; y?: number; points?: [number, number][] };
    if (event.event_type === 'HANDICAP') {
      board = createEmptyBoard(size);
      for (const [x, y] of payload.points ?? []) {
        board[y][x] = 'black';
      }
    } else if (event.event_type === 'MOVE' && payload.x !== undefined && payload.y !== undefined && payload.color) {
      board = applyMove(board, { x: payload.x, y: payload.y }, payload.color).board;
    }
    boards.set(event.move_number, board);
    if (event.event_type === 'HANDICAP' || event.event_type === 'MOVE') {
      positions.push({
        board,
        hash: hashBoard(board).toString(),
        nextColor: getCurrentColor(turnMoveNumber(event.move_number + 1, handicap)),
      });
    }
  }

  return { boards, positions };
}

function getMoveHistory(gameId: string, size: number): MoveHistoryEntry[] {
  const events = db.prepare(`
    SELECT move_number, event_type, payload FROM events
    WHERE game_id = ?
    ORDER BY move_number ASC
  `).all(gameId) as { move_number: number; event_type: string; payload: string }[];

  const game = db.prepare('SELECT handicap FROM games WHERE id = ?').get(gameId) as { handicap: number } | undefined;
  const { boards: boardByMove } = replayPositions(gameId, size, game?.handicap ?? 0);

  const history: MoveHistoryEntry[] = [];
  let lastBoard = createEmptyBoard(size);

  // Handicap games log their setup as move 0; plain games start from an
  // empty board that was never itself written to a row.
  if (events.length === 0 || events[0].move_number !== 0) {
    history.push({ moveNumber: 0, board: lastBoard, eventType: 'START', color: null, point: null, capturedPoints: [] });
  }

  for (const event of events) {
    const payload = JSON.parse(event.payload) as {
      color?: Color;
      x?: number;
      y?: number;
      capturedPoints?: Point[];
    };
    const board = boardByMove.get(event.move_number) ?? lastBoard;
    lastBoard = board;

    history.push({
      moveNumber: event.move_number,
      board,
      eventType: event.event_type,
      color: payload.color ?? null,
      point:
        event.event_type === 'MOVE' && payload.x !== undefined && payload.y !== undefined
          ? { x: payload.x, y: payload.y }
          : null,
      capturedPoints: payload.capturedPoints ?? [],
    });
  }

  return history;
}

const SGF_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function toSgfCoord(x: number, y: number): string {
  return `${SGF_LETTERS[x]}${SGF_LETTERS[y]}`;
}

function escapeSgfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

// Parses our own free-text `result` strings (see applyResignToGame,
// withTimeoutCheck, and the finalize-scoring handler) back into the
// standard SGF RE[] convention (e.g. "B+R", "W+T", "B+6.5") — there's no
// structured winner/margin stored separately, only the composed sentence.
function deriveSgfResult(game: Pick<GameRow, 'result' | 'end_reason'>): string | null {
  if (!game.result) {
    return null;
  }
  if (game.end_reason === 'resign') {
    const match = /^(Black|White) resigned/.exec(game.result);
    return match ? `${match[1] === 'Black' ? 'W' : 'B'}+R` : null;
  }
  if (game.end_reason === 'timeout') {
    const match = /^(Black|White) wins on time/.exec(game.result);
    return match ? `${match[1] === 'Black' ? 'B' : 'W'}+T` : null;
  }
  if (game.end_reason === 'scoring') {
    const match = /^(Black|White) wins by ([\d.]+)/.exec(game.result);
    return match ? `${match[1] === 'Black' ? 'B' : 'W'}+${match[2]}` : null;
  }
  return null;
}

// Backs the profile page's games played/won/lost — reuses deriveSgfResult
// (the same free-text result parsing the SGF export already relies on)
// rather than storing a separate structured winner column. A finished game
// with no determinable winner (manually ended, no result) counts toward
// played but neither won nor lost. Local games (same user as both colors)
// are excluded entirely — only remote and vs-computer games count.
function getUserStats(userId: string): { played: number; won: number; lost: number } {
  const rows = db
    .prepare(
      `SELECT black_user_id, white_user_id, result, end_reason
       FROM games
       WHERE status = 'finished' AND black_user_id != white_user_id AND (black_user_id = ? OR white_user_id = ?)`,
    )
    .all(userId, userId) as Pick<GameRow, 'black_user_id' | 'white_user_id' | 'result' | 'end_reason'>[];

  let played = 0;
  let won = 0;
  let lost = 0;
  for (const row of rows) {
    played += 1;
    const sgfResult = deriveSgfResult(row);
    if (!sgfResult) {
      continue;
    }
    const winnerIsBlack = sgfResult.startsWith('B');
    if (winnerIsBlack ? row.black_user_id === userId : row.white_user_id === userId) {
      won += 1;
    } else if (winnerIsBlack ? row.white_user_id === userId : row.black_user_id === userId) {
      lost += 1;
    }
  }
  return { played, won, lost };
}

// Each player's own point total for a scored finish (e.g. "White wins by
// 6.5 (B: 0, W: 6.5)" -> { black: 0, white: 6.5 }) — parsed from the same
// sentence rather than stored separately. Resignation/timeout finishes
// have no per-player point total, so this is scoring-only.
function deriveScoreBreakdown(game: GameRow): { black: number; white: number } | null {
  if (!game.result || game.end_reason !== 'scoring') {
    return null;
  }
  const match = /\(B: ([\d.]+), W: ([\d.]+)\)/.exec(game.result);
  return match ? { black: Number(match[1]), white: Number(match[2]) } : null;
}

// Handicap stones are SGF setup properties (AB[]) on the root node, not
// moves — the real move sequence starts with White, same as in the app.
function generateSgf(game: GameRow): string {
  const events = db.prepare(`
    SELECT event_type, payload FROM events WHERE game_id = ? ORDER BY move_number ASC
  `).all(game.id) as { event_type: string; payload: string }[];

  const rootProps = ['GM[1]', 'FF[4]', 'CA[UTF-8]', `SZ[${game.size}]`, `KM[${resolveKomi(game)}]`];
  if (game.handicap > 0) {
    rootProps.push(`HA[${game.handicap}]`);
  }
  if (game.title) {
    rootProps.push(`GN[${escapeSgfText(game.title)}]`);
  }
  const blackName = getUsername(game.black_user_id);
  const whiteName = getUsername(game.white_user_id);
  if (blackName) {
    rootProps.push(`PB[${escapeSgfText(blackName)}]`);
  }
  if (whiteName) {
    rootProps.push(`PW[${escapeSgfText(whiteName)}]`);
  }
  const re = deriveSgfResult(game);
  if (re) {
    rootProps.push(`RE[${re}]`);
  }

  let moveNodes = '';
  for (const event of events) {
    const payload = JSON.parse(event.payload) as {
      color?: Color;
      x?: number;
      y?: number;
      points?: [number, number][];
    };
    if (event.event_type === 'HANDICAP' && payload.points) {
      const stones = payload.points.map(([x, y]) => `[${toSgfCoord(x, y)}]`).join('');
      rootProps.push(`AB${stones}`);
    } else if (event.event_type === 'MOVE' && payload.color && payload.x !== undefined && payload.y !== undefined) {
      moveNodes += `;${payload.color === 'black' ? 'B' : 'W'}[${toSgfCoord(payload.x, payload.y)}]`;
    } else if (event.event_type === 'PASS' && payload.color) {
      moveNodes += `;${payload.color === 'black' ? 'B' : 'W'}[]`;
    }
    // RESIGN adds no move node — it's already reflected in RE[] above.
  }

  return `(;${rootProps.join('')}${moveNodes})`;
}

interface MoveApplyResult {
  board: Board;
  moveNumber: number;
  capturedPoints: Point[];
  nextColor: Color;
  captures: Captures;
}

// Deducts the mover's thinking time from their clock and resets the turn
// timer for whoever moves next. A no-op for untimed games. `game` is
// expected to have already passed withTimeoutCheck, so elapsedMs here is
// guaranteed to fit their budget.
function advanceClock(game: GameRow, color: Color, now: number): void {
  if (game.main_time_seconds === null) {
    return;
  }
  const elapsedMs = now - (game.turn_started_at ?? now);
  const next = deductClock(getClockState(game, color), game.byoyomi_seconds ?? 0, elapsedMs);

  if (color === 'black') {
    db.prepare('UPDATE games SET black_time_remaining_ms = ?, black_periods_left = ?, turn_started_at = ? WHERE id = ?')
      .run(next.remainingMs, next.periodsLeft, now, game.id);
  } else {
    db.prepare('UPDATE games SET white_time_remaining_ms = ?, white_periods_left = ?, turn_started_at = ? WHERE id = ?')
      .run(next.remainingMs, next.periodsLeft, now, game.id);
  }
}

// Shared by the human-facing /moves endpoint and the AI trigger below, so
// there's exactly one place that writes a MOVE event to the log.
function applyMoveToGame(
  game: GameRow,
  x: number,
  y: number,
  color: Color,
): { ok: true; result: MoveApplyResult } | { ok: false; error: string } {
  const board = getCurrentBoard(game.id, game.size);
  const history = getGameHistory(game.id, game.size, game.handicap);
  const moveNumber = getNextMoveNumber(game.id);
  const validation = validateMove(board, { x, y }, color, turnMoveNumber(moveNumber, game.handicap), history);
  if (!validation.valid) {
    return { ok: false, error: validation.error! };
  }

  const newBoard = validation.board!;
  const capturedPoints = validation.capturedPoints!;
  const now = Date.now();

  // Every SNAPSHOT_INTERVAL moves, not every move. What a stored board
  // buys is a shorter replay for getCurrentBoard; what it costs is a few
  // kilobytes on every move of every game forever, which is what made
  // this table the whole database.
  if (moveNumber % SNAPSHOT_INTERVAL === 0) {
    db.prepare(`
      INSERT INTO snapshots (game_id, move_number, state, hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(game.id, moveNumber, JSON.stringify(newBoard), validation.hash!, now);
  }

  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'MOVE', JSON.stringify({ x, y, color, capturedPoints }), now);

  advanceClock(game, color, now);

  db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  const nextColor = getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap));
  notifyOpponentOfMove(game, color, nextColor);

  return {
    ok: true,
    result: {
      board: newBoard,
      moveNumber,
      capturedPoints,
      nextColor,
      captures: getCumulativeCaptures(game.id),
    },
  };
}

function applyPassToGame(game: GameRow, color: Color): { status: string; nextColor: Color } {
  const moveNumber = getNextMoveNumber(game.id);
  const now = Date.now();

  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'PASS', JSON.stringify({ color }), now);

  advanceClock(game, color, now);

  // Two consecutive passes end play and move into the scoring phase, where
  // dead stones get marked before the final result is computed — see
  // POST /api/games/:id/finalize-scoring.
  const previousEventType = getLastEventType(game.id, moveNumber - 1);
  const status = previousEventType === 'PASS' ? 'scoring' : 'in_progress';

  db.prepare('UPDATE games SET status = ?, result = ?, updated_at = ? WHERE id = ?')
    .run(status, null, now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  return { status, nextColor: getCurrentColor(turnMoveNumber(moveNumber + 1, game.handicap)) };
}

function applyResignToGame(game: GameRow, color: Color): string {
  const now = Date.now();
  const moveNumber = getNextMoveNumber(game.id);

  db.prepare(`
    INSERT INTO events (game_id, move_number, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(game.id, moveNumber, 'RESIGN', JSON.stringify({ color }), now);

  const gameResult = `${color === 'black' ? 'Black' : 'White'} resigned`;
  db.prepare('UPDATE games SET status = ?, result = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', gameResult, 'resign', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();
  notifyOpponentOfResign(game, color);

  return gameResult;
}

// Lower level = faster and weaker (GNU Go's own description) — the main
// lever against the deep-reading blowups that make some positions slow.
// Trading some strength for reliability by default; both tunable without a
// code change if you want to dial strength back up (more hang risk) or
// down further (less).
const GNUGO_LEVEL = Number(process.env.GNUGO_LEVEL) || 5;

// Kept only when asked for. The table is created either way — one empty
// table costs nothing and saves a migration if the flag is ever turned
// on — but nothing writes to it unless GNUGO_DEBUG_PERFORMANCE is set.
function recordGnugoTimings(game: GameRow, moveNumber: number, level: number, timings: AiMoveTimings): void {
  if (!gnugoDebugPerformance) {
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO gnugo_timings
       (game_id, move_number, level, board_size, moves_replayed,
        queue_wait_ms, setup_ms, replay_ms, genmove_ms, total_ms, cpu_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    game.id,
    moveNumber,
    level,
    game.size,
    timings.movesReplayed,
    timings.queueWaitMs,
    timings.setupMs,
    timings.replayMs,
    timings.genmoveMs,
    timings.totalMs,
    timings.cpuMs,
    Date.now(),
  );
}

// Games whose last AI move timed out. Deliberately in memory rather than
// a column: it describes an attempt, not the game, and a restart is one
// of the things that fixes it — the player's next nudge tries again from
// a clean slate either way.
const stalledAiGames = new Set<string>();

function markAiStalled(gameId: string): void {
  stalledAiGames.add(gameId);
  broadcastGameUpdate(gameId);
}

function clearAiStalled(gameId: string): void {
  if (stalledAiGames.delete(gameId)) {
    broadcastGameUpdate(gameId);
  }
}

// Called (fire-and-forget) after any action that might hand the turn to
// the AI — a human move/pass, or game creation when the AI plays first.
// No-ops immediately unless it's actually the AI's turn.
async function maybeTriggerAiMove(gameId: string): Promise<void> {
  let game = getGameRow(gameId);
  if (!game || game.status !== 'in_progress') {
    return;
  }
  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    return;
  }

  const aiId = getAiUserId();
  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  const colorUserId = currentColor === 'black' ? game.black_user_id : game.white_user_id;
  if (colorUserId !== aiId) {
    return;
  }

  const baseRequest = {
    size: game.size,
    komi: resolveKomi(game),
    moves: getReplayMoves(game.id),
    colorToMove: currentColor,
  };
  // Per-game difficulty, chosen at creation time — falls back to the
  // server's own default when the game predates this setting or didn't
  // specify one.
  const configuredLevel = game.gnugo_level ?? GNUGO_LEVEL;

  // One attempt, and never a random move. Stepping the level down and
  // trying again used to happen here, which on a slow machine turned one
  // long think into several and changed the opponent's strength without
  // saying so. A position GNU Go cannot read inside a minute is now the
  // player's to know about: the game is marked as stalled and left
  // waiting, and they can ask for another go — or undo and play
  // something else, which they could always do.
  const level = configuredLevel;
  let outcome: AiMoveOutcome;
  setAiCurrentLevel(game.id, level);
  try {
    outcome = await generateAiMove({ ...baseRequest, level });
  } catch (err) {
    console.error(`GNU Go (level ${level}) failed to respond (${(err as Error).message}).`);
    markAiStalled(game.id);
    return;
  }
  clearAiStalled(game.id);
  const aiResult = outcome.result;

  // Re-check: state may have moved on (e.g. an undo), or the AI's own clock
  // may have run out, while GNU Go was thinking.
  let freshGame = getGameRow(game.id);
  if (!freshGame || freshGame.status !== 'in_progress') {
    return;
  }
  freshGame = withTimeoutCheck(freshGame);
  if (freshGame.status !== 'in_progress') {
    return;
  }

  // Recorded against the move number this move is about to take, before
  // anything is applied — afterwards the counter has moved on.
  recordGnugoTimings(freshGame, getNextMoveNumber(freshGame.id), level, outcome.timings);

  if (aiResult.type === 'move') {
    const applied = applyMoveToGame(freshGame, aiResult.point.x, aiResult.point.y, currentColor);
    if (!applied.ok) {
      console.error(`GNU Go proposed an illegal move (${applied.error}).`);
    }
  } else if (aiResult.type === 'resign') {
    applyResignToGame(freshGame, currentColor);
  } else {
    applyPassToGame(freshGame, currentColor);
  }
}

// An allowlist, not an escape. A username is shown to other players and
// typed by them when inviting, so it stays in the one alphabet everybody
// can reach on every keyboard: lowercase ASCII, digits and underscore.
// That also makes two names impossible to confuse — no case variants, no
// letters that merely look alike.
const USERNAME_PATTERN = /^[a-z0-9_]+$/;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 12;
const MIN_PASSWORD_LENGTH = 6;
// Generous but bounded — an unbounded password lets a client force
// expensive scrypt hashing over an arbitrarily large string on every
// register/login attempt.
const MAX_PASSWORD_LENGTH = 128;

// Registration is unauthenticated and hashes a password with scrypt, which
// is deliberately expensive — without a limit, anyone can spend this
// server's CPU (and fill the user table) as fast as they can send
// requests. Looser than the login limit: a household behind one address
// might legitimately sign up a few accounts in a sitting.
const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: registerLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created — try again later.' },
});

app.post('/api/auth/register', registerRateLimiter, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
    fail(res, 400, 'Username must be %@-%@ characters', [MIN_USERNAME_LENGTH, MAX_USERNAME_LENGTH]);
    return;
  }
  // Existing accounts are untouched: this is checked when a name is chosen,
  // never when one logs in.
  if (!USERNAME_PATTERN.test(username)) {
    fail(res, 400, 'A username can use a-z, 0-9 and _');
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    fail(res, 400, 'Password must be %@-%@ characters', [MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH]);
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    fail(res, 400, 'Username is already taken');
    return;
  }

  const id = randomUUID();
  const now = Date.now();
  // Shown here and never again: the server keeps only its hash, the same
  // way it keeps the password. Whoever registers is told to write it down.
  const recoveryCode = generateRecoveryCode();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, created_at, recovery_hash, recovery_set_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, username, hashPassword(password), now, hashRecoveryCode(recoveryCode), now);

  const token = createSession(id);
  setSessionCookie(res, token);
  res.status(201).json({ id, username, recoveryCode });
});

// A new code for an account that has none (everyone who registered before
// there were any) or whose code has been used, forgotten or written down
// somewhere it shouldn't have been. The password is required: this hands
// out a key to the account.
app.post('/api/auth/recovery-code', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    fail(res, 400, 'Current password is incorrect');
    return;
  }

  const recoveryCode = generateRecoveryCode();
  db.prepare('UPDATE users SET recovery_hash = ?, recovery_set_at = ? WHERE id = ?')
    .run(hashRecoveryCode(recoveryCode), Date.now(), user.id);
  res.json({ recoveryCode });
});

// Both limiters key on req.ip, which is the socket's own address because
// Express's "trust proxy" follows TRUST_PROXY (see config.ts), which is
// off where this process is the edge server — as on the Pi, which
// terminates TLS itself and answers certbot's challenge directly — and on
// where a proxy, tunnel or CDN sits in front. Getting it wrong either way
// breaks this limiter: off behind a proxy, every request looks like it
// came from the proxy and one attacker throttles everybody; on without
// one, anyone can spoof X-Forwarded-For and evade the limit entirely.
//
// Standard login-throttling values (express-rate-limit's own canonical
// example, matching common OWASP-style guidance): 5 attempts per 15
// minutes per IP, to slow down password brute-forcing.
// Guessing a code is the only way in without a password, so this is the
// endpoint worth throttling. Ten attempts a quarter of an hour against 80
// bits of code is not a race anyone wins, and it leaves room for someone
// mistyping one off a piece of paper a few times.
const recoveryRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again later.' },
});

// Setting a password without the old one, for someone who kept the code
// they were given. No email, because this server sends none: the code was
// handed over at registration and is the whole proof.
app.post('/api/auth/reset-password', recoveryRateLimiter, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, MAX_USERNAME_LENGTH) : '';
  const code = typeof req.body?.recoveryCode === 'string' ? req.body.recoveryCode : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

  if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
    fail(res, 400, 'Password must be %@-%@ characters', [MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH]);
    return;
  }

  const row = db
    .prepare('SELECT id, recovery_hash FROM users WHERE username = ? AND deleted_at IS NULL')
    .get(username) as { id: string; recovery_hash: string | null } | undefined;
  // One message for a name that doesn't exist, an account with no code and
  // a code that doesn't match: telling them apart would turn this into a
  // way of asking which usernames are real.
  if (!row || !row.recovery_hash || !verifyRecoveryCode(code, row.recovery_hash)) {
    fail(res, 400, 'Username or recovery code is incorrect');
    return;
  }

  // The code is spent, and a fresh one comes back with the answer — losing
  // a password shouldn't leave anyone without a way to do it again.
  const recoveryCode = generateRecoveryCode();
  const now = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, recovery_hash = ?, recovery_set_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), hashRecoveryCode(recoveryCode), now, row.id);
    // Whoever was signed in as this account may be exactly who they are
    // recovering it from.
    destroyOtherSessions(row.id, null);
  })();

  res.json({ recoveryCode });
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again later.' },
});

app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  // Reject oversized input before it ever reaches a DB lookup or a scrypt
  // hash comparison — a valid credential can never be this long anyway.
  if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    fail(res, 401, 'Invalid username or password');
    return;
  }

  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username) as
    | { id: string; username: string; password_hash: string }
    | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    fail(res, 401, 'Invalid username or password');
    return;
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    destroySession(token);
  }
  clearSessionCookie(res);
  res.status(204).end();
});

// Also what this server can do, since both clients call this at launch and
// nothing here changes while it runs: a server with GNU Go switched off (or
// simply not installed) shouldn't be offering games against it.
app.get('/api/auth/me', async (req, res) => {
  res.json({
    user: getSessionUser(req),
    features: { gnugo: await isGnuGoAvailable(), gnugoDebugPerformance },
  });
});

// The "Accept invitations" toggle — the only self-service account setting
// besides the password, hence living under /api/auth rather than needing a
// dedicated settings resource for just one field.
app.patch('/api/auth/me', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const acceptsInvitations = req.body?.acceptsInvitations;
  if (typeof acceptsInvitations !== 'boolean') {
    fail(res, 400, 'acceptsInvitations must be a boolean');
    return;
  }
  db.prepare('UPDATE users SET accepts_invitations = ? WHERE id = ?').run(acceptsInvitations ? 1 : 0, user.id);
  res.status(204).end();
});

// Requires the current password (not just a valid session) before setting
// a new one — same defense as any "change password" flow, since a session
// cookie alone (left logged in on a shared/unlocked device, say) shouldn't
// be enough to lock the real owner out.
app.post('/api/auth/password', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

  if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
    fail(res, 400, 'Password must be %@-%@ characters', [MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH]);
    return;
  }

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    fail(res, 400, 'Current password is incorrect');
    return;
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  // Changing a password is how someone reacts to thinking a session has
  // leaked, so every other session goes — this one stays, or they would
  // be logged out of the device they just did it on.
  destroyOtherSessions(user.id, getSessionToken(req));
  res.json({ success: true });
});

// Deleting an account, which Apple requires any app that creates one to
// offer. The password is asked for again: a session that has been left
// open on someone else's device shouldn't be enough to end an account.
//
// Games are the awkward part, because half of one belongs to somebody
// else. A game this account played alone — both colours, or against GNU Go
// — is nobody else's record and goes with it. A game against another
// player is that player's game too, so it stays, and the row that used to
// be an account becomes a marker with nothing personal left on it: no
// name, no password that can be used, no settings, no tags. The games keep
// an opponent; the person is gone.
app.delete('/api/auth/me', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    fail(res, 400, 'Current password is incorrect');
    return;
  }

  const aiId = getAiUserId();
  const soloGames = db
    .prepare(
      `SELECT id FROM games
         WHERE (black_user_id = ? OR white_user_id = ?)
           AND (black_user_id = white_user_id
                OR black_user_id = ? OR white_user_id = ?)`,
    )
    .all(user.id, user.id, aiId, aiId) as { id: string }[];

  const now = Date.now();
  db.transaction(() => {
    for (const game of soloGames) {
      db.prepare('DELETE FROM events WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM snapshots WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM stars WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM vision_tokens WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM games WHERE id = ?').run(game.id);
    }

    // Everything that was only ever this account's.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM device_tokens WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM user_tags WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM quick_game_presets WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM stars WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM vision_tokens WHERE created_by = ?').run(user.id);
    // Both directions: the list they kept, and everyone else's entry for
    // them. Whoever takes this username next starts unblocked by all.
    db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?').run(user.id, user.id);
    // Their personal tags on games that remain. A shared tag stays: it was
    // put on the game for both players, and the other one still has it.
    db.prepare('DELETE FROM game_tags WHERE user_id = ? AND is_public = 0').run(user.id);
    // An invitation nobody can accept any more.
    db.prepare("UPDATE games SET invited_user_id = NULL, invite_status = NULL WHERE invited_user_id = ? AND invite_status = 'pending'")
      .run(user.id);

    // What's left is a marker, and it is never an account again: no
    // password verifies against a hash that isn't one.
    db.prepare(
      `UPDATE users
          SET username = ?, password_hash = '', recovery_hash = NULL, recovery_set_at = NULL,
              accepts_invitations = 0, favourite_tag = NULL, deleted_at = ?
        WHERE id = ?`,
    ).run(deletedUsername(user.id), now, user.id);
  })();

  broadcastGamesListUpdate();
  res.json({ success: true });
});

// The name a deleted account leaves behind: unmistakably not a person, and
// derived from the id so two of them can't collide. The original username
// is freed by this, which is deliberate — it was theirs, and it is nobody's
// now.
function deletedUsername(userId: string): string {
  return `deleted_${userId.replace(/-/g, '').slice(0, 4)}`;
}

// A 1-2 character query is too short to search the whole user base
// usefully (way too many matches), but is exactly enough to jog a memory
// of "who did I just play" — so under 3 characters, search is narrowed to
// opponents from games active within this window instead. Approximated as
// 90 days rather than exact calendar months, which would need actual date
// arithmetic for a distinction nobody would notice.
const RECENT_OPPONENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Backs the new-game form's opponent-username autocomplete. Registered
// before /api/users/:id so "search" doesn't get swallowed as an :id value.
// % and _ are escaped since usernames have no charset restriction beyond
// length — an unescaped one would otherwise act as a SQL LIKE wildcard.
app.get('/api/users/search', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    res.json([]);
    return;
  }
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  const pattern = `${escaped}%`;
  const aiId = getAiUserId();

  // accepts_invitations = 1 OR id = ? (self) so someone who's opted out
  // still finds themself — they're just invisible to everyone else. The
  // AI needs no such exception: its row defaults to accepts_invitations =
  // 1 and nothing ever changes it.
  //
  // Someone who has blocked this searcher drops out the same way, which is
  // the point: a block should look like a global opt-out from the outside.
  if (query.length >= 3) {
    const rows = db
      .prepare(
        `SELECT id, username FROM users
         WHERE username LIKE ? ESCAPE '\\' AND deleted_at IS NULL AND (accepts_invitations = 1 OR id = ?)
           AND id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = ?)
         ORDER BY username LIMIT 10`,
      )
      .all(pattern, user.id, user.id) as { id: string; username: string }[];
    res.json(rows.map((row) => ({ username: row.username, isAi: row.id === aiId })));
    return;
  }

  const opponentRows = db
    .prepare(
      `SELECT DISTINCT u.id, u.username
       FROM games g
       JOIN users u ON u.id = CASE WHEN g.black_user_id = ? THEN g.white_user_id ELSE g.black_user_id END
       WHERE (g.black_user_id = ? OR g.white_user_id = ?)
         AND g.black_user_id != g.white_user_id
         AND g.updated_at >= ?
         AND u.username LIKE ? ESCAPE '\\'
         AND u.accepts_invitations = 1
         AND u.id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = ?)
       ORDER BY u.username
       LIMIT 10`,
    )
    .all(user.id, user.id, user.id, Date.now() - RECENT_OPPONENT_WINDOW_MS, pattern, user.id) as {
    id: string;
    username: string;
  }[];

  const results = opponentRows.map((row) => ({ username: row.username, isAi: row.id === aiId }));
  // A "me" shortcut on top of the recent-opponents list: typing "m"/"me"
  // (a prefix of the literal word "me") or a prefix of your own username
  // surfaces yourself first — you're never a "recent opponent" of your
  // own games, so the query above alone would never suggest you.
  const lowerQuery = query.toLowerCase();
  if ('me'.startsWith(lowerQuery) || user.username.toLowerCase().startsWith(lowerQuery)) {
    results.unshift({ username: user.username, isAi: false });
  }
  res.json(results);
});

// A profile page (web /profile/:id, iOS's Account tab and the same path as
// a universal link) — any logged-in user can look up any other user's
// public info by id, not just their own. The users table only has
// username and created_at beyond the id/password hash, so that's all this
// returns. acceptsInvitations is harmless to expose publicly (more a "do
// not disturb" flag than sensitive data) — returning it here means the
// profile page can show/edit it without a separate endpoint.
app.get('/api/users/:id', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const row = db
    .prepare('SELECT id, username, created_at, accepts_invitations FROM users WHERE id = ?')
    .get(req.params.id) as
    | {
        id: string;
        username: string;
        created_at: number;
        accepts_invitations: number;
      }
    | undefined;
  if (!row) {
    fail(res, 404, 'User not found');
    return;
  }
  const stats = getUserStats(row.id);
  res.json({
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    acceptsInvitations: row.accepts_invitations === 1,
    // Whether the viewer blocks this person, so their profile can offer
    // the right one of Block/Unblock. Never the other direction: being
    // told you are blocked is exactly what blocking hides.
    blocked: row.id === user.id ? false : hasBlocked(user.id, row.id),
    gamesPlayed: stats.played,
    gamesWon: stats.won,
    gamesLost: stats.lost,
  });
});

// Who this user refuses invitations from. Only ever their own list: there
// is no way to ask who blocks you, which is what keeps a block
// indistinguishable from a global opt-out.
app.get('/api/blocks', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT u.username FROM blocked_users b
       JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? AND u.deleted_at IS NULL
       ORDER BY u.username`,
    )
    .all(user.id) as { username: string }[];
  res.json(rows.map((row) => row.username));
});

app.post('/api/blocks', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const target = db.prepare('SELECT id FROM users WHERE username = ? AND deleted_at IS NULL').get(username) as
    | { id: string }
    | undefined;
  if (!target) {
    fail(res, 404, 'User not found');
    return;
  }
  if (target.id === user.id) {
    fail(res, 400, 'You cannot block yourself');
    return;
  }

  db.prepare('INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(
    user.id,
    target.id,
    Date.now(),
  );

  // An invitation already waiting between the two goes with it, in either
  // direction. Had the block been in place it could never have been sent,
  // and that is the state being restored — so it goes quietly, without the
  // "declined your invitation" push that rejecting one sends. Games
  // already under way are left alone: this stops new invitations, it
  // doesn't erase what was played.
  const pending = db
    .prepare(
      `SELECT id FROM games WHERE invite_status = 'pending'
         AND ((black_user_id = ? AND white_user_id = ?) OR (black_user_id = ? AND white_user_id = ?))`,
    )
    .all(user.id, target.id, target.id, user.id) as { id: string }[];
  for (const row of pending) {
    deleteGameRecord(row.id);
    broadcastGameUpdate(row.id);
  }
  if (pending.length > 0) {
    broadcastGamesListUpdate();
  }

  res.status(204).end();
});

app.delete('/api/blocks/:username', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  // By username rather than id because that is what the list hands back,
  // and usernames are [a-z0-9_] so they need no encoding in a path.
  db.prepare(
    `DELETE FROM blocked_users
     WHERE blocker_id = ? AND blocked_id = (SELECT id FROM users WHERE username = ?)`,
  ).run(user.id, req.params.username);
  res.status(204).end();
});

// Registers (or re-registers) an iOS device's APNs token against the
// logged-in user, so notifyOpponentOfMove knows where to push "it's your
// turn". A token is re-assigned to whichever user last registered it,
// covering both a reinstall and a shared device switching accounts.
app.post('/api/device-tokens', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const token = req.body?.token;
  if (typeof token !== 'string' || token.length === 0) {
    fail(res, 400, 'Invalid device token');
    return;
  }

  db.prepare(`
    INSERT INTO device_tokens (token, user_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at
  `).run(token, user.id, Date.now());

  res.status(204).end();
});

// A quick way to answer "did my device actually register a push token?"
// without needing device console access — registration itself is silent
// on success (see the iOS AppDelegate), so this is otherwise unobservable
// short of reading the games DB directly.
app.get('/api/device-tokens/mine', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM device_tokens WHERE user_id = ?').get(user.id) as {
    count: number;
  };
  res.json({ registered: row.count > 0, count: row.count });
});

// Pairs with the endpoint above: confirms whether *this running process*
// currently has all five APNS_* env vars loaded, without exposing their
// values — the two most common setup mistakes (a pm2 restart that didn't
// pick up an edited env file, or a var name typo) are otherwise invisible
// until a push silently no-ops.
app.get('/api/apns-status', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  res.json({ configured: isApnsConfigured() });
});

// Backs the new-game form's handicap/level auto-fill: given an opponent
// (by username, or the reserved AI account via `ai=1`), find the most
// recent game against that same opponent and return its handicap/gnugo
// level — or null if there's no prior game to base a prefill on. Reuses
// the exact username→id resolution POST /api/games's remote branch uses,
// so "no such user" behaves identically in both places.
app.get('/api/games/recent-vs', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  let opponentId: string;
  if (req.query.ai === '1') {
    opponentId = getAiUserId();
  } else {
    const opponentUsername = typeof req.query.opponentUsername === 'string' ? req.query.opponentUsername.trim() : '';
    if (!opponentUsername) {
      fail(res, 400, 'opponentUsername or ai is required');
      return;
    }
    const opponent = db.prepare('SELECT id FROM users WHERE username = ?').get(opponentUsername) as
      | { id: string }
      | undefined;
    if (!opponent) {
      fail(res, 404, 'No user named "%@"', [opponentUsername]);
      return;
    }
    opponentId = opponent.id;
  }

  const row = db
    .prepare(
      `SELECT handicap, gnugo_level FROM games
       WHERE (black_user_id = ? AND white_user_id = ?) OR (black_user_id = ? AND white_user_id = ?)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(user.id, opponentId, opponentId, user.id) as { handicap: number; gnugo_level: number | null } | undefined;

  res.json(row ? { handicap: row.handicap, gnugoLevel: row.gnugo_level } : null);
});

// One saved new-game configuration per user, behind the iOS app's
// shake-to-play gesture. Deliberately stores only what the new-game form
// collects: shaking calls POST /api/games with these values, so every rule
// that endpoint enforces (one open short game, GNU Go availability, invite
// eligibility) still applies at the moment the game is actually created.
interface QuickGamePresetRow {
  mode: string;
  size: number;
  handicap: number;
  komi: number;
  time_control: string | null;
  gnugo_level: number | null;
  color: string;
  opponent_username: string | null;
  tags: string;
  shake_to_play: number;
}

// What a user who has never saved one gets: the quickest game there is,
// a small board against the computer.
const DEFAULT_QUICK_GAME_PRESET: QuickGamePresetRow = {
  mode: 'gnugo',
  size: 9,
  handicap: 0,
  komi: 6.5,
  time_control: 'standard',
  gnugo_level: 5,
  color: 'black',
  opponent_username: null,
  tags: '[]',
  shake_to_play: 0,
};

function quickGamePresetResponse(row: QuickGamePresetRow) {
  return {
    mode: row.mode,
    size: row.size,
    handicap: row.handicap,
    komi: row.komi,
    timeControl: row.time_control,
    gnugoLevel: row.gnugo_level,
    color: row.color,
    opponentUsername: row.opponent_username,
    tags: parsePresetTags(row.tags),
    shakeToPlay: row.shake_to_play === 1,
  };
}

// Stored as JSON, so a hand-edited or pre-tags row shouldn't throw —
// anything unreadable reads as "no tags".
function parsePresetTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

// The same rules as a tag on a game: same charset, same length, same cap,
// same case-insensitive dedupe — a preset's tags end up in game_tags
// verbatim, so anything they'd reject there is rejected here.
function sanitizePresetTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags)) {
    return [];
  }
  const tags: string[] = [];
  for (const rawTag of rawTags) {
    const tag = sanitizeTag(rawTag);
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
    if (tags.length === MAX_TAGS_PER_GAME) {
      break;
    }
  }
  return tags;
}

app.get('/api/quick-game-preset', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const row = db
    .prepare('SELECT * FROM quick_game_presets WHERE user_id = ?')
    .get(user.id) as QuickGamePresetRow | undefined;
  if (row) {
    res.json(quickGamePresetResponse(row));
    return;
  }
  // The default is only a default where it can actually be played. A
  // server with GNU Go switched off would otherwise hand every new user a
  // preset for a game it refuses to create, which the clients then show
  // as the chosen mode.
  const fallback = (await isGnuGoAvailable())
    ? DEFAULT_QUICK_GAME_PRESET
    : { ...DEFAULT_QUICK_GAME_PRESET, mode: 'local' };
  res.json(quickGamePresetResponse(fallback));
});

// Validated the same way POST /api/games validates its body, so a preset
// can't smuggle in a board size or komi that endpoint would reject — out
// of range values fall back rather than failing, since a preset is a set
// of preferences, not a command.
app.put('/api/quick-game-preset', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const requestedMode = req.body?.mode === 'local' || req.body?.mode === 'remote' ? req.body.mode : 'gnugo';
  // Saved as a local game instead of refused, in keeping with the rest of
  // this handler: a preset is a set of preferences, not a command. The
  // response says what was stored, so a client that asked for the
  // impossible sees the correction.
  const mode = requestedMode === 'gnugo' && !(await isGnuGoAvailable()) ? 'local' : requestedMode;
  const requestedSize = Number(req.body?.size);
  const size = ALLOWED_BOARD_SIZES.includes(requestedSize) ? requestedSize : 9;
  const maxHandicap = size === 19 ? 9 : 5;
  const handicap = Math.min(Math.max(0, Number(req.body?.handicap) || 0), maxHandicap);
  const requestedKomi = Number(req.body?.komi);
  const allowedKomi = handicap > 0 ? ALLOWED_KOMI_HANDICAP : ALLOWED_KOMI_EVEN;
  const komi = allowedKomi.includes(requestedKomi) ? requestedKomi : handicap > 0 ? 0.5 : 6.5;
  const timeControl =
    req.body?.timeControl === 'standard' || req.body?.timeControl === 'correspondence' ? req.body.timeControl : null;
  const requestedLevel = Number(req.body?.gnugoLevel);
  const gnugoLevel = Number.isInteger(requestedLevel) && requestedLevel >= 1 && requestedLevel <= 10 ? requestedLevel : 5;
  const color = req.body?.color === 'white' || req.body?.color === 'random' ? req.body.color : 'black';
  // Not checked against the users table here: who is accepting invitations
  // changes over time, so it's POST /api/games at shake time that decides
  // whether this opponent can still be invited.
  const opponentUsername =
    mode === 'remote' && typeof req.body?.opponentUsername === 'string' && req.body.opponentUsername.trim()
      ? req.body.opponentUsername.trim().slice(0, MAX_USERNAME_LENGTH)
      : null;

  if (mode === 'remote' && !opponentUsername) {
    fail(res, 400, "Opponent's username is required for a remote game");
    return;
  }

  const row: QuickGamePresetRow = {
    mode,
    size,
    handicap,
    komi,
    time_control: timeControl,
    gnugo_level: gnugoLevel,
    color,
    opponent_username: opponentUsername,
    tags: JSON.stringify(sanitizePresetTags(req.body?.tags)),
    shake_to_play: req.body?.shakeToPlay === true ? 1 : 0,
  };

  db.prepare(
    `INSERT INTO quick_game_presets
       (user_id, mode, size, handicap, komi, time_control, gnugo_level, color, opponent_username, tags, shake_to_play, updated_at)
     VALUES (@user_id, @mode, @size, @handicap, @komi, @time_control, @gnugo_level, @color, @opponent_username, @tags, @shake_to_play, @updated_at)
     ON CONFLICT(user_id) DO UPDATE SET
       mode = excluded.mode,
       size = excluded.size,
       handicap = excluded.handicap,
       komi = excluded.komi,
       time_control = excluded.time_control,
       gnugo_level = excluded.gnugo_level,
       color = excluded.color,
       opponent_username = excluded.opponent_username,
       tags = excluded.tags,
       shake_to_play = excluded.shake_to_play,
       updated_at = excluded.updated_at`,
  ).run({ ...row, user_id: user.id, updated_at: Date.now() });

  res.json(quickGamePresetResponse(row));
});

app.get('/api/games', (req, res) => {
  const currentUser = getSessionUser(req);
  // "mine" and "starred" are meaningless without an identity to filter by —
  // fall back to the unfiltered list rather than showing an anonymous
  // visitor nothing.
  const requestedScope = req.query.scope;
  const scope =
    currentUser && (requestedScope === 'mine' || requestedScope === 'starred') ? requestedScope : 'all';

  const ids = db.prepare('SELECT id FROM games ORDER BY updated_at DESC').all() as { id: string }[];
  let rows = ids.map((row) => withTimeoutCheck(getGameRow(row.id)!));

  if (scope === 'mine' && currentUser) {
    rows = rows.filter(
      (row) =>
        isParticipant(row, currentUser.id) || isStarred(row.id, currentUser.id),
    );
  } else if (scope === 'starred' && currentUser) {
    // Only the games this user actually starred — a subset of "mine",
    // which also includes every game they play in. Backs the iOS app's
    // Favourites tab.
    rows = rows.filter((row) => isStarred(row.id, currentUser.id));
  }

  // Free-text search over the title, both player names and the game's tags.
  // Shorter than MIN_SEARCH_LENGTH is ignored rather than rejected: the
  // clients only start searching at that length anyway, and a half-typed
  // word matching nearly everything is noise, not a result set. Matching
  // happens in JS over the rows already loaded above (this endpoint has
  // always read them all), so the query text never reaches SQL at all.
  const query = searchQuery(req.query.q);
  if (query) {
    rows = rows.filter((row) => matchesSearch(row, query, currentUser?.id ?? null));
  }

  // Pagination is opt-in via `limit` — omitting it (as the iOS app still
  // does) returns every matching game, exactly as before. When present, one
  // extra row beyond `limit` is included so the caller can tell whether
  // more pages remain (client/src/services/api.ts's listGames trims it off)
  // without needing a second response field or a page-count query.
  const limit = Number(req.query.limit);
  if (Number.isInteger(limit) && limit > 0) {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    rows = rows.slice(offset, offset + limit + 1);
  }

  res.json(rows.map((row) => ({
    id: row.id,
    size: row.size,
    status: row.status,
    result: row.result,
    // Standard-notation result (e.g. "B+2", "W+R") for the compact list
    // card — null for an unfinished game or one ended with no score.
    shortResult: deriveSgfResult(row),
    handicap: row.handicap,
    komi: resolveKomi(row),
    title: row.title,
    tags: getGameTags(row.id, currentUser?.id ?? null),
    publicTags: getPublicGameTags(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blackUsername: getUsername(row.black_user_id),
    whiteUsername: getUsername(row.white_user_id),
    blackUserId: row.black_user_id,
    whiteUserId: row.white_user_id,
    myColor: getMyColor(row, currentUser?.id ?? null),
    isAiOpponent: isAiOpponentGame(row),
    gnugoLevel: row.gnugo_level,
    timeControl: row.time_control,
    starred: isStarred(row.id, currentUser?.id ?? null),
  })));
});

app.post('/api/games', async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  // An unbounded size would let a client force an arbitrarily huge board
  // allocation (createEmptyBoard(size) is O(size^2)) — only the sizes the
  // client actually offers are valid, so anything else falls back to 19
  // rather than trusting the request.
  const requestedSize = Number(req.body?.size);
  const size = ALLOWED_BOARD_SIZES.includes(requestedSize) ? requestedSize : 19;
  // Handicap placement is only defined for boards with a known star-point layout
  const maxHandicap = size === 19 ? 9 : 5;
  const handicap = BOARD_SIZES.includes(size) ? Math.min(Math.max(0, Number(req.body?.handicap) || 0), maxHandicap) : 0;
  // A handicap game's komi is just a tie-breaker (0.5 or 0 — the handicap
  // stones are the real compensation); an even game picks from the values
  // that support correct classic scoring under each rule set. Anything
  // else the client sends falls back to the default for that case.
  const requestedKomi = Number(req.body?.komi);
  const allowedKomi = handicap > 0 ? ALLOWED_KOMI_HANDICAP : ALLOWED_KOMI_EVEN;
  const komi = allowedKomi.includes(requestedKomi) ? requestedKomi : handicap > 0 ? 0.5 : 6.5;
  const title = sanitizeTitle(req.body?.title);
  const timeControlName: TimeControlName = req.body?.timeControl === 'standard' || req.body?.timeControl === 'correspondence'
    ? req.body.timeControl
    : 'unlimited';
  const preset = resolveTimeControl(timeControlName);

  let blackUserId = user.id;
  let whiteUserId = user.id;
  let gnugoLevel: number | null = null;
  let invitedOpponentId: string | null = null;

  // 'random' is nigiri — the traditional stone-guessing method — for anyone
  // who doesn't care which color they get.
  const resolveColor = (requested: unknown): Color =>
    requested === 'random' ? (Math.random() < 0.5 ? 'black' : 'white') : requested === 'white' ? 'white' : 'black';

  if (req.body?.mode === 'remote') {
    const opponentUsername =
      typeof req.body?.opponentUsername === 'string' ? req.body.opponentUsername.trim() : '';

    if (!opponentUsername) {
      fail(res, 400, "Opponent's username is required for a remote game");
      return;
    }
    if (req.body?.color !== 'black' && req.body?.color !== 'white' && req.body?.color !== 'random') {
      fail(res, 400, 'Choose which color you will play');
      return;
    }

    const opponent = db.prepare('SELECT id, accepts_invitations FROM users WHERE username = ?').get(opponentUsername) as
      | { id: string; accepts_invitations: number }
      | undefined;
    // Self-invite gets its own message regardless of the toggle — telling
    // someone their own account "isn't accepting invitations" would just
    // be confusing. A nonexistent username and an existing-but-opted-out
    // one deliberately share one message: distinguishing them would let
    // this endpoint be used to enumerate which usernames exist.
    if (opponent && opponent.id === user.id) {
      fail(res, 400, 'Invite a different user, not yourself');
      return;
    }
    // Blocked is folded into the same answer as opted-out and nonexistent,
    // for the same reason they already share one: anything that singled
    // blocking out would tell the blocked person they had been blocked.
    if (!opponent || opponent.accepts_invitations !== 1 || hasBlocked(opponent.id, user.id)) {
      fail(res, 400, "Selected player isn't currently accepting invitations");
      return;
    }
    if (timeControlName === 'standard' && hasOpenStandardGame(opponent.id)) {
      fail(res, 400, '%@ already has a short game in progress', [opponentUsername]);
      return;
    }

    const color = resolveColor(req.body.color);
    blackUserId = color === 'black' ? user.id : opponent.id;
    whiteUserId = color === 'white' ? user.id : opponent.id;
    invitedOpponentId = opponent.id;
  } else if (req.body?.mode === 'gnugo') {
    if (!(await isGnuGoAvailable())) {
      fail(res, 400, 'Games against GNU Go are unavailable on this server.');
      return;
    }
    if (hasOpenAiGame()) {
      fail(res, 400, 'GNU Go already has a short game in progress — finish or delete it before starting another.');
      return;
    }
    const color = resolveColor(req.body?.color);
    const aiId = getAiUserId();
    blackUserId = color === 'black' ? user.id : aiId;
    whiteUserId = color === 'white' ? user.id : aiId;

    const requestedLevel = Number(req.body?.level);
    if (Number.isInteger(requestedLevel) && requestedLevel >= 1 && requestedLevel <= 10) {
      gnugoLevel = requestedLevel;
    }
  }

  const id = randomUUID();
  const now = Date.now();
  const initialTimeMs = preset ? preset.mainTimeSeconds * 1000 : null;
  const initialPeriods = preset ? preset.byoyomiPeriods : null;

  db.prepare(`
    INSERT INTO games (
      id, size, handicap, title, created_at, updated_at, status, black_user_id, white_user_id,
      time_control, main_time_seconds, byoyomi_seconds, byoyomi_periods,
      black_time_remaining_ms, white_time_remaining_ms, black_periods_left, white_periods_left, turn_started_at,
      gnugo_level, komi, invited_user_id, invite_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, size, handicap, title, now, now, 'in_progress', blackUserId, whiteUserId,
    preset ? timeControlName : null,
    preset ? preset.mainTimeSeconds : null,
    preset ? preset.byoyomiSeconds : null,
    initialPeriods,
    // A pending invite hasn't started yet from the invited player's point of
    // view — turn_started_at stays NULL (computeLiveClock/withTimeoutCheck
    // both already treat that as "frozen, not ticking") until respond-invite
    // accepts it, so no clock time (or timeout) accrues against either
    // player before they've actually agreed to play.
    initialTimeMs, initialTimeMs, initialPeriods, initialPeriods, invitedOpponentId ? null : now,
    gnugoLevel, komi,
    invitedOpponentId,
    invitedOpponentId ? 'pending' : null,
  );

  const board = createEmptyBoard(size);
  const handicapPoints = getHandicapPoints(size, handicap);
  for (const [x, y] of handicapPoints) {
    board[y][x] = 'black';
  }

  if (handicapPoints.length > 0) {
    db.prepare(`
      INSERT INTO snapshots (game_id, move_number, state, hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 0, JSON.stringify(board), hashBoard(board).toString(), now);

    db.prepare(`
      INSERT INTO events (game_id, move_number, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 0, 'HANDICAP', JSON.stringify({ handicap, points: handicapPoints }), now);
  }

  // Optional, and validated exactly as POST /api/games/:id/tags would —
  // it exists so a quick game can arrive already labelled rather than
  // needing a follow-up request per tag.
  for (const tag of sanitizePresetTags(req.body?.tags)) {
    addGameTag(id, tag, user.id, now);
    rememberUserTag(user.id, tag, false, now);
  }

  broadcastGamesListUpdate();

  if (invitedOpponentId) {
    notifyOfInvite(user.id, invitedOpponentId, id, title);
  }

  res.status(201).json({
    id,
    size,
    handicap,
    title,
    status: 'in_progress',
    board,
    blackUsername: getUsername(blackUserId),
    whiteUsername: getUsername(whiteUserId),
    blackUserId,
    whiteUserId,
  });

  // No-op unless the AI was just assigned the color that moves first
  // (always true for AI-as-black; true for AI-as-white in a handicap game).
  maybeTriggerAiMove(id);
});

// A game played on a device — offline, or against someone nearby — sent up
// to be kept. One way: a finished game comes in, is checked move by move
// against the same rules every game here is played under, and is stored
// like any other. Nothing is sent back down, and a game that already lives
// here is never imported.
//
// The device refereed it, but that is not why it is accepted: every move is
// replayed here before anything is written, so a device sending a log it
// made up gets a refusal rather than a game. The result is computed here
// too, never taken from the request.
const importRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many games published — try again later.' },
});

// Long enough for any real game on any board offered here (a 19x19 game
// runs to a few hundred moves), short enough that a replay can't be used to
// tie the server up.
const MAX_IMPORTED_EVENTS = 1000;

app.post('/api/games/import', importRateLimiter, (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  const requestedSize = Number(req.body?.size);
  if (!ALLOWED_BOARD_SIZES.includes(requestedSize)) {
    fail(res, 400, 'Unsupported board size');
    return;
  }
  const size = requestedSize;
  const maxHandicap = size === 19 ? 9 : 5;
  const handicap = Math.min(Math.max(0, Number(req.body?.handicap) || 0), maxHandicap);
  const requestedKomi = Number(req.body?.komi);
  const allowedKomi = handicap > 0 ? ALLOWED_KOMI_HANDICAP : ALLOWED_KOMI_EVEN;
  const komi = allowedKomi.includes(requestedKomi) ? requestedKomi : handicap > 0 ? 0.5 : 6.5;
  const title = sanitizeTitle(req.body?.title);

  const rawEvents: unknown = req.body?.events;
  if (!Array.isArray(rawEvents)) {
    fail(res, 400, 'A published game needs its moves');
    return;
  }
  if (rawEvents.length > MAX_IMPORTED_EVENTS) {
    fail(res, 400, 'That game has too many moves to publish');
    return;
  }

  // The same starting position the server would have built for a game with
  // this handicap: the placement is derived here rather than taken from the
  // device, so an import can't invent its own stones.
  let board = createEmptyBoard(size);
  const handicapPoints = getHandicapPoints(size, handicap);
  for (const [x, y] of handicapPoints) {
    board[y][x] = 'black';
  }

  // Mirrors getGameHistory: a handicap game's first position is the
  // placement, a plain game's is the empty board.
  const history: PositionRecord[] = [
    { board, hash: hashBoard(board).toString(), nextColor: getCurrentColor(turnMoveNumber(1, handicap)) },
  ];

  type PendingEvent = {
    moveNumber: number;
    eventType: string;
    payload: unknown;
    snapshot?: { state: string; hash: string };
  };
  const pending: PendingEvent[] = [];
  const captures: Captures = { black: 0, white: 0 };
  let played = 0;
  let consecutivePasses = 0;
  let ending: 'resign' | 'scoring' | null = null;
  let resignedColor: Color = 'black';

  for (const raw of rawEvents as Record<string, unknown>[]) {
    if (ending) {
      fail(res, 400, 'That game carries on after it ended');
      return;
    }
    // The placement is the server's to make (above), so the device's own
    // record of it is skipped rather than trusted.
    if (raw?.type === 'handicap') {
      continue;
    }

    const color: Color | null = raw?.color === 'black' || raw?.color === 'white' ? raw.color : null;
    if (!color) {
      fail(res, 400, 'A published game needs its moves');
      return;
    }
    const moveNumber = played + 1;

    if (raw.type === 'move') {
      const x = Number(raw.x);
      const y = Number(raw.y);
      const validation = validateMove(board, { x, y }, color, turnMoveNumber(moveNumber, handicap), history);
      if (!validation.valid) {
        fail(res, 400, validation.error!);
        return;
      }
      board = validation.board!;
      const capturedPoints = validation.capturedPoints!;
      captures[color] += capturedPoints.length;
      pending.push({
        moveNumber,
        eventType: 'MOVE',
        payload: { x, y, color, capturedPoints },
        // Keyframes, as a played game writes them.
        snapshot:
          moveNumber % SNAPSHOT_INTERVAL === 0
            ? { state: JSON.stringify(board), hash: hashBoard(board).toString() }
            : undefined,
      });
      history.push({
        board,
        hash: hashBoard(board).toString(),
        nextColor: getCurrentColor(turnMoveNumber(moveNumber + 1, handicap)),
      });
      played += 1;
      consecutivePasses = 0;
      continue;
    }

    if (raw.type === 'pass') {
      const currentColor = getCurrentColor(turnMoveNumber(moveNumber, handicap));
      if (color !== currentColor) {
        fail(res, 400, `It is ${currentColor}'s turn`);
        return;
      }
      pending.push({ moveNumber, eventType: 'PASS', payload: { color } });
      played += 1;
      consecutivePasses += 1;
      if (consecutivePasses === 2) {
        ending = 'scoring';
      }
      continue;
    }

    if (raw.type === 'resign') {
      pending.push({ moveNumber, eventType: 'RESIGN', payload: { color } });
      played += 1;
      ending = 'resign';
      resignedColor = color;
      continue;
    }

    fail(res, 400, 'A published game needs its moves');
    return;
  }

  if (!ending) {
    fail(res, 400, 'Only a finished game can be published');
    return;
  }

  let result: string;
  if (ending === 'resign') {
    result = `${resignedColor === 'black' ? 'Black' : 'White'} resigned`;
  } else {
    // Counted here, from the board this replay arrived at — the device's
    // own result is never taken on trust, only which stones it marked.
    const deadPoints = parsePointArray(req.body?.deadPoints, size);
    const sekiPoints = parsePointArray(req.body?.sekiPoints, size);
    const { board: effectiveBoard, captures: adjusted } = applyDeadStones(board, captures, deadPoints);
    const score = scoreBoard(effectiveBoard, adjusted, komi, sekiPoints);
    const winnerLabel = score.winner === 'black' ? 'Black' : 'White';
    const marginLabel = Number.isInteger(score.margin) ? String(score.margin) : score.margin.toFixed(1);
    result = `${winnerLabel} wins by ${marginLabel} (B: ${score.black}, W: ${score.white})`;
  }

  const id = randomUUID();
  const now = Date.now();
  const tags = sanitizePresetTags(req.body?.tags);

  // Both seats belong to whoever published it, exactly as a local game's do:
  // the other player may have no account here, and inventing one for them
  // would put a game in a stranger's list.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO games (
        id, size, handicap, title, created_at, updated_at, status, black_user_id, white_user_id,
        komi, result, end_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, size, handicap, title, now, now, 'finished', user.id, user.id, komi, result, ending);

    if (handicapPoints.length > 0) {
      const placed = createEmptyBoard(size);
      for (const [x, y] of handicapPoints) {
        placed[y][x] = 'black';
      }
      db.prepare(`
        INSERT INTO snapshots (game_id, move_number, state, hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, 0, JSON.stringify(placed), hashBoard(placed).toString(), now);
      db.prepare(`
        INSERT INTO events (game_id, move_number, event_type, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, 0, 'HANDICAP', JSON.stringify({ handicap, points: handicapPoints }), now);
    }

    for (const event of pending) {
      if (event.snapshot) {
        db.prepare(`
          INSERT INTO snapshots (game_id, move_number, state, hash, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, event.moveNumber, event.snapshot.state, event.snapshot.hash, now);
      }
      db.prepare(`
        INSERT INTO events (game_id, move_number, event_type, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, event.moveNumber, event.eventType, JSON.stringify(event.payload), now);
    }

    for (const tag of tags) {
      addGameTag(id, tag, user.id, now);
      rememberUserTag(user.id, tag, false, now);
    }
  })();

  broadcastGamesListUpdate();

  res.status(201).json({ id, status: 'finished', result });
});

app.get('/api/games/:id', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }
  game = withTimeoutCheck(game);

  const board = getCurrentBoard(game.id, game.size);
  const moveNumber = getNextMoveNumber(game.id);
  const currentUser = getSessionUser(req);

  res.json({
    id: game.id,
    size: game.size,
    status: game.status,
    result: game.result,
    handicap: game.handicap,
    komi: resolveKomi(game),
    createdAt: game.created_at,
    title: game.title,
    tags: getGameTags(game.id, currentUser?.id ?? null),
    publicTags: getPublicGameTags(game.id),
    starred: isStarred(game.id, currentUser?.id ?? null),
    board,
    currentColor: getCurrentColor(turnMoveNumber(moveNumber, game.handicap)),
    captures: getCumulativeCaptures(game.id),
    lastMove: getLastMovePoint(game.id),
    // For screen readers: a describable record of whatever happened most
    // recently (move/pass/resign), independent of the stone-marker-only
    // lastMove above.
    lastEvent: getLastEvent(game.id),
    // Standard-notation result (e.g. "W+6.5", "B+R") — same derivation the
    // SGF export uses, for a compact footer display next to the longer
    // free-text `result` sentence shown under the board.
    shortResult: deriveSgfResult(game),
    resultBreakdown: deriveScoreBreakdown(game),
    canUndo: hasUndoableEvent(game.id),
    blackUsername: getUsername(game.black_user_id),
    whiteUsername: getUsername(game.white_user_id),
    blackUserId: game.black_user_id,
    whiteUserId: game.white_user_id,
    myColor: getMyColor(game, currentUser?.id ?? null),
    pendingInviteResponse: isPendingInviteFor(game, currentUser?.id ?? null),
    pendingUndoBy: game.pending_undo_by,
    endReason: game.end_reason,
    pendingReopenBy: game.pending_reopen_by,
    isAiOpponent: isAiOpponentGame(game),
    gnugoLevel: game.gnugo_level,
    aiCurrentLevel: game.ai_current_level,
    // GNU Go didn't answer in time for this game. Shown to the player so
    // a waiting board isn't mistaken for a thinking one.
    aiStalled: stalledAiGames.has(game.id),
    timeControl: game.time_control,
    mainTimeSeconds: game.main_time_seconds,
    byoyomiSeconds: game.byoyomi_seconds,
    byoyomiPeriods: game.byoyomi_periods,
    blackTimeRemainingMs: game.black_time_remaining_ms,
    whiteTimeRemainingMs: game.white_time_remaining_ms,
    blackPeriodsLeft: game.black_periods_left,
    whitePeriodsLeft: game.white_periods_left,
    turnStartedAt: game.turn_started_at,
  });
});

app.patch('/api/games/:id', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can edit it');
    return;
  }

  const title = sanitizeTitle(req.body?.title);
  db.prepare('UPDATE games SET title = ? WHERE id = ?').run(title, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ title });
});

// Tags are edited by the same people who can edit the title — both players,
// and nobody else. Both routes answer with the game's full tag list so a
// client never has to reconcile its own copy with a partial response.
app.post('/api/games/:id/tags', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can edit it');
    return;
  }

  const tag = sanitizeTag(req.body?.tag);
  if (!tag) {
    fail(res, 400, 'A tag must be 1-%@ characters of letters, numbers, spaces, - or _', [MAX_TAG_LENGTH]);
    return;
  }

  const tagKey = tag.toLowerCase();
  // Shared with the other player, or kept to yourself — the clients send
  // this from which button was pressed (Share vs Add).
  const isPublic = req.body?.isPublic === true;
  const existing = getGameTags(game.id, user.id);
  // The limit is checked against a tag that isn't already there, so
  // re-adding an existing one at the limit is a no-op rather than an error.
  if (existing.length >= MAX_TAGS_PER_GAME && !existing.some((row) => row.toLowerCase() === tagKey)) {
    fail(res, 400, 'A game can have at most %@ tags', [MAX_TAGS_PER_GAME]);
    return;
  }

  const now = Date.now();
  addGameTag(game.id, tag, isPublic ? null : user.id, now);
  rememberUserTag(user.id, tag, isPublic, now);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ tags: getGameTags(game.id, user.id), publicTags: getPublicGameTags(game.id) });
});

// The tags this user has used before, most-used first, for the clients to
// offer back. Their own vocabulary only: a tag being public makes it
// visible on a game, not a suggestion in someone else's list.
app.get('/api/tags', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT tag, is_public, use_count FROM user_tags
       WHERE user_id = ?
       ORDER BY use_count DESC, updated_at DESC`,
    )
    .all(user.id) as { tag: string; is_public: number; use_count: number }[];
  res.json({
    tags: rows.map((row) => ({ tag: row.tag, isPublic: row.is_public === 1, count: row.use_count })),
  });
});

app.delete('/api/games/:id/tags/:tag', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can edit it');
    return;
  }

  // Matched on the same lowercased key the row is stored under, so removing
  // works regardless of how the caller cased it. A public tag is shared, so
  // either player can take it off the game; a personal one is only ever the
  // owner's to remove, and the other player's copy is untouched either way.
  db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_key = ? AND (is_public = 1 OR user_id = ?)').run(
    game.id,
    req.params.tag.trim().toLowerCase(),
    user.id,
  );

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ tags: getGameTags(game.id, user.id), publicTags: getPublicGameTags(game.id) });
});

// Anyone can star a game they're not playing in — it's how a game they're
// just watching ends up in their "my games" list alongside ones they're
// actually a player in.
app.post('/api/games/:id/star', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  db.prepare('INSERT OR IGNORE INTO stars (user_id, game_id, created_at) VALUES (?, ?, ?)').run(
    user.id,
    game.id,
    Date.now(),
  );
  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ starred: true });
});

app.delete('/api/games/:id/star', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  db.prepare('DELETE FROM stars WHERE user_id = ? AND game_id = ?').run(user.id, game.id);
  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ starred: false });
});

// What each GNU Go move cost, for the per-game performance report. 404
// rather than an empty list when the server isn't measuring, so a client
// can tell "nothing collected" from "not collecting".
app.get('/api/games/:id/gnugo-timings', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }
  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!gnugoDebugPerformance) {
    fail(res, 404, 'This server is not measuring GNU Go performance');
    return;
  }
  // The same trust level as the rest of a game's detail: anyone signed in
  // can look at a game, so anyone signed in can look at its timings.
  const rows = db
    .prepare(
      `SELECT move_number, level, board_size, moves_replayed,
              queue_wait_ms, setup_ms, replay_ms, genmove_ms, total_ms, cpu_ms
         FROM gnugo_timings WHERE game_id = ? ORDER BY move_number`,
    )
    .all(game.id) as Record<string, number | null>[];

  res.json(
    rows.map((row) => ({
      moveNumber: row.move_number,
      level: row.level,
      boardSize: row.board_size,
      movesReplayed: row.moves_replayed,
      queueWaitMs: row.queue_wait_ms,
      setupMs: row.setup_ms,
      replayMs: row.replay_ms,
      genmoveMs: row.genmove_ms,
      totalMs: row.total_ms,
      cpuMs: row.cpu_ms,
    })),
  );
});

app.get('/api/games/:id/history', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  res.json({ size: game.size, moves: getMoveHistory(game.id, game.size) });
});

// Mints a token an external board-vision service can use to submit moves
// for this one game (see isValidVisionToken) without a full player login.
app.post('/api/games/:id/vision-token', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can create a vision token');
    return;
  }

  // Issuing is the natural moment to drop the expired ones — it is rare,
  // and it keeps the table from holding tokens nobody can use.
  db.prepare('DELETE FROM vision_tokens WHERE created_at < ?').run(Date.now() - VISION_TOKEN_LIFETIME_MS);

  const token = randomUUID();
  db.prepare('INSERT INTO vision_tokens (token, game_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    game.id,
    user.id,
    Date.now(),
  );

  res.status(201).json({ token });
});

// No auth required — same spectator model as viewing the game itself.
app.get('/api/games/:id/sgf', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const safeName = game.title?.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
  const filename = `${safeName || game.id}.sgf`;

  // application/x-go-sgf isn't a MIME type browsers recognize, which made
  // Chrome flag the download as an "unconfirmed"/potentially dangerous file
  // even though the header was present — text/plain is universally trusted
  // and SGF is plain text anyway.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(generateSgf(game));
});

// Shared by the plain delete route below and respond-invite's rejection —
// same effect either way: the game and everything recorded against it is
// gone.
function deleteGameRecord(gameId: string): void {
  db.prepare('DELETE FROM events WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM snapshots WHERE game_id = ?').run(gameId);

  db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM stars WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM gnugo_timings WHERE game_id = ?').run(gameId);
  // A token for a game that no longer exists can't authorize anything, but
  // there is no reason to keep the row around either.
  db.prepare('DELETE FROM vision_tokens WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
}

app.delete('/api/games/:id', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can delete it');
    return;
  }

  deleteGameRecord(game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.status(204).end();
});

// Lets the invited side of a pending remote-game invite accept (just clears
// the pending flag — the game already plays normally either way) or reject
// (deletes the game outright, same as the plain delete route, plus a push
// telling the inviter it was declined — the invite's own push was the only
// sign they had of the game existing at all, so a silent deletion would
// otherwise look like it just vanished).
app.post('/api/games/:id/respond-invite', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isPendingInviteFor(game, user.id)) {
    fail(res, 400, 'This game has no pending invitation for you');
    return;
  }

  if (req.body?.accept === true) {
    // The clock (if any) starts counting from here, not from whenever the
    // invite was actually created — see the matching comment on the
    // INSERT in POST /api/games.
    db.prepare('UPDATE games SET invited_user_id = NULL, invite_status = NULL, turn_started_at = ? WHERE id = ?').run(
      Date.now(),
      game.id,
    );
    broadcastGameUpdate(game.id);
    res.json({ status: 'accepted' });
    return;
  }

  const inviterId = inviterIdFor(game);
  deleteGameRecord(game.id);
  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();
  if (inviterId) {
    const invitedName = getUsername(user.id) ?? 'The invited player';
    pushToUser(inviterId, `${invitedName} declined your invitation${game.title ? ` to ${game.title}` : ''}.`, game.id);
  }
  res.json({ status: 'rejected' });
});

// Dry-runs the same check applyMoveToGame does, without writing anything —
// the client's "confirm moves" setting uses this to show a move as valid
// (a placeable marker) or invalid (an immediate error) before the player
// actually commits it. This is the only way to include checks a client
// can't run on its own, like superko, which needs the full position
// history rather than just the current board.
app.post('/api/games/:id/moves/validate', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const visionAuthorized = isValidVisionToken(req, game.id);
  const user = visionAuthorized ? null : requireAuth(req, res);
  if (!visionAuthorized && !user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    fail(res, 400, 'Game is not in progress');
    return;
  }
  if (game.pending_undo_by) {
    fail(res, 400, 'An undo request is pending confirmation');
    return;
  }

  const { x, y, color } = req.body ?? {};
  if (typeof x !== 'number' || typeof y !== 'number' || (color !== 'black' && color !== 'white')) {
    fail(res, 400, 'Invalid move payload');
    return;
  }
  if (!visionAuthorized && !canActAsColor(game, user!.id, color)) {
    fail(res, 403, 'You are not playing as %@ in this game', [color]);
    return;
  }

  const board = getCurrentBoard(game.id, game.size);
  const history = getGameHistory(game.id, game.size, game.handicap);
  const moveNumber = getNextMoveNumber(game.id);
  const validation = validateMove(board, { x, y }, color, turnMoveNumber(moveNumber, game.handicap), history);

  res.json(validation.valid ? { valid: true } : { valid: false, error: validation.error });
});

app.post('/api/games/:id/moves', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const visionAuthorized = isValidVisionToken(req, game.id);
  const user = visionAuthorized ? null : requireAuth(req, res);
  if (!visionAuthorized && !user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    fail(res, 400, 'Game is not in progress');
    return;
  }
  if (game.pending_undo_by) {
    fail(res, 400, 'An undo request is pending confirmation');
    return;
  }

  const { x, y, color } = req.body ?? {};
  if (typeof x !== 'number' || typeof y !== 'number' || (color !== 'black' && color !== 'white')) {
    fail(res, 400, 'Invalid move payload');
    return;
  }
  if (!visionAuthorized && !canActAsColor(game, user!.id, color)) {
    fail(res, 403, 'You are not playing as %@ in this game', [color]);
    return;
  }

  const applied = applyMoveToGame(game, x, y, color);
  if (!applied.ok) {
    // shared's own refusals ("Point is already occupied", ...) are plain
    // English sentences with no values in them, so they are already the
    // key a client looks up.
    fail(res, 400, applied.error ?? 'Invalid move');
    return;
  }

  res.json(applied.result);

  maybeTriggerAiMove(game.id);
});

app.post('/api/games/:id/pass', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    fail(res, 400, 'Game is not in progress');
    return;
  }
  if (game.pending_undo_by) {
    fail(res, 400, 'An undo request is pending confirmation');
    return;
  }

  const { color } = req.body ?? {};
  if (color !== 'black' && color !== 'white') {
    fail(res, 400, 'Invalid color');
    return;
  }
  if (!canActAsColor(game, user.id, color)) {
    fail(res, 403, 'You are not playing as %@ in this game', [color]);
    return;
  }

  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  if (color !== currentColor) {
    fail(res, 400, 'It is %@\'s turn', [currentColor]);
    return;
  }

  const applied = applyPassToGame(game, color);

  res.json({
    status: applied.status,
    result: null,
    nextColor: applied.nextColor,
  });

  if (applied.status === 'in_progress') {
    maybeTriggerAiMove(game.id);
  }
});

// Validates an arbitrary request body value as a Point[] on this game's
// board — anything malformed or out of bounds is silently dropped rather
// than rejecting the whole request, same tolerance finalize-scoring already
// had for deadPoints before this was pulled out to also validate sekiPoints.
function parsePointArray(value: unknown, size: number): Point[] {
  const raw: unknown[] = Array.isArray(value) ? value : [];
  return raw
    .map((p: unknown) => (p && typeof p === 'object' ? (p as { x: unknown; y: unknown }) : null))
    .filter((p: { x: unknown; y: unknown } | null): p is { x: unknown; y: unknown } => p !== null)
    .map((p: { x: unknown; y: unknown }) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter(
      (p: Point) => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < size && p.y >= 0 && p.y < size,
    );
}

app.post('/api/games/:id/finalize-scoring', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can finalize scoring');
    return;
  }

  if (game.status !== 'scoring') {
    fail(res, 400, 'Game is not in the scoring phase');
    return;
  }
  if (game.pending_undo_by) {
    fail(res, 400, 'An undo request is pending confirmation');
    return;
  }

  const deadPoints = parsePointArray(req.body?.deadPoints, game.size);
  // A group a player has directly declared to be in seki (a separate
  // scoring action from marking it dead) — these stay on the board, not
  // removed, but score nothing for either side. See scoreBoard/
  // findDeclaredSekiRegions in shared for how marking one side is enough.
  const sekiPoints = parsePointArray(req.body?.sekiPoints, game.size);

  const board = getCurrentBoard(game.id, game.size);
  const { board: effectiveBoard, captures: adjustedCaptures } = applyDeadStones(
    board,
    getCumulativeCaptures(game.id),
    deadPoints,
  );

  const score = scoreBoard(effectiveBoard, adjustedCaptures, resolveKomi(game), sekiPoints);
  const winnerLabel = score.winner === 'black' ? 'Black' : 'White';
  // No komi means every count involved is a whole number — showing a
  // trailing ".0" there would be noise rather than precision.
  const marginLabel = Number.isInteger(score.margin) ? String(score.margin) : score.margin.toFixed(1);
  const gameResult = `${winnerLabel} wins by ${marginLabel} (B: ${score.black}, W: ${score.white})`;

  const now = Date.now();
  db.prepare('UPDATE games SET status = ?, result = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', gameResult, 'scoring', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ status: 'finished', result: gameResult, captures: adjustedCaptures });
});

// Lets a mismarked scoring result be redone: reopens a game that finished
// via the scoring phase back into 'scoring', with the board and move
// history untouched, so dead stones can be re-marked and finalized again.
// Not offered for games that ended by resignation or timeout — there's no
// scoring to redo. Negotiates the same way undo does: immediate for a
// local/AI game, request-then-confirm between two different players.
app.post('/api/games/:id/reopen-scoring', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can reopen scoring');
    return;
  }
  if (game.status !== 'finished' || game.end_reason !== 'scoring') {
    fail(res, 400, 'Only a game finished by scoring can be reopened');
    return;
  }
  if (game.pending_undo_by) {
    fail(res, 400, 'An undo request is pending confirmation');
    return;
  }

  const isImmediate = game.black_user_id === game.white_user_id || isAiOpponentGame(game);
  const myColor: Color = game.black_user_id === user.id ? 'black' : 'white';

  if (!isImmediate) {
    if (!game.pending_reopen_by) {
      db.prepare('UPDATE games SET pending_reopen_by = ? WHERE id = ?').run(myColor, game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'requested', pendingReopenBy: myColor });
      return;
    }
    if (game.pending_reopen_by === myColor) {
      db.prepare('UPDATE games SET pending_reopen_by = NULL WHERE id = ?').run(game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'cancelled', pendingReopenBy: null });
      return;
    }
    // Otherwise myColor is the other player, confirming — fall through and reopen.
  }

  const now = Date.now();
  db.prepare('UPDATE games SET status = ?, result = NULL, end_reason = NULL, pending_reopen_by = NULL, updated_at = ? WHERE id = ?')
    .run('scoring', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ action: 'confirmed', status: 'scoring', result: null, pendingReopenBy: null });
});

// A single endpoint drives the whole undo negotiation: in a local game (one
// account playing both colors) or an AI game (there's no second human to
// ask) it undoes immediately, same as before. In a remote game between two
// different accounts, the first call files a request and the *other*
// player must call this same endpoint to confirm it — calling it again as
// the original requester cancels the request instead.
app.post('/api/games/:id/undo', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can undo moves');
    return;
  }

  // Undo is otherwise allowed regardless of status (e.g. undoing a
  // resignation), so only block it here if the clock just now — as of this
  // very check — ran out and ended the game; a pre-existing finished/scoring
  // status should fall through exactly as before.
  const statusBeforeTimeoutCheck = game.status;
  game = withTimeoutCheck(game);
  if (statusBeforeTimeoutCheck === 'in_progress' && game.status === 'finished') {
    fail(res, 400, 'Game is not in progress');
    return;
  }
  if (game.pending_reopen_by) {
    fail(res, 400, 'A redo-scoring request is pending confirmation');
    return;
  }

  const lastEvent = db.prepare(`
    SELECT move_number, event_type, payload FROM events WHERE game_id = ?
    ORDER BY move_number DESC LIMIT 1
  `).get(game.id) as { move_number: number; event_type: string; payload: string } | undefined;

  // move_number 0 is the handicap setup, not a player action — nothing to undo past it.
  if (!lastEvent || lastEvent.event_type === 'HANDICAP') {
    fail(res, 400, 'Nothing to undo');
    return;
  }

  const isImmediate = game.black_user_id === game.white_user_id || isAiOpponentGame(game);
  const myColor: Color = game.black_user_id === user.id ? 'black' : 'white';

  if (!isImmediate) {
    if (!game.pending_undo_by) {
      db.prepare('UPDATE games SET pending_undo_by = ? WHERE id = ?').run(myColor, game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'requested', pendingUndoBy: myColor });
      return;
    }
    if (game.pending_undo_by === myColor) {
      db.prepare('UPDATE games SET pending_undo_by = NULL WHERE id = ?').run(game.id);
      broadcastGameUpdate(game.id);
      res.json({ action: 'cancelled', pendingUndoBy: null });
      return;
    }
    // Otherwise myColor is the other player, confirming — fall through and perform the undo.
  }

  const now = Date.now();
  const moveNumbersToDelete = [lastEvent.move_number];

  // If GNU Go already answered the human's move before Undo was clicked —
  // a real race, since maybeTriggerAiMove fires immediately after every
  // move — a plain "undo the last event" would only remove GNU Go's reply
  // and leave the human's own move in place. Undo both together instead,
  // landing back at the human's own turn, which is what they actually
  // wanted to reconsider.
  if (isAiOpponentGame(game) && lastEvent.event_type === 'MOVE') {
    const aiId = getAiUserId();
    const aiColor: Color = game.black_user_id === aiId ? 'black' : 'white';
    const lastColor = (JSON.parse(lastEvent.payload) as { color?: Color }).color;

    if (lastColor === aiColor) {
      const precedingEvent = db.prepare(`
        SELECT event_type FROM events WHERE game_id = ? AND move_number = ?
      `).get(game.id, lastEvent.move_number - 1) as { event_type: string } | undefined;

      // Don't reach past the human's very first move into the handicap setup.
      if (precedingEvent && precedingEvent.event_type !== 'HANDICAP') {
        moveNumbersToDelete.push(lastEvent.move_number - 1);
      }
    }
  }

  for (const moveNumber of moveNumbersToDelete) {
    db.prepare('DELETE FROM events WHERE game_id = ? AND move_number = ?').run(game.id, moveNumber);
    db.prepare('DELETE FROM snapshots WHERE game_id = ? AND move_number = ?').run(game.id, moveNumber);
  }
  // Whoever's turn it now is gets a freshly-started clock reading from this
  // moment — there's no historical timing to restore for an undone move.
  db.prepare('UPDATE games SET status = ?, result = ?, pending_undo_by = NULL, updated_at = ?, turn_started_at = ? WHERE id = ?')
    .run('in_progress', null, now, now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  const board = getCurrentBoard(game.id, game.size);
  const nextMoveNumber = getNextMoveNumber(game.id);

  res.json({
    action: 'confirmed',
    board,
    status: 'in_progress',
    result: null,
    currentColor: getCurrentColor(turnMoveNumber(nextMoveNumber, game.handicap)),
    captures: getCumulativeCaptures(game.id),
    pendingUndoBy: null,
  });

  // If what got undone was the AI's own move, it's the AI's turn again —
  // nothing else would prompt it to move, so ask it to reconsider now.
  maybeTriggerAiMove(game.id);
});

app.post('/api/games/:id/resign', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status !== 'in_progress') {
    fail(res, 400, 'Game is not in progress');
    return;
  }
  if (game.pending_undo_by) {
    fail(res, 400, 'An undo request is pending confirmation');
    return;
  }

  const { color } = req.body ?? {};
  if (color !== 'black' && color !== 'white') {
    fail(res, 400, 'Invalid color');
    return;
  }
  if (!canActAsColor(game, user.id, color)) {
    fail(res, 403, 'You are not playing as %@ in this game', [color]);
    return;
  }

  const gameResult = applyResignToGame(game, color);

  res.json({ status: 'finished', result: gameResult });
});

// Re-fires maybeTriggerAiMove for a game already waiting on GNU Go — for
// when a human suspects it's genuinely stuck rather than just thinking, most
// plausibly because a server restart (e.g. a deploy) killed the gnugo
// process mid-search without ever getting a chance to retry: nothing else
// re-triggers it, since the trigger points are all human actions (move,
// pass, resign, create) that already happened. maybeTriggerAiMove's own
// re-check of whose turn it is after computing a move makes this safe to
// call even if a first attempt is still genuinely in flight — the queue in
// gnugo.ts serializes them, and whichever finishes second will see the
// turn's already moved on and simply do nothing.
app.post('/api/games/:id/recompute-ai-move', (req, res) => {
  const game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }
  if (!isParticipant(game, user.id)) {
    fail(res, 403, 'Only players in this game can do this');
    return;
  }
  if (game.status !== 'in_progress') {
    fail(res, 400, 'Game is not in progress');
    return;
  }

  const aiId = getAiUserId();
  const moveNumber = getNextMoveNumber(game.id);
  const currentColor = getCurrentColor(turnMoveNumber(moveNumber, game.handicap));
  const colorUserId = currentColor === 'black' ? game.black_user_id : game.white_user_id;
  if (colorUserId !== aiId) {
    fail(res, 400, "It isn't GNU Go's turn");
    return;
  }

  // Thinking again, as far as the player is concerned — so the board
  // stops saying it gave up before the attempt has even been made.
  clearAiStalled(game.id);
  maybeTriggerAiMove(game.id);
  res.status(202).json({ status: 'recomputing' });
});

// Immediately finishes a local game with no formal result — only makes
// sense for a game the caller plays entirely alone (black_user_id and
// white_user_id both their own id), since anyone else in the game would
// have no say in ending it this way.
app.post('/api/games/:id/end', (req, res) => {
  let game = getGameRow(req.params.id);
  if (!game) {
    fail(res, 404, 'Game not found');
    return;
  }

  const user = requireAuth(req, res);
  if (!user) {
    return;
  }

  game = withTimeoutCheck(game);
  if (game.status === 'finished') {
    fail(res, 400, 'Game is already finished');
    return;
  }
  if (game.black_user_id !== user.id || game.white_user_id !== user.id) {
    fail(res, 403, 'Only a local game can be ended this way');
    return;
  }

  const now = Date.now();
  db.prepare('UPDATE games SET status = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run('finished', 'ended', now, game.id);

  broadcastGameUpdate(game.id);
  broadcastGamesListUpdate();

  res.json({ status: 'finished', result: null });
});

// For React Router — serve index.html for all non-API routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../client/dist/index.html'));
});

const httpServer = createServer(app);
attachWebSocketServer(httpServer);

const TIMEOUT_SWEEP_INTERVAL_MS = 10_000;
setInterval(sweepTimeouts, TIMEOUT_SWEEP_INTERVAL_MS);

httpServer.listen(port, () => {
  console.log(`Server running on port ${port}; db path: ${dbPath}`);
});

// Optional — only starts when HTTPS_PORT/KEY_PATH/CERT_PATH are all set and
// the cert files actually exist, so local dev without certs isn't affected.
if (httpsAvailable) {
  const httpsServer = createHttpsServer(
    { key: fs.readFileSync(keyPath!), cert: fs.readFileSync(certPath!) },
    app,
  );
  attachWebSocketServer(httpsServer);
  httpsServer.listen(Number(httpsPort), () => {
    console.log(`HTTPS server running on port ${httpsPort}`);
  });
} else if (httpsPort && keyPath && certPath) {
  console.warn(`KEY_PATH/CERT_PATH set but not found at ${keyPath} / ${certPath} — skipping HTTPS server.`);
}
