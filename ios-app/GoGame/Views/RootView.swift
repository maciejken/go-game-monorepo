import SwiftUI

struct RootView: View {
    @State private var session = SessionStore()

    var body: some View {
        Group {
            if session.isCheckingSession {
                ProgressView()
            } else if session.currentUser != nil {
                GameListView()
            } else {
                AuthView()
            }
        }
        .environment(session)
        .task {
            await session.checkSession()
        }
    }
}
