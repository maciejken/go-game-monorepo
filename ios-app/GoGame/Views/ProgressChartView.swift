import Charts
import SwiftUI

// The validated series steps from client/src/index.css, where the web
// client's charts take theirs: a cool and a warm pole with the zero line
// as the neutral between them. The dark pair is its own step rather than a
// lightened flip of the light one.
private let wonColor = Color(uiColor: UIColor { traits in
    traits.userInterfaceStyle == .dark
        ? UIColor(red: 0.224, green: 0.529, blue: 0.898, alpha: 1) // #3987e5
        : UIColor(red: 0.165, green: 0.471, blue: 0.839, alpha: 1) // #2a78d6
})
private let lostColor = Color(uiColor: UIColor { traits in
    traits.userInterfaceStyle == .dark
        ? UIColor(red: 0.851, green: 0.349, blue: 0.149, alpha: 1) // #d95926
        : UIColor(red: 0.922, green: 0.408, blue: 0.204, alpha: 1) // #eb6834
})

// How the games that ended in a count have gone: one bar each, the margin
// in points from this player's own side, above or below a line at zero.
//
// Bars rather than a line, because the games aren't samples of something
// continuous — each is its own result, and what should be legible is the
// run of wins and how big they were.
//
// Only scored games are in the series. A resignation or a loss on time has
// no number attached, and drawing one at the same height as a win by 2.5
// would be inventing data. The server narrows the series to the quick game
// preset for the same reason: board size, handicap, komi and the strength
// of the opponent each move the margin on their own, so a series mixing
// them would measure the settings rather than the player.
struct ProgressChartView: View {
    @State private var series: ProgressSeries?
    @State private var errorMessage: String?

    // Enumerating into a type keeps the games identifiable for both the
    // chart and the list while carrying their position in the run.
    private struct Point: Identifiable {
        let position: Int
        let game: ProgressGame

        var id: String { game.gameId }
    }

    var body: some View {
        Group {
            if let errorMessage {
                ContentUnavailableView(
                    "Couldn't load your progress",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if let series {
                if series.games.isEmpty {
                    ContentUnavailableView(
                        "No games counted yet",
                        systemImage: "chart.bar",
                        description: Text(
                            "Only games that end in a count are shown, and only those played with your current quick game settings."
                        )
                    )
                } else {
                    loaded(series)
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Progress")
        .task { await load() }
    }

    private func loaded(_ series: ProgressSeries) -> some View {
        let points = series.games.enumerated().map { Point(position: $0.offset + 1, game: $0.element) }
        return List {
            Section {
                chart(points)
                    .frame(height: 220)
            } footer: {
                Text(summary(series.games))
            }

            // Also the table view: every margin is a number here, so the
            // series is readable without separating the two hues.
            Section {
                ForEach(points) { point in
                    row(point.game)
                }
            } footer: {
                Text(presetLine(series.preset))
            }
        }
    }

    private func chart(_ points: [Point]) -> some View {
        Chart {
            // What the bars are read against: won above, lost below.
            RuleMark(y: .value("Points", 0))
                .foregroundStyle(.secondary)
                .lineStyle(StrokeStyle(lineWidth: 1))

            ForEach(points) { point in
                BarMark(
                    x: .value("Game", point.position),
                    y: .value("Points", point.game.margin),
                    // Thin, with a gap between neighbours — and it keeps
                    // a series of one from being a bar the width of the
                    // screen.
                    width: .ratio(0.6)
                )
                .foregroundStyle(by: .value("Result", point.game.margin > 0 ? wonLabel : lostLabel))
                .cornerRadius(2)
                .accessibilityLabel(dateText(point.game.finishedAt))
                .accessibilityValue(marginText(point.game.margin))
            }
        }
        // Fixed order, so which hue means what doesn't change with the
        // run of results — and a legend, so it isn't carried by colour
        // alone.
        .chartForegroundStyleScale(domain: [wonLabel, lostLabel], range: [wonColor, lostColor])
        // The position in the run is what the bars' order already says,
        // and "game 7" of a filtered series means nothing on its own; the
        // list below names each one by date instead.
        .chartXAxis(.hidden)
    }

    private func row(_ game: ProgressGame) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(dateText(game.finishedAt))
                if let caption = game.title?.isEmpty == false ? game.title : game.opponent {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Text(marginText(game.margin))
                .monospacedDigit()
                .foregroundStyle(game.margin > 0 ? wonColor : lostColor)
        }
    }

    private var wonLabel: String { String(localized: "Won") }
    private var lostLabel: String { String(localized: "Lost") }

    private func dateText(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: Double(epochMs) / 1000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    // Always signed: the sign is the result, and "2.5" alone doesn't say
    // who those points belonged to.
    private func marginText(_ margin: Double) -> String {
        margin.formatted(
            .number.sign(strategy: .always()).precision(.fractionLength(margin == margin.rounded() ? 0 : 1))
        )
    }

    private func summary(_ games: [ProgressGame]) -> String {
        let won = games.filter { $0.margin > 0 }.count
        let average = games.reduce(0.0) { $0 + $1.margin } / Double(games.count)
        return String(
            localized: "%lld of %lld won, average %@",
            defaultValue: "\(won) of \(games.count) won, average \(marginText(average))"
        )
    }

    // What the series is a series of — a margin means nothing without it.
    private func presetLine(_ preset: ProgressPreset) -> String {
        var parts: [String] = []
        switch preset.mode {
        case "gnugo":
            parts.append(String(localized: "Vs. Computer"))
            if let level = preset.gnugoLevel {
                parts.append(String(localized: "level %lld", defaultValue: "level \(level)"))
            }
        case "remote":
            parts.append(preset.opponentUsername ?? String(localized: "Remote"))
        default:
            parts.append(String(localized: "Local"))
        }
        parts.append("\(preset.size)×\(preset.size)")
        if preset.handicap > 0 {
            parts.append(String(localized: "handicap %lld", defaultValue: "handicap \(preset.handicap)"))
        }
        parts.append(
            preset.komi == 0
                ? String(localized: "no komi")
                : String(localized: "komi %@", defaultValue: "komi \(komiText(preset.komi))")
        )
        return parts.joined(separator: " · ")
    }

    private func komiText(_ komi: Double) -> String {
        komi == komi.rounded() ? String(Int(komi)) : String(format: "%.1f", komi)
    }

    private func load() async {
        do {
            series = try await APIClient.withRetry { try await APIClient.progress() }
        } catch {
            guard !APIClient.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }
}
