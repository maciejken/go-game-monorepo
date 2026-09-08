import SwiftUI

// Mirrors the metadata line built by client/src/pages/Home.tsx's
// GameListItem (metaParts/metaRows) for parity with the web client's list.
struct GameRowView: View {
    let game: GameSummary

    private var metaParts: [String] {
        var parts = ["\(game.size)x\(game.size)"]
        if game.myColor != .both {
            parts.append("\(game.blackUsername ?? "—") vs \(game.whiteUsername ?? "—")")
        }
        if game.isAiOpponent, let level = game.gnugoLevel {
            parts.append("level \(level)")
        }
        if game.handicap > 0 {
            parts.append("handicap \(game.handicap)")
        }
        parts.append(game.komi == 0 ? "no komi" : "komi \(game.komi)")
        parts.append(game.timeControl.map(timeControlLabel) ?? "Unlimited")
        if game.status == "finished" {
            parts.append(game.shortResult ?? "no result")
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
            Text("Created: \(formattedDate(game.createdAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Updated: \(formattedDate(game.updatedAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func timeControlLabel(_ timeControl: TimeControl) -> String {
        switch timeControl {
        case .standard: return "10 min"
        case .correspondence: return "24h per move"
        }
    }

    private func formattedDate(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: Double(epochMs) / 1000).formatted(date: .numeric, time: .shortened)
    }
}
