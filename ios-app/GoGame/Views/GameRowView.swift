import SwiftUI

// Mirrors the metadata line built by client/src/pages/Home.tsx's
// GameListItem (metaParts/metaRows) for parity with the web client's list.
struct GameRowView: View {
    let game: GameSummary

    private var metaParts: [String] {
        var parts = ["\(game.size)x\(game.size)"]
        if game.myColor != .both {
            let black = game.blackUsername ?? "—"
            let white = game.whiteUsername ?? "—"
            parts.append(String(localized: "%@ vs %@", defaultValue: "\(black) vs \(white)"))
        }
        if game.isAiOpponent, let level = game.gnugoLevel {
            parts.append(String(localized: "level %lld", defaultValue: "level \(level)"))
        }
        if game.handicap > 0 {
            parts.append(String(localized: "handicap %lld", defaultValue: "handicap \(game.handicap)"))
        }
        let komi = game.komi.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(game.komi))
            : String(format: "%.1f", game.komi)
        parts.append(
            game.komi == 0
                ? String(localized: "no komi")
                : String(localized: "komi %@", defaultValue: "komi \(komi)")
        )
        parts.append(game.timeControl.map(timeControlLabel) ?? String(localized: "Unlimited"))
        if game.status == "finished" {
            parts.append(game.shortResult ?? String(localized: "no result"))
        }
        return parts
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = game.title, !title.isEmpty {
                Text(title)
                    .font(.headline)
            }
            Text(metaParts.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            // Read-only here (the game's own Tags sheet is where they're
            // edited) so a row that turned up via a tag search shows why.
            if !game.tagList.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(game.tagList, id: \.self) { tag in
                        TagChip(tag: tag)
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    private func timeControlLabel(_ timeControl: TimeControl) -> String {
        switch timeControl {
        case .standard: return String(localized: "10 min")
        case .correspondence: return String(localized: "24h per move")
        }
    }
}
