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

// A tag as it appears on a game-list row: a plain capsule, no remove button
// (the game's own Tags sheet is where they're edited).
struct TagChip: View {
    let tag: String

    var body: some View {
        Text(tag)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.primary.opacity(0.08), in: Capsule())
    }
}

// The ⋮ menu's Tags sheet: the game's tags as chips with an × each, plus one
// field for adding another. No validation of its own beyond a length cap —
// the server checks every tag and answers with the whole updated list, and
// whatever it rejects is shown as the message under the field.
struct TagsSheetView: View {
    let gameId: String
    let tags: [String]
    let onTagsChange: ([String]) -> Void
    // Reported back so the sheet's detent can be exactly as tall as this
    // content, which changes as chips wrap onto more rows.
    @Binding var contentHeight: CGFloat

    @State private var draft = ""
    @State private var errorMessage: String?
    @State private var isBusy = false

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Tags")
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .center)
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
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .padding()
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: TagsSheetHeightKey.self, value: proxy.size.height)
            }
        }
        .onPreferenceChange(TagsSheetHeightKey.self) { height in
            contentHeight = height
        }
    }

    @ViewBuilder
    private func chip(_ tag: String) -> some View {
        HStack(spacing: 4) {
            Text(tag)
                .font(.subheadline)
                .lineLimit(1)
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
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.08), in: Capsule())
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
