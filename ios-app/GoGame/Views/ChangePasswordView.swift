import SwiftUI

// A screen of its own rather than a section of the profile, for the same
// reason Quick game preset is one: it is a task with an end. The end is
// also what iOS watches for — it offers to update a saved password when
// the fields it was typed into leave the screen, and a form embedded in a
// longer page never leaves.
struct ChangePasswordView: View {
    let username: String
    let onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var errorMessage: String?
    @State private var isSubmitting = false

    var body: some View {
        Form {
            Section {
                // Unmarked on purpose. Marked .password, this is a
                // credential field like any other, and iOS offered to
                // generate a new password into it — the one field where a
                // new password is exactly wrong.
                SecureField("Current password", text: $currentPassword)
                // The account the new password is for, not editable and
                // here for iOS rather than for the reader: a strong
                // password is only offered when the system can see whose
                // it is, and it sits immediately above the field it
                // belongs with, because position is what the pairing
                // follows.
                TextField("Username", text: .constant(username))
                    .textContentType(.username)
                    .disabled(true)
                    .foregroundStyle(.secondary)
                SecureField("New password", text: $newPassword)
                    .textContentType(.newPassword)
                SecureField("Confirm new password", text: $confirmPassword)
                    .textContentType(.newPassword)
                    .submitLabel(.go)
                    .onSubmit { Task { await submit() } }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } footer: {
                Text("Signs you out everywhere else. This device stays signed in.")
            }
        }
        .navigationTitle("Change password")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await submit() } }
                    .disabled(
                        isSubmitting || currentPassword.isEmpty || newPassword.isEmpty || confirmPassword.isEmpty
                    )
            }
        }
    }

    private func submit() async {
        errorMessage = nil
        guard newPassword == confirmPassword else {
            errorMessage = String(localized: "New passwords do not match")
            return
        }
        guard !isSubmitting else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await APIClient.changePassword(currentPassword: currentPassword, newPassword: newPassword)
            onChanged()
            // Leaving is the point: it is what tells the person it worked
            // and what gives iOS the moment it needs.
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
