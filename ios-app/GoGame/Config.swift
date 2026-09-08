import Foundation

enum Config {
    // The Pi backend, exposed publicly over real HTTPS — a plain-HTTP
    // address won't work here even for local testing: URLSession silently
    // refuses to store a `Secure`-flagged cookie (see auth.ts's
    // setSessionCookie) unless the connection is actually TLS, so login
    // wouldn't persist across requests. See ios-app/README.md.
    static let baseURL = URL(string: "https://igo5.online")!
}
