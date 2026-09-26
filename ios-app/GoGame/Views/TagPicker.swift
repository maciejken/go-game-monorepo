import SwiftUI

// Picking a tag, wherever that is done: the tags this user has used before
// as capsules with a +, most-used first, and a field for a new one that
// stays out of the way until the + at the end of the row asks for it.
//
// It only offers; what happens to a chosen tag is the caller's business —
// the game's own sheet sends it to the server, the new-game form keeps it
// until the game exists. Whatever is already chosen is passed in, so the
// row never offers a tag that is on the game already.
struct TagPicker: View {
    let selected: [String]
    // Share puts a tag on the game for both players. Only where that can
    // actually happen: a game that hasn't been created yet has nobody to
    // share with, and its tags are the creator's own.
    var offersSharing = false
    // A tag to show as already chosen — a star instead of a plus. The
    // favourites picker nominates one tag rather than collecting several,
    // and that is the whole of the difference.
    var marked: String?
    var isBusy = false
    // Returns whether the tag was taken, which is what decides if the
    // field clears itself or stays put with what was typed.
    let onAdd: (String, Bool) async -> Bool

    @State private var suggestions: [TagSuggestion] = []
    @State private var draft = ""
    @State private var isAddingTag = false
    @FocusState private var fieldFocused: Bool

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var offered: [TagSuggestion] {
        let taken = Set(selected.map { $0.lowercased() })
        return suggestions.filter { !taken.contains($0.tag.lowercased()) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            suggestionsRow
            if isAddingTag {
                newTagField
            }
        }
        .task { await loadSuggestions() }
    }

    private var suggestionsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(offered, id: \.tag) { suggestion in
                    Button {
                        Task { _ = await add(suggestion.tag, isPublic: offersSharing && suggestion.isPublic) }
                    } label: {
                        suggestionChip(suggestion)
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy)
                }
                Button {
                    // A second press closes it again, so the chip that
                    // opened the field is also the way out of it.
                    isAddingTag.toggle()
                    fieldFocused = isAddingTag
                    if !isAddingTag { draft = "" }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isAddingTag ? "xmark" : "plus")
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
    }

    // Both labels get this, so neither glyph decides its button's height,
    // and it is roomy enough that icon and word sit centred with air
    // around them rather than filling the capsule to its edges.
    private var tagButtonLabelHeight: CGFloat { 26 }

    private func isMarked(_ tag: String) -> Bool {
        marked?.caseInsensitiveCompare(tag) == .orderedSame
    }

    private func suggestionChip(_ suggestion: TagSuggestion) -> some View {
        HStack(spacing: 4) {
            Text(suggestion.tag)
                .font(.subheadline)
                .lineLimit(1)
            // Shared tags carry the same icon the Share button uses, so
            // the list says which kind each one is without a second label.
            if offersSharing, suggestion.isPublic {
                Image(systemName: "person.2")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Image(systemName: isMarked(suggestion.tag) ? "star.fill" : "plus")
                .font(.caption)
                .foregroundStyle(isMarked(suggestion.tag) ? Color.yellow : Color.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.08), in: Capsule())
        .accessibilityLabel(
            offersSharing && suggestion.isPublic
                ? Text("Add shared tag \(suggestion.tag)")
                : Text("Add personal tag \(suggestion.tag)")
        )
    }

    // Share puts the tag on the game for both players; Add keeps it to
    // this user. Two buttons rather than a switch, so which one was
    // pressed is the whole answer.
    private var newTagField: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Add a tag", text: $draft)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .focused($fieldFocused)
                .onSubmit { Task { _ = await add(trimmedDraft, isPublic: false) } }
                // Somewhere to put the keyboard down that doesn't mean
                // committing a tag: without this the field holds focus,
                // the keyboard covers the screen, and leaving the page is
                // a fight.
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { fieldFocused = false }
                    }
                }
            // No Cancel here: the chip that opened this closes it again,
            // and a third button crowds the row enough to wrap Share onto
            // two lines and shove it out of line with Add.
            HStack(spacing: 8) {
                if offersSharing {
                    Button {
                        Task { _ = await add(trimmedDraft, isPublic: true) }
                    } label: {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .labelStyle(.titleAndIcon)
                            .lineLimit(1)
                            // Both labels are given the same box, or the
                            // taller glyph (the arrow) makes its button
                            // taller than the other and lifts its text
                            // off the line the other one sits on.
                            .frame(height: tagButtonLabelHeight)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(isBusy || trimmedDraft.isEmpty)
                }
                Button {
                    Task { _ = await add(trimmedDraft, isPublic: false) }
                } label: {
                    // Spelled out, because a prominent button drops a
                    // Label's icon once it is enabled and keeps it while
                    // disabled — so the + appeared only on the button you
                    // couldn't press.
                    Label("Add", systemImage: "plus")
                        .labelStyle(.titleAndIcon)
                        .lineLimit(1)
                        .frame(height: tagButtonLabelHeight)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isBusy || trimmedDraft.isEmpty)
            }
        }
    }

    private func add(_ tag: String, isPublic: Bool) async -> Bool {
        guard !tag.isEmpty else { return false }
        guard await onAdd(tag, isPublic) else { return false }
        draft = ""
        isAddingTag = false
        await loadSuggestions()
        return true
    }

    private func loadSuggestions() async {
        // A vocabulary that fails to load is a row with only the + on it,
        // not an error worth saying anything about.
        suggestions = (try? await APIClient.tagSuggestions()) ?? suggestions
    }
}
