import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import http2 from 'http2';

import { apnsBundleId, apnsHost, apnsKeyId, apnsKeyPath, apnsTeamId } from './config.js';

export function isApnsConfigured(): boolean {
  return Boolean(apnsHost && apnsKeyPath && apnsKeyId && apnsTeamId && apnsBundleId);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Apple's own guidance: sign one provider token and reuse it for up to an
// hour rather than minting a fresh one per push — this caches it for 55
// minutes to stay safely inside that window.
let cachedToken: { jwt: string; issuedAt: number } | null = null;
const TOKEN_TTL_MS = 55 * 60 * 1000;

function getProviderToken(): string {
  if (cachedToken && Date.now() - cachedToken.issuedAt < TOKEN_TTL_MS) {
    return cachedToken.jwt;
  }

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: apnsKeyId }));
  const claims = base64url(JSON.stringify({ iss: apnsTeamId, iat: Math.floor(Date.now() / 1000) }));
  const signingInput = `${header}.${claims}`;
  const privateKey = readFileSync(apnsKeyPath!, 'utf8');
  // APNs auth keys are ES256 (P-256 ECDSA) — dsaEncoding 'ieee-p1363' gives
  // the raw r||s signature format JWTs expect, instead of Node's DER default.
  const signature = createSign('sha256').update(signingInput).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });

  const jwt = `${signingInput}.${base64url(signature)}`;
  cachedToken = { jwt, issuedAt: Date.now() };
  return jwt;
}

// Fire-and-forget: a push is a nice-to-have nudge, not something any caller
// is waiting on, so failures are logged and swallowed rather than thrown.
// No-ops entirely (also without logging) until isApnsConfigured() is true —
// see config.ts for what that requires.
export function sendPushNotification(deviceToken: string, alert: string): void {
  if (!isApnsConfigured()) {
    return;
  }

  const client = http2.connect(apnsHost!);
  client.on('error', (err) => console.error('APNs connection error:', err.message));

  const req = client.request({
    ':method': 'POST',
    ':path': `/3/device/${deviceToken}`,
    authorization: `bearer ${getProviderToken()}`,
    'apns-topic': apnsBundleId,
    'apns-push-type': 'alert',
  });

  let status: number | undefined;
  req.on('response', (headers) => {
    status = Number(headers[':status']);
  });

  req.setEncoding('utf8');
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (status !== 200) {
      console.error(`APNs push failed (status ${status}):`, body);
    }
    client.close();
  });
  req.on('error', (err) => {
    console.error('APNs request error:', err.message);
    client.close();
  });

  req.end(JSON.stringify({ aps: { alert, sound: 'default' } }));
}
