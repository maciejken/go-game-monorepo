import SwiftUI

// There is no email here, so a forgotten password is answered by a code
// the account was given when it was made. These are the two screens that
// go with it: the one that shows a code, and the one that spends it.

// Shown once per code, because the server keeps only its hash and cannot
// show it again. Deliberately a sheet you have to dismiss.
struct RecoveryCodeSheet: View {
    let code: String
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Your recovery code")
                .font(.headline)
            Text("Write this down. It is the only way back into your account if you forget your password, and it isn't shown again.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(code)
                .font(.title3.monospaced().weight(.semibold))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 8) {
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button {
                    dismiss()
                } label: {
                    // Inside the label, like Copy's: on the button itself
                    // it stretches the frame and leaves the button its
                    // own small size in the middle of it.
                    Text("Done").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            Spacer(minLength: 0)
        }
        .padding()
    }
}

// Setting a password without knowing the old one. The code is the proof,
// so this asks for nothing else — and hands back the next code, since the
// one just used is spent.
struct ResetPasswordSheet: View {
    var initialUsername: String = ""
    // Hands back the next code and the credentials that now work, so the
    // screen behind can sign in with them rather than leaving someone at
    // a login form their saved password no longer opens.
    let onReset: (_ nextCode: String, _ username: String, _ password: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var code = ""
    @State private var newPassword = ""
    @State private var errorMessage: String?
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        // Without this iOS has no account to attach the
                        // new password to, so it never offers to update
                        // the one it already has.
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Recovery code", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    SecureField("New password", text: $newPassword)
                        .textContentType(.newPassword)
                } footer: {
                    Text("The code you were given when the account was made. Using it sets a new password and gives you a new code.")
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .navigationTitle("Forgot password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Reset") { Task { await submit() } }
                        .disabled(isSubmitting || username.isEmpty || code.isEmpty || newPassword.isEmpty)
                }
            }
            .onAppear { if username.isEmpty { username = initialUsername } }
        }
    }

    private func submit() async {
        guard !isSubmitting else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let nextCode = try await APIClient.resetPassword(
                username: username,
                recoveryCode: code,
                newPassword: newPassword
            )
            dismiss()
            onReset(nextCode, username, newPassword)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
