import SwiftUI

// A user's public profile by id — used both for the Account tab's own
// (self) profile and for a /profile/<id> universal link to someone else's.
struct ProfileView: View {
    let userId: String
    @State private var profile: UserProfile?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let profile {
                List {
                    Section {
                        LabeledContent("Username", value: profile.username)
                        LabeledContent("Joined", value: joinedDateText(profile.createdAt))
                    }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Profile")
        .task(id: userId) { await load() }
        .alert(
            "Error",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func load() async {
        do {
            profile = try await APIClient.getUser(id: userId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func joinedDateText(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: Double(epochMs) / 1000)
            .formatted(date: .long, time: .omitted)
    }
}
