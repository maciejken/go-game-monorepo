import SwiftUI

// A user's public profile by id — used both for the Account tab's own
// (self) profile and for a /profile/<id> universal link to someone else's.
struct ProfileView: View {
    let userId: String
    @Environment(SessionStore.self) private var session
    @State private var profile: UserProfile?
    @State private var errorMessage: String?
    @State private var passwordChanged = false
    @State private var acceptsInvitations = false
    @State private var acceptsInvitationsError: String?
    @State private var recoveryPassword = ""
    @FocusState private var recoveryFieldFocused: Bool
    @State private var recoveryError: String?
    @State private var isRequestingRecoveryCode = false
    @State private var showDeleteAccount = false
    @State private var deletePassword = ""
    @FocusState private var deleteFieldFocused: Bool
    @State private var deleteError: String?
    @State private var isDeletingAccount = false

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
                                session.favouriteTagChanged(to: chosen)
                            }
                        }
                        Section {
                            NavigationLink {
                                QuickGamePresetView()
                            } label: {
                                Text("Quick game preset")
                            }
                        }
                        Section {
                            NavigationLink {
                                ChangePasswordView(username: profile.username) {
                                    passwordChanged = true
                                }
                            } label: {
                                Text("Change password")
                            }
                        } footer: {
                            if passwordChanged {
                                Text("Password changed.")
                                    .foregroundStyle(.green)
                            }
                        }
                        Section {
                            SecureField("Current password", text: $recoveryPassword)
                                .textContentType(.password)
                                .focused($recoveryFieldFocused)
                                .toolbar {
                                    ToolbarItemGroup(placement: .keyboard) {
                                        Spacer()
                                        Button("Done") { recoveryFieldFocused = false }
                                    }
                                }
                            if let recoveryError {
                                Text(recoveryError)
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                            }
                            Button("Get a new recovery code") {
                                Task { await requestRecoveryCode() }
                            }
                            .disabled(isRequestingRecoveryCode || recoveryPassword.isEmpty)
                        } header: {
                            Text("Recovery code")
                        } footer: {
                            Text("A code that sets a new password when you've forgotten yours. A new one replaces the last.")
                        }
                        Section {
                            Button("Log out", role: .destructive) {
                                Task { await session.logout() }
                            }
                        }
                        // Last on the screen, behind a confirmation and
                        // the password, and honest about what survives:
                        // games played against other people are their
                        // games too and stay, with nothing on them that
                        // says who this was.
                        Section {
                            Button("Delete account", role: .destructive) {
                                showDeleteAccount = true
                            }
                        } footer: {
                            Text("Deletes your account and the games you played alone. Games against other players stay with them, without your name.")
                        }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Profile")
        .task(id: userId) { await load() }
        // Said, then gone: a confirmation that stays until the screen is
        // closed stops being about what just happened.
        .task(id: passwordChanged) {
            guard passwordChanged else { return }
            try? await Task.sleep(for: .seconds(4))
            passwordChanged = false
        }
        .sheet(isPresented: $showDeleteAccount) {
            deleteAccountSheet
                .presentationDetents([.height(320)])
        }
        .alert(
            "Error",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    // Typing the password again is the confirmation: a "sure?" button is
    // easy to press by accident, and the server asks for it regardless.
    private var deleteAccountSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Delete account")
                .font(.headline)
            Text("This cannot be undone. Your account and the games you played alone are deleted; games against other players stay with them, without your name.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            SecureField("Current password", text: $deletePassword)
                .textContentType(.password)
                .textFieldStyle(.roundedBorder)
                .focused($deleteFieldFocused)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { deleteFieldFocused = false }
                    }
                }
            if let deleteError {
                Text(deleteError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button(role: .destructive) {
                Task { await deleteAccount() }
            } label: {
                Text("Delete account").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .disabled(isDeletingAccount || deletePassword.isEmpty)
            Spacer(minLength: 0)
        }
        .padding()
    }

    private func requestRecoveryCode() async {
        guard !isRequestingRecoveryCode else { return }
        isRequestingRecoveryCode = true
        defer { isRequestingRecoveryCode = false }
        do {
            let code = try await APIClient.newRecoveryCode(password: recoveryPassword)
            recoveryPassword = ""
            recoveryError = nil
            session.recoveryCodeToShow = code
        } catch {
            recoveryError = error.localizedDescription
        }
    }

    private func deleteAccount() async {
        guard !isDeletingAccount else { return }
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        do {
            try await APIClient.deleteAccount(password: deletePassword)
            deletePassword = ""
            showDeleteAccount = false
            // The session went with the account; this just catches the app
            // up with that.
            await session.logout()
        } catch {
            deleteError = error.localizedDescription
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

    private func joinedDateText(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: Double(epochMs) / 1000)
            .formatted(date: .long, time: .omitted)
    }
}

// The same chips-and-field shape as a game's Title & tags sheet, minus
// Share: a favourites marker is personal by definition, so there is only
// one thing the button could do. Everything below the explanation is the
// same TagPicker the new-game form and a game's own Title & tags sheet
// use — this screen had its own copy of it, which is how it ended up
// with a button the other two had already had fixed.
private struct FavouriteTagPicker: View {
    let initial: String?
    let onChange: (String) async -> Void

    @State private var current: String?
    @State private var errorMessage: String?
    @State private var isBusy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Favourites are one of your own tags. Choose which tag marks them, then tag any game with it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            // Nothing is excluded from the list: the one already chosen
            // is in it, wearing a star instead of a plus.
            TagPicker(selected: [], marked: current, isBusy: isBusy) { tag, _ in
                await choose(tag)
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .onAppear { current = initial }
    }

    private func choose(_ tag: String) async -> Bool {
        let chosen = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !chosen.isEmpty, !isBusy else { return false }
        isBusy = true
        defer { isBusy = false }
        do {
            try await APIClient.setFavouriteTag(chosen)
            current = chosen.lowercased()
            errorMessage = nil
            await onChange(chosen.lowercased())
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
