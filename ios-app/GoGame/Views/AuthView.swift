import SwiftUI

struct AuthView: View {
    // Only the screen standing between someone and the app offers a way
    // past it. Reached from the Account tab, they are already playing
    // without an account, and the offer would do nothing.
    var offersOfflinePlay = true

    @Environment(SessionStore.self) private var session
    @State private var username = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var showReset = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    // .password rather than .newPassword: the same two
                    // fields log in and register, and logging in is what
                    // they are mostly used for. Marked at all is the
                    // point — unmarked, iOS guesses, and guesses wrong
                    // about whether a password it has is still current.
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit {
                            guard !isSubmitting, !username.isEmpty, !password.isEmpty else { return }
                            Task {
                                isSubmitting = true
                                await session.login(username: username, password: password)
                                isSubmitting = false
                            }
                        }
                }

                if let errorMessage = session.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }

                Section {
                    Button("Log in") {
                        Task {
                            isSubmitting = true
                            await session.login(username: username, password: password)
                            isSubmitting = false
                        }
                    }
                    .disabled(isSubmitting || username.isEmpty || password.isEmpty)

                    Button("Register") {
                        Task {
                            isSubmitting = true
                            await session.register(username: username, password: password)
                            isSubmitting = false
                        }
                    }
                    .disabled(isSubmitting || username.isEmpty || password.isEmpty)

                    Button("Forgot password?") {
                        showReset = true
                    }
                }

                // An account is for playing other people. A game against
                // the person opposite you, or one saved on this device,
                // needs nobody's permission.
                if offersOfflinePlay {
                    Section {
                        Button("Play without an account") {
                            session.playOffline()
                        }
                    } footer: {
                        Text("Play on this device, or with someone nearby. Games stay here until you publish them.")
                    }
                } else {
                    Section {
                        Text("Sign in to play other people, and to keep your games on the server.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .keyboardDoneButton()
            .navigationTitle(offersOfflinePlay ? "Igo5" : "Account")
            .sheet(isPresented: $showReset) {
                ResetPasswordSheet(initialUsername: username) { nextCode, name, newPassword in
                    // Signed in on the spot: the password was just set, so
                    // asking for it again is a form to fight with autofill
                    // over. This happens before the sheet closes, so the
                    // fields it came from are still on screen.
                    self.username = name
                    self.password = newPassword
                    await session.login(username: name, password: newPassword)
                    // The code waits its turn. Putting a sheet up in the
                    // same instant takes the screen at exactly the moment
                    // iOS would offer to save the password, and the offer
                    // does not come back — which is why this stopped
                    // working when the two were reordered.
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        session.recoveryCodeToShow = nextCode
                    }
                }
            }
        }
    }
}
