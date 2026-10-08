import SwiftUI

// The people this user refuses invitations from, as chips they can take
// off again. Shaped like TagPicker and deliberately only half of it:
// blocking happens where the person is — an invitation, their profile —
// so there is nothing to add from here, only to undo.
struct BlockedUsersPicker: View {
    @State private var blocked: [String] = []
    @State private var busyWith: String?
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if blocked.isEmpty {
                Text("You haven't blocked anyone.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(blocked, id: \.self) { username in
                            Button {
                                Task { await unblock(username) }
                            } label: {
                                chip(username)
                            }
                            .buttonStyle(.plain)
                            .disabled(busyWith != nil)
                        }
                    }
                    .padding(.horizontal, 1)
                }
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .task { await load() }
    }

    private func chip(_ username: String) -> some View {
        HStack(spacing: 4) {
            Text(username)
                .font(.subheadline)
                .lineLimit(1)
            Image(systemName: "xmark")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.08), in: Capsule())
        .opacity(busyWith == username ? 0.4 : 1)
        .accessibilityLabel(Text(String(localized: "Unblock %@", defaultValue: "Unblock \(username)")))
    }

    private func load() async {
        // An empty row is the right answer to a list that won't load: the
        // only thing this view offers is undoing something, and there is
        // nothing to undo until we know what is there.
        blocked = (try? await APIClient.blockedUsers()) ?? blocked
    }

    private func unblock(_ username: String) async {
        busyWith = username
        errorMessage = nil
        defer { busyWith = nil }
        do {
            try await APIClient.unblock(username: username)
            blocked.removeAll { $0 == username }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
