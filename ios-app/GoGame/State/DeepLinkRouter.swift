import Foundation

// Parses incoming Universal Links (https://igo5.online/games/<id>, or a
// plain https://igo5.online for the list) into a pending game id GameListView
// can act on. A separate @Observable object rather than routing logic
// inline in .onOpenURL, since the link can arrive before GameListView even
// exists yet (cold launch, while SessionStore is still checking the
// session, or the user isn't logged in) — this just holds the target until
// whichever view is ready to consume it.
@Observable
final class DeepLinkRouter {
    var targetGameId: String?

    // https://igo5.online alone (the games list) needs no further routing —
    // that's already the app's default screen. Only /games/<id> resolves to
    // something to navigate to.
    func handle(_ url: URL) {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0] == "games" else { return }
        targetGameId = parts[1]
    }
}
