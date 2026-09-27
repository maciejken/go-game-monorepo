export const dbPath = process.env.DB_PATH || './data/go.db';
export const port = process.env.PORT || 3000;
export const defaultUsername = process.env.DEFAULT_USERNAME;
export const defaultPassword = process.env.DEFAULT_USER_PASSWORD;
export const httpsPort = process.env.HTTPS_PORT;
export const keyPath = process.env.KEY_PATH;
export const certPath = process.env.CERT_PATH;
// APNs push notifications ("it's your turn"): all four must be set for
// pushes to actually send (see apns.ts's isApnsConfigured) — until then,
// device tokens are still accepted and stored, sending just no-ops. The
// auth key (.p8) requires a paid Apple Developer Program membership to
// generate, so this is expected to stay unset until that's in place.
// Whether something else terminates TLS in front of this process — a
// proxy, a tunnel, a CDN. It changes two things that must change
// together: req.secure starts following X-Forwarded-Proto (so the
// redirect below stops bouncing a request the proxy already served over
// HTTPS), and req.ip starts naming the client rather than the proxy (so
// rate limits count per person instead of throttling everybody at once).
// Off where this process is the edge server, as it is on the Pi.
export const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
// Games against GNU Go, on or off for this server. Off unless asked for:
// a host that has the binary and wants to spawn a process per move says
// GNUGO_ENABLED=true, and everywhere else — including a machine that
// happens to have gnugo installed for other reasons — the clients simply
// don't offer the mode.
export const gnugoEnabled = process.env.GNUGO_ENABLED === 'true';
export const apnsKeyPath = process.env.APNS_KEY_PATH;
export const apnsKeyId = process.env.APNS_KEY_ID;
export const apnsTeamId = process.env.APNS_TEAM_ID;
export const apnsBundleId = process.env.APNS_BUNDLE_ID;
export const apnsHost = process.env.APNS_HOST;
