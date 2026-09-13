import SwiftUI

// One player's clock reading: "mm:ss" (or the byoyomi period's countdown
// once main time is exhausted), plus — underneath, once in byoyomi — a row
// of short LED-style segments (like a DSEG seven-segment display's dashes)
// spanning exactly the time text's width: all `byoyomiPeriods` segments
// always render, with the used ones dimmed and `periodsLeft` left bright,
// rather than the row itself shrinking as periods are used.
//
// The width is taken from a GeometryReader placed in an .overlay (which
// SwiftUI proposes the base view's own size to, synchronously, in the same
// layout pass) rather than a measure-then-@State-then-reapply dance: this
// view gets recreated every second by the TimelineView driving it, so any
// @State-based measurement would reset before it had a chance to apply,
// leaving the segments permanently sized to their initial (zero) width.
// Mirrors client/src/pages/Game.tsx's clockLabel/periodDots, restyled.
struct ClockView: View {
    var label: String = ""
    let clock: LiveClockDisplay
    let byoyomiPeriods: Int?
    let isActive: Bool

    private var showSegments: Bool {
        clock.inByoyomi && (byoyomiPeriods ?? 0) > 1
    }

    var body: some View {
        HStack(spacing: 6) {
            if !label.isEmpty {
                Text(label)
                    .font(.subheadline)
                    .fontWeight(isActive ? .semibold : .regular)
            }
            Text(formatClock(clock.inByoyomi ? clock.periodMs : clock.mainMs))
                .font(.subheadline.monospacedDigit())
                .fontWeight(isActive ? .semibold : .regular)
        }
        .padding(.bottom, showSegments ? 7 : 0)
        .overlay(alignment: .bottom) {
            if showSegments, let byoyomiPeriods {
                GeometryReader { geo in
                    byoyomiSegments(total: byoyomiPeriods, remaining: clock.periodsLeft)
                        .frame(width: geo.size.width)
                }
                // Thinner (was 3pt) — same subtle-over-solid direction as
                // the review nav icons/markers.
                .frame(height: 2)
            }
        }
        .foregroundStyle(isActive ? .primary : .secondary)
    }

    @ViewBuilder
    private func byoyomiSegments(total: Int, remaining: Int) -> some View {
        HStack(spacing: 2) {
            ForEach(0..<total, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1)
                    .opacity(index >= total - remaining ? 1 : 0.25)
            }
        }
    }
}
