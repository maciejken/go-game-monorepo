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
    @State private var recoveryPassword = ""
    @State private var recoveryError: String?
    @State private var isRequestingRecoveryCode = false
    @State private var showDeleteAccount = false
    @State private var deletePassword = ""
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
                            SecureField("Current password", text: $recoveryPassword)
                                .textContentType(.password)
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
        .navigationTitle("Profile")
        .task(id: userId) { await load() }
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
    // The field stays out of the way until asked for, by the + at the end
    // of the list — same as the game's Title & tags sheet.
    @State private var isAddingTag = false

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
                    Button {
                        isAddingTag = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus")
                            Text("New tag")
                        }
                        .font(.subheadline)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy)
                }
                .padding(.horizontal, 1)
            }
            if isAddingTag {
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
            isAddingTag = false
            errorMessage = nil
            suggestions = (try? await APIClient.tagSuggestions()) ?? suggestions
            await onChange(chosen.lowercased())
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
