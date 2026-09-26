import SwiftUI

struct RootView: View {
    @State private var session = SessionStore()

    var body: some View {
        Group {
            if session.isCheckingSession {
                ProgressView()
            } else if session.currentUser != nil || session.isPlayingOffline {
                MainTabView()
            } else {
                AuthView()
            }
        }
        .environment(session)
        // Wherever a code comes from — registering, recovering, or asking
        // for a new one — it is shown here, once.
        .sheet(
            isPresented: Binding(
                get: { session.recoveryCodeToShow != nil },
                set: { if !$0 { session.recoveryCodeToShow = nil } }
            )
        ) {
            RecoveryCodeSheet(code: session.recoveryCodeToShow ?? "")
                .presentationDetents([.height(340)])
        }
        .task {
            await session.checkSession()
        }
    }
}
