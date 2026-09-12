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
        do {
            currentUser = try await APIClient.me()
        } catch {
            // A thrown error here means the request itself failed (timeout,
            // no connectivity) — genuinely distinct from APIClient.me()
            // succeeding with a nil user (no session cookie). Worth
            // retrying once after a brief pause rather than immediately
            // treating a cold-launch network hiccup (e.g. opening the app
            // from a notification right as the device's radio wakes up)
            // the same as "not logged in", which would force a real
            // session right back to the login screen.
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            currentUser = try? await APIClient.me()
        }
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
