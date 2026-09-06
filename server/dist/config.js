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
export const apnsKeyPath = process.env.APNS_KEY_PATH;
export const apnsKeyId = process.env.APNS_KEY_ID;
export const apnsTeamId = process.env.APNS_TEAM_ID;
export const apnsBundleId = process.env.APNS_BUNDLE_ID;
export const apnsHost = process.env.APNS_HOST;
