import SwiftUI

// A user's public profile by id — used both for the Account tab's own
// (self) profile and for a /profile/<id> universal link to someone else's.
struct ProfileView: View {
    let userId: String
    @Environment(SessionStore.self) private var session
    @State private var profile: UserProfile?
    @State private var errorMessage: String?
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var passwordError: String?
    @State private var passwordChanged = false
    @State private var isChangingPassword = false
    @State private var acceptsInvitations = false
    @State private var acceptsInvitationsError: String?

    // Only ever relevant on your own profile — viewing someone else's has
    // no reason to expose a way to change their password.
    private var isOwnProfile: Bool {
        session.currentUser?.id == userId
    }

    var body: some View {
        Group {
            if let profile {
                List {
                    Section {
                        LabeledContent("Username", value: profile.username)
                        LabeledContent("Joined", value: joinedDateText(profile.createdAt))
                        LabeledContent("Games played", value: "\(profile.gamesPlayed)")
                        LabeledContent("Won", value: "\(profile.gamesWon)")
                        LabeledContent("Lost", value: "\(profile.gamesLost)")
                    }
                    if isOwnProfile {
                        // Optimistic — flips immediately, reverts with an
                        // error message if the request fails, rather than
                        // waiting on a round-trip for a single boolean.
                        Section {
                            Toggle(
                                "Accept invitations",
                                isOn: Binding(
                                    get: { acceptsInvitations },
                                    set: { newValue in
                                        acceptsInvitations = newValue
                                        acceptsInvitationsError = nil
                                        Task {
                                            do {
                                                try await APIClient.setAcceptsInvitations(newValue)
                                            } catch {
                                                acceptsInvitations = !newValue
                                                acceptsInvitationsError = error.localizedDescription
                                            }
                                        }
                                    }
                                )
                            )
                            if let acceptsInvitationsError {
                                Text(acceptsInvitationsError)
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                            }
                        }
                        Section("Favourite tag") {
                            FavouriteTagPicker(initial: profile.favouriteTag) { chosen in
                                self.profile = UserProfile(
                                    id: profile.id,
                                    username: profile.username,
                                    createdAt: profile.createdAt,
                                    acceptsInvitations: profile.acceptsInvitations,
                                    favouriteTag: chosen,
                                    gamesPlayed: profile.gamesPlayed,
                                    gamesWon: profile.gamesWon,
                                    gamesLost: profile.gamesLost
                                )
                                await session.checkSession()
                            }
                        }
                        Section {
                            NavigationLink {
                                QuickGamePresetView()
                            } label: {
                                Text("Quick game preset")
                            }
                        }
                        Section("Change password") {
                            SecureField("Current password", text: $currentPassword)
                                .textContentType(.password)
                            SecureField("New password", text: $newPassword)
                                .textContentType(.newPassword)
                            SecureField("Confirm new password", text: $confirmPassword)
                                .textContentType(.newPassword)
                            if let passwordError {
                                Text(passwordError)
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                            }
                            if passwordChanged {
                                Text("Password changed.")
                                    .font(.footnote)
                                    .foregroundStyle(.green)
                            }
                            Button("Change password") {
                                Task { await submitPasswordChange() }
                            }
                            .disabled(
                                isChangingPassword || currentPassword.isEmpty || newPassword.isEmpty
                                    || confirmPassword.isEmpty
                            )
                        }
                        Section {
                            Button("Log out", role: .destructive) {
                                Task { await session.logout() }
                            }
                        }
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
            profile = try await APIClient.withRetry { try await APIClient.getUser(id: userId) }
            acceptsInvitations = profile?.acceptsInvitations ?? false
        } catch {
            // Navigating back out of a still-loading profile cancels this
            // task, and the cancelled request would otherwise surface as an
            // "Error — cancelled" alert on the way out.
            guard !APIClient.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func submitPasswordChange() async {
        passwordError = nil
        passwordChanged = false
        guard newPassword == confirmPassword else {
            passwordError = "New passwords do not match"
            return
        }
        isChangingPassword = true
        defer { isChangingPassword = false }
        do {
            try await APIClient.changePassword(currentPassword: currentPassword, newPassword: newPassword)
            passwordChanged = true
            currentPassword = ""
            newPassword = ""
            confirmPassword = ""
        } catch {
            passwordError = error.localizedDescription
        }
    }

    private func joinedDateText(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: Double(epochMs) / 1000)
            .formatted(date: .long, time: .omitted)
    }
}

// The same chips-and-field shape as a game's Title & tags sheet, minus
// Share: a favourites marker is personal by definition, so there is only
// one thing the button could do.
private struct FavouriteTagPicker: View {
    let initial: String?
    let onChange: (String) async -> Void

    @State private var current: String?
    @State private var suggestions: [TagSuggestion] = []
    @State private var draft = ""
    @State private var isBusy = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Favourites are one of your own tags. Choose which tag marks them, then tag any game with it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(suggestions, id: \.tag) { suggestion in
                        Button {
                            Task { await choose(suggestion.tag) }
                        } label: {
                            chip(suggestion.tag, isCurrent: suggestion.tag.lowercased() == current)
                        }
                        .buttonStyle(.plain)
                        .disabled(isBusy)
                    }
                }
                .padding(.horizontal, 1)
            }
            HStack(spacing: 8) {
                TextField("Add a tag", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                    .onSubmit { Task { await choose(draft) } }
                Button {
                    Task { await choose(draft) }
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(isBusy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .onAppear { current = initial }
        .task { suggestions = (try? await APIClient.tagSuggestions()) ?? [] }
    }

    private func chip(_ tag: String, isCurrent: Bool) -> some View {
        HStack(spacing: 4) {
            Text(tag)
                .font(.subheadline)
                .lineLimit(1)
            Image(systemName: isCurrent ? "star.fill" : "plus")
                .font(.caption)
                .foregroundStyle(isCurrent ? Color.yellow : Color.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.08), in: Capsule())
    }

    private func choose(_ tag: String) async {
        let chosen = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !chosen.isEmpty, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await APIClient.setFavouriteTag(chosen)
            current = chosen.lowercased()
            draft = ""
            errorMessage = nil
            suggestions = (try? await APIClient.tagSuggestions()) ?? suggestions
            await onChange(chosen.lowercased())
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
