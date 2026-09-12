import Foundation

// Signal-only live updates — a direct async port of
// client/src/hooks/useLiveSocket.ts: the server sends a message whenever
// something changed, and this never decodes it, it just triggers onMessage
// to refetch via the normal REST endpoints (which do the per-session
// permission shaping a broadcast can't). Reconnects automatically on drop.
// Meant to be driven by a SwiftUI `.task`, whose automatic cancel-on-
// disappear replaces the JS hook's useEffect cleanup.
enum LiveSocket {
    private static let reconnectDelayNanoseconds: UInt64 = 2_000_000_000

    private static func wsURL(_ path: String) -> URL {
        var components = URLComponents(url: Config.baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = path
        return components.url!
    }

    static func listen(path: String, onMessage: @escaping () async -> Void) async {
        while !Task.isCancelled {
            let task = URLSession.shared.webSocketTask(with: wsURL(path))
            task.resume()
            // A fresh connection may be replacing one that died while
            // suspended (e.g. backgrounded for a push notification) —
            // whatever broadcast would have arrived in the meantime is
            // simply gone, the server doesn't replay missed messages. Since
            // there is no way to tell whether something was missed,
            // refetching on every (re)connect, not just on an actual
            // message, is the only way to guarantee the view can't be left
            // stale indefinitely (it would otherwise sit unchanged until
            // the next unrelated live update happened to arrive).
            await onMessage()
            while !Task.isCancelled {
                do {
                    _ = try await task.receive()
                    await onMessage()
                } catch {
                    break
                }
            }
            task.cancel(with: .goingAway, reason: nil)
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: reconnectDelayNanoseconds)
        }
    }
}
