export const dbPath = process.env.DB_PATH || './data/go.db';
export const port = process.env.PORT || 3000;
export const defaultUsername = process.env.DEFAULT_USERNAME;
export const defaultPassword = process.env.DEFAULT_USER_PASSWORD;
// Who gets told when somebody files a report. Optional: unset, reports
// are still recorded, they just wait to be read rather than announcing
// themselves. A username rather than an id so it can be set by hand.
export const adminUsername = process.env.ADMIN_USERNAME;
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

// Times every GNU Go move and keeps the numbers, for the per-game report.
// Off unless asked for: the measuring is free, but a row per AI move on a
// server nobody is watching is a table that only grows.
export const gnugoDebugPerformance = process.env.GNUGO_DEBUG_PERFORMANCE === 'true';

export const apnsKeyPath = process.env.APNS_KEY_PATH;
export const apnsKeyId = process.env.APNS_KEY_ID;
export const apnsTeamId = process.env.APNS_TEAM_ID;
export const apnsBundleId = process.env.APNS_BUNDLE_ID;
export const apnsHost = process.env.APNS_HOST;

// How many accounts one address may create per hour. The default is the
// number a household might plausibly need; it exists as a setting because
// the rule checkers register a dozen accounts per run and have to be
// runnable twice in an hour (scripts/check-server-rules.sh raises it).
export const registerLimit = Number(process.env.REGISTER_RATE_LIMIT) || 10;

// Which of the two apple-app-site-association files this server publishes
// — 'test' names the test app, anything else names the production one.
// Unset, the choice falls to the Host header, which is right while one
// machine answers on both igo5.online and test.igo5.online. A server
// behind a proxy can't rely on that header surviving the hop, so it says
// outright which app it is associated with.
export const aasaApp = process.env.AASA_APP;
