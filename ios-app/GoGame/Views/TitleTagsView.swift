import SwiftUI

// Lays subviews out left to right, wrapping to a new line when the next one
// wouldn't fit — what a row of tag chips needs and what neither HStack (one
// line, squeezed) nor LazyVGrid (fixed columns, ragged for variable-width
// chips) gives.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        var widestRow: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth > 0, rowWidth + spacing + size.width > maxWidth {
                totalHeight += rowHeight + spacing
                widestRow = max(widestRow, rowWidth)
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += (rowWidth > 0 ? spacing : 0) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        widestRow = max(widestRow, rowWidth)
        return CGSize(width: min(maxWidth, widestRow), height: totalHeight + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// A tag as a capsule: plain on a game-list row, and with an × wherever it
// can be removed.
struct TagChip: View {
    let tag: String
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 4) {
            Text(tag)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove tag \(tag)")
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, onRemove == nil ? 8 : 5)
        .padding(.vertical, 3)
        .background(Color.primary.opacity(0.08), in: Capsule())
    }
}

// The ⋮ menu's Title & tags sheet: the game's title in an editable field,
// its tags as chips with an × each plus one field for adding another, and a
// star toggling the game in and out of the viewer's favourites. No
// validation of its own beyond a length cap — the server checks both the
// title and every tag, and whatever it rejects is shown under the fields.
//
// Only the two players can edit a title or tags (the server enforces it
// too); anyone else sees them read-only, since the star is open to
// everyone and is reached through this same sheet.
struct TitleTagsSheetView: View {
    let gameId: String
    let title: String?
    let tags: [String]
    let starred: Bool
    let canEdit: Bool
    let onTitleChange: (String?) -> Void
    let onTagsChange: ([String]) -> Void
    let onStarredChange: (Bool) -> Void
    // Reported back so the sheet's detent can be exactly as tall as this
    // content, which changes as chips wrap onto more rows.
    @Binding var contentHeight: CGFloat

    @State private var titleDraft = ""
    @State private var draft = ""
    @State private var errorMessage: String?
    @State private var isBusy = false

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedTitle: String {
        titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ZStack {
                Text("Title & tags")
                    .font(.headline)
                HStack {
                    Spacer()
                    starButton
                }
            }
            if canEdit {
                HStack(spacing: 8) {
                    TextField("Game title", text: $titleDraft)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.done)
                        .onSubmit { Task { await saveTitle() } }
                    Button("Save") { Task { await saveTitle() } }
                        .disabled(isBusy || trimmedTitle == (title ?? ""))
                }
            } else if let title, !title.isEmpty {
                Text(title)
                    .font(.subheadline)
            }
            if tags.isEmpty {
                Text("No tags yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                FlowLayout(spacing: 8) {
                    ForEach(tags, id: \.self) { tag in
                        chip(tag)
                    }
                }
            }
            if canEdit {
                HStack(spacing: 8) {
                    TextField("Add a tag", text: $draft)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .submitLabel(.done)
                        .onSubmit { Task { await add() } }
                    Button("Add") { Task { await add() } }
                        .disabled(isBusy || trimmedDraft.isEmpty)
                }
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .padding()
        .onAppear { titleDraft = title ?? "" }
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: TagsSheetHeightKey.self, value: proxy.size.height)
            }
        }
        .onPreferenceChange(TagsSheetHeightKey.self) { height in
            contentHeight = height
        }
    }

    private var starButton: some View {
        Button {
            Task { await toggleStarred() }
        } label: {
            Image(systemName: starred ? "star.fill" : "star")
                .font(.title3)
                .foregroundStyle(starred ? Color.yellow : Color.secondary)
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .accessibilityLabel(starred ? "Remove from favourites" : "Add to favourites")
    }

    @ViewBuilder
    private func chip(_ tag: String) -> some View {
        HStack(spacing: 4) {
            Text(tag)
                .font(.subheadline)
                .lineLimit(1)
            if canEdit {
                Button {
                    Task { await remove(tag) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("Remove tag \(tag)")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, canEdit ? 8 : 12)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.08), in: Capsule())
    }

    private func saveTitle() async {
        let newTitle = trimmedTitle
        guard !isBusy, newTitle != (title ?? "") else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await APIClient.setTitle(gameId: gameId, title: newTitle)
            onTitleChange(newTitle.isEmpty ? nil : newTitle)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggleStarred() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await APIClient.setStarred(gameId: gameId, starred: !starred)
            onStarredChange(!starred)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func add() async {
        let tag = trimmedDraft
        guard !tag.isEmpty, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            onTagsChange(try await APIClient.addTag(gameId: gameId, tag: tag))
            draft = ""
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func remove(_ tag: String) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            onTagsChange(try await APIClient.removeTag(gameId: gameId, tag: tag))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct TagsSheetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
