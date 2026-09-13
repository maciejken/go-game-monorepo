import SwiftUI

// Which side this clock's byoyomi segments cluster against — black sits on
// the left of the footer, white on the right, so each's remaining-period
// markers hug the same side its own clock already reads from.
enum ClockSegmentAlignment: Equatable {
    case leading
    case trailing
}

// One player's clock reading: "mm:ss" (or the byoyomi period's countdown
// once main time is exhausted), plus — once in byoyomi — a row of very
// thin segments for periods left, overlaid below the text without
// reserving any layout space of its own (an .offset nudges it down
// visually rather than a reserved padding gap, so this view's own height
// never changes when byoyomi kicks in — previously it did, via a
// conditional bottom padding, which visibly shifted the whole footer).
// It's free to render into whatever's below in the footer (always empty
// there, and even the safe area beneath if needed) instead. A used period
// disappears entirely rather than just dimming, and the remaining ones are
// sized as if all `byoyomiPeriods` were still there (not stretched to
// fill), so the segments don't change size as they disappear — just count.
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
    var segmentAlignment: ClockSegmentAlignment = .leading

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
        .overlay(alignment: segmentAlignment == .leading ? .bottomLeading : .bottomTrailing) {
            if showSegments, let byoyomiPeriods {
                GeometryReader { geo in
                    byoyomiSegments(total: byoyomiPeriods, remaining: clock.periodsLeft, availableWidth: geo.size.width)
                }
                .frame(height: 1.5)
                .offset(y: 5)
            }
        }
        .foregroundStyle(isActive ? .primary : .secondary)
    }

    @ViewBuilder
    private func byoyomiSegments(total: Int, remaining: Int, availableWidth: CGFloat) -> some View {
        let spacing: CGFloat = 2
        // Sized against `total`, not `remaining` — each segment's own
        // width stays constant for the whole game; only the count actually
        // drawn shrinks as periods are used, not their individual size.
        let segmentWidth = max(0, (availableWidth - CGFloat(total - 1) * spacing) / CGFloat(total))
        HStack(spacing: spacing) {
            if segmentAlignment == .trailing {
                Spacer(minLength: 0)
            }
            ForEach(0..<remaining, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 1)
                    .frame(width: segmentWidth)
            }
            if segmentAlignment == .leading {
                Spacer(minLength: 0)
            }
        }
    }
}
