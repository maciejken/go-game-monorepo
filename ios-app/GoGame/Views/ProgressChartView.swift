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
// A straight line through the margins by least squares — the only thing
// on this screen that answers "am I getting better" rather than "how did
// that game go".
private struct Trend {
    let slope: Double
    let intercept: Double
    // The slope's own standard error, and the scatter it comes from.
    let standardError: Double
    let scatter: Double
    let count: Int

    func value(at position: Int) -> Double { intercept + slope * Double(position) }

    // Go margins are noisy enough that a run of luck tilts the line, so a
    // slope only counts when it is at least twice the error on it — the
    // usual "about 95%" line.
    var threshold: Double { 2 * standardError }
    var isClear: Bool { standardError > 0 ? abs(slope) >= threshold : slope != 0 }
    var t: Double { standardError > 0 ? slope / standardError : 0 }
}

struct ProgressChartView: View {
    @State private var series: ProgressSeries?
    @State private var errorMessage: String?
    @State private var showTrendDetails = false

    // Enumerating into a type keeps the games identifiable for both the
    // chart and the list while carrying their position in the run.
    private struct Point: Identifiable {
        let position: Int
        let game: ProgressGame

        var id: String { game.gameId }
    }

    private func trend(_ points: [Point]) -> Trend? {
        // Under a handful of games a fitted line says more about the last
        // result than about the player.
        guard points.count >= 5 else { return nil }
        let n = Double(points.count)
        let xs = points.map { Double($0.position) }
        let ys = points.map(\.game.margin)
        let meanX = xs.reduce(0, +) / n
        let meanY = ys.reduce(0, +) / n
        let sxx = xs.reduce(0.0) { $0 + ($1 - meanX) * ($1 - meanX) }
        guard sxx > 0 else { return nil }
        let sxy = zip(xs, ys).reduce(0.0) { $0 + ($1.0 - meanX) * ($1.1 - meanY) }
        let slope = sxy / sxx
        let intercept = meanY - slope * meanX
        // The residual scatter gives the slope its own standard error, and
        // a t of 2 is the usual "about 95%" line. Rough at this sample
        // size, which is why the wording it drives hedges rather than
        // declares.
        let residuals = zip(xs, ys).reduce(0.0) { sum, pair in
            let fitted = intercept + slope * pair.0
            return sum + (pair.1 - fitted) * (pair.1 - fitted)
        }
        let scatter = (residuals / (n - 2)).squareRoot()
        return Trend(
            slope: slope,
            intercept: intercept,
            standardError: scatter / sxx.squareRoot(),
            scatter: scatter,
            count: points.count
        )
    }

    private func trendText(_ trend: Trend) -> String {
        guard trend.isClear else {
            return String(localized: "No clear trend yet")
        }
        let rate = abs(trend.slope).formatted(.number.precision(.fractionLength(1)))
        return trend.slope > 0
            ? String(localized: "Improving by %@ points a game", defaultValue: "Improving by \(rate) points a game")
            : String(localized: "Slipping by %@ points a game", defaultValue: "Slipping by \(rate) points a game")
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

                // The verdict, and a way to see what it rests on — a row
                // rather than footer text, because a footer isn't
                // something you can tap.
                if let trend = trend(points) {
                    Button {
                        showTrendDetails = true
                    } label: {
                        HStack {
                            Text(trendText(trend))
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "info.circle")
                                .foregroundStyle(.tint)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Trend"))
                    .sheet(isPresented: $showTrendDetails) {
                        TrendDetailsView(trend: trend)
                    }
                }
            } footer: {
                // Both belong to the chart: what the series is of, and
                // how it went. Under the list they'd be a scroll away
                // from the thing they describe.
                VStack(alignment: .leading, spacing: 4) {
                    Text(presetLine(series.preset))
                    Text(summary(series.games))
                }
            }

            // Also the table view: every margin is a number here, so the
            // series is readable without separating the two hues.
            Section {
                ForEach(points) { point in
                    row(point.game)
                }
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
                    // The position as a label, not a number: a width
                    // given as a ratio needs a step to be a ratio of,
                    // and only a categorical scale has one. On a numeric
                    // x the bars come out zero-width and the chart draws
                    // nothing at all — axes, grid and no data.
                    x: .value("Game", String(point.position)),
                    y: .value("Points", point.game.margin),
                    // Thin with a gap between neighbours once there are
                    // enough of them to crowd; below that the step is so
                    // wide that a share of it is a slab rather than a bar.
                    width: points.count >= 12 ? .ratio(0.7) : .fixed(24)
                )
                .foregroundStyle(by: .value("Result", point.game.margin > 0 ? wonLabel : lostLabel))
                .cornerRadius(2)
                .accessibilityLabel(dateText(point.game.finishedAt))
                .accessibilityValue(marginText(point.game.margin))
            }

            // Drawn whenever there are enough games to fit it, in ink
            // rather than either series colour so it reads as a summary
            // of the bars and not as another one of them. Whether it
            // means anything is the caption's job, below the chart.
            if let trend = trend(points) {
                ForEach(points) { point in
                    LineMark(
                        x: .value("Game", String(point.position)),
                        y: .value("Points", trend.value(at: point.position)),
                        series: .value("Trend", "fit")
                    )
                    // Color.primary, not the .primary shape style, which
                    // inside a chart is the first series colour — the
                    // line would come out the same blue as a win.
                    .foregroundStyle(Color.primary.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 3]))
                }
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
        // Always said, including when there is no clock: "no limit" is a
        // condition the games were played under as much as ten minutes is,
        // and leaving it out would read as the setting being unknown.
        switch preset.timeControl {
        case "standard":
            parts.append(String(localized: "10 minutes"))
        case "correspondence":
            parts.append(String(localized: "24h per move"))
        default:
            parts.append(String(localized: "Unlimited"))
        }
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

// What the verdict rests on. "No clear trend yet" is a conclusion, and a
// conclusion you can't inspect is one you have to take on faith — these
// are the four numbers it is computed from, so a slope on its way to
// counting can be watched approaching instead of waited on.
private struct TrendDetailsView: View {
    let trend: Trend
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Games", value: "\(trend.count)")
                    LabeledContent("Slope", value: signed(trend.slope))
                    LabeledContent("Needed", value: "±\(number(trend.threshold))")
                    LabeledContent("Scatter", value: number(trend.scatter))
                } footer: {
                    Text("Slope and the threshold are points a game. Scatter is how far a game sits from the line, on average, in points.")
                }

                Section {
                    Text("The line is fitted to your results by least squares. It only counts as a trend once the slope reaches twice its own margin of error, so that a run of luck doesn't read as improvement.")
                    Text("Playing more games lowers the threshold quickly. Steadier results lower it too: one heavy defeat among close games raises the scatter, and the threshold rises with it.")
                }
            }
            .navigationTitle("Trend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func number(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(2)))
    }

    private func signed(_ value: Double) -> String {
        value.formatted(.number.sign(strategy: .always()).precision(.fractionLength(2)))
    }
}
