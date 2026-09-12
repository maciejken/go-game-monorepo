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

    func checkSession() async {
        isCheckingSession = true
        // withRetry only retries a thrown error (a failed request) — a
        // clean response of "no user" is never retried, since that's a
        // genuine "not logged in", not a hiccup.
        currentUser = try? await APIClient.withRetry { try await APIClient.me() }
        isCheckingSession = false
        if currentUser != nil {
            PushNotifications.requestAuthorizationAndRegister()
        }
    }

    func register(username: String, password: String) async {
        errorMessage = nil
        do {
            currentUser = try await APIClient.register(username: username, password: password)
            PushNotifications.requestAuthorizationAndRegister()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(username: String, password: String) async {
        errorMessage = nil
        do {
            currentUser = try await APIClient.login(username: username, password: password)
            PushNotifications.requestAuthorizationAndRegister()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() async {
        try? await APIClient.logout()
        currentUser = nil
    }
}
