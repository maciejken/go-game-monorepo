import SwiftUI

// Reporting a player, which is not the same act as blocking one. Blocking
// is a decision about your own games and takes effect the moment you tap
// it; reporting asks somebody to look at a name, a game title or a tag
// that shouldn't be there. Offered together, because the person who wants
// one usually wants the other, and taken together by default — but a
// report that only hid the content from the one person who objected to it
// would not be a report.
struct ReportSheet: View {
    let username: String
    // The game the offending text was seen in, when there is one: a title
    // or a tag is only actionable if it says which game it was on.
    var gameId: String?

    @Environment(\.dismiss) private var dismiss
    @State private var reason = "behaviour"
    @State private var note = ""
    @State private var alsoBlock = true
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var isSent = false

    var body: some View {
        NavigationStack {
            Form {
                if isSent {
                    Section {
                        Text("Thanks — we'll look at this within a day.")
                    }
                } else {
                    Section {
                        Picker("Reason", selection: $reason) {
                            Text("Offensive name").tag("username")
                            Text("Offensive text in a game").tag("game_text")
                            Text("Behaviour towards me").tag("behaviour")
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: {
                        Text("Reason")
                    }

                    Section {
                        TextField("Anything else we should know?", text: $note, axis: .vertical)
                            .lineLimit(2...5)
                    }

                    Section {
                        Toggle("Block them too", isOn: $alsoBlock)
                    } footer: {
                        Text("Blocking stops them inviting you to games. They aren't told.")
                    }

                    if let errorMessage {
                        Section {
                            Text(errorMessage)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }
            }
            .navigationTitle(Text(String(localized: "Report %@", defaultValue: "Report \(username)")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSent {
                        Button("Done") { dismiss() }
                    } else {
                        Button("Send") { Task { await send() } }
                            .disabled(isSending)
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func send() async {
        isSending = true
        defer { isSending = false }
        do {
            try await APIClient.report(username: username, gameId: gameId, reason: reason, note: note, block: alsoBlock)
            isSent = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
