import Foundation

enum Config {
    // Which server this build talks to, from the API_HOST build setting
    // by way of Info.plist: test.igo5.online in Debug, igo5.online in
    // Release. The host alone rather than a whole URL, because a build
    // setting holding "//" is the classic way to write a comment by
    // accident in an xcconfig.
    //
    // It has to be https either way: URLSession silently refuses to store
    // a `Secure`-flagged cookie (see auth.ts's setSessionCookie) over a
    // plain connection, so login wouldn't persist across requests. See
    // ios-app/README.md.
    static let baseURL: URL = {
        let host = Bundle.main.object(forInfoDictionaryKey: "APIHost") as? String
        guard let host, !host.isEmpty, let url = URL(string: "https://\(host)") else {
            // A build with no host configured would otherwise fail at
            // every call with something unhelpful.
            fatalError("APIHost is missing from Info.plist — check the API_HOST build setting")
        }
        return url
    }()
}
