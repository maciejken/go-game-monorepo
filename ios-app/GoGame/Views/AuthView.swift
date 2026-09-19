import SwiftUI

struct AuthView: View {
    @Environment(SessionStore.self) private var session
    @State private var username = ""
    @State private var password = ""
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
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
                }
            }
            .navigationTitle("Igo5")
        }
    }
}
