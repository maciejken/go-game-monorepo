import Foundation

// Holds the logged-in user (if any), driving RootView's choice between the
// auth screen and the game list. Session state itself lives in the go_session
// cookie (see APIClient) — this just mirrors "is there currently a valid one"
// for the UI, checked once at launch via GET /api/auth/me.
@Observable
final class SessionStore {
    var currentUser: AuthUser?
    var isCheckingSession = true
    var errorMessage: String?
    // True when the app is running on a remembered session because the
    // server could not be reached: offline games work, server ones are
    // missing until it comes back.
    var isOffline = false
    // Chosen, not fallen into: someone with no account (or who signed out)
    // asking to play on this device alone. Games saved here are reachable
    // either way, and nothing about them needs a server.
    var isPlayingOffline = false
    // What the server offers, as of the last time it answered. Assumed
    // until then, so nothing flickers away on a slow launch.
    var features = ServerFeatures()
    // A recovery code waiting to be shown — from registering, from
    // recovering an account, or from asking for a new one. Held here
    // rather than by whichever screen produced it, because registering
    // replaces that screen with the game list a moment later.
    var recoveryCodeToShow: String?

    // Who was signed in last, kept on the device so an unreachable server
    // doesn't strand someone on the login screen with offline games they
    // can't get to. It is not a credential — the session cookie still is,
    // and anything the server answers overrides this.
    private static let rememberedUserKey = "go-remembered-user"

    private var rememberedUser: AuthUser? {
        get {
            guard let data = UserDefaults.standard.data(forKey: Self.rememberedUserKey) else { return nil }
            return try? JSONDecoder().decode(AuthUser.self, from: data)
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: Self.rememberedUserKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.rememberedUserKey)
            }
        }
    }

    func checkSession() async {
        isCheckingSession = true
        do {
            // withRetry only retries a thrown error (a failed request) — a
            // clean response of "no user" is never retried, since that's a
            // genuine "not logged in", not a hiccup.
            let (user, features) = try await APIClient.withRetry { try await APIClient.me() }
            currentUser = user
            self.features = features
            // The server has spoken either way: remember a real session,
            // and forget a stale one rather than letting it linger.
            rememberedUser = user
            isOffline = false
        } catch {
            // Unreachable, which is not the same as signed out: carry on as
            // whoever was here last so offline games stay reachable.
            currentUser = rememberedUser
            isOffline = currentUser != nil
        }
        isCheckingSession = false
        if currentUser != nil, !isOffline {
            PushNotifications.requestAuthorizationAndRegister()
        }
    }

    func register(username: String, password: String) async {
        errorMessage = nil
        do {
            let (user, recoveryCode) = try await APIClient.register(username: username, password: password)
            currentUser = user
            rememberedUser = user
            // Shown once, wherever the app happens to be when it arrives.
            recoveryCodeToShow = recoveryCode
            isOffline = false
            isPlayingOffline = false
            PushNotifications.requestAuthorizationAndRegister()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(username: String, password: String) async {
        errorMessage = nil
        do {
            currentUser = try await APIClient.login(username: username, password: password)
            rememberedUser = currentUser
            isOffline = false
            isPlayingOffline = false
            PushNotifications.requestAuthorizationAndRegister()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func playOffline() {
        isPlayingOffline = true
    }

    func logout() async {
        try? await APIClient.logout()
        currentUser = nil
        rememberedUser = nil
        isOffline = false
        isPlayingOffline = false
    }
}
