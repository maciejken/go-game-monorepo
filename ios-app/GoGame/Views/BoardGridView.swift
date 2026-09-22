import SwiftUI

// Pure rendering: a Canvas-drawn grid (lines through intersection centers,
// like a real Go board) with one tappable button positioned at each
// intersection — not a per-cell-bordered grid, which would look like a
// checkerboard offset half a cell from where the lines actually are.
struct BoardGridView: View {
    let board: Board
    let size: Int
    let lastMove: Point?
    let isInteractive: Bool
    // false during play (can't move onto a stone); true during scoring
    // (tapping a stone is how you mark its group dead/seki).
    var allowTapOnOccupied: Bool = false
    // Point keys ("x,y") currently marked dead — rendered dimmed.
    var deadPoints: Set<String> = []
    // Point keys currently counted as each color's territory — rendered as
    // a small square. Still shown on a dead-marked stone's own point (not
    // just empty points), since applyDeadStones already treats it as empty
    // for scoring purposes.
    var blackTerritoryPoints: Set<String> = []
    var whiteTerritoryPoints: Set<String> = []
    // Point keys of the actively-marked seki group — while non-empty, a dark
    // semi-transparent "spotlight" overlay covers the whole board except
    // soft-edged holes punched out at these points, so the rest of the
    // board dims (without blurring or desaturating it) while the marked
    // group stays exactly as sharp as it always was.
    var sekiHighlightPoints: Set<String> = []
    // The "confirm moves" feature's not-yet-submitted point — rendered as a
    // dimmed stone of pendingMoveColor, mirrors client/src/App.css's
    // .go-stone--pending.
    var pendingMove: Point?
    var pendingMoveColor: StoneColor = .black
    // The column a half-typed coordinate names ("D", "4-"), lit up so the
    // first half of the entry can be checked against the board before the
    // second half is typed, and the row once that arrives — the two cross
    // at the point being named.
    var highlightColumn: Int?
    var highlightRow: Int?
    let onTap: (Int, Int) -> Void

    private let woodColor = Color(red: 0.863, green: 0.718, blue: 0.447)

    var body: some View {
        GeometryReader { geo in
            let dimension = min(geo.size.width, geo.size.height)
            let cell = dimension / CGFloat(size)
            let isDimmed = !sekiHighlightPoints.isEmpty

            ZStack {
                ZStack {
                    Rectangle().fill(woodColor)

                    Canvas { context, _ in
                        for i in 0..<size {
                            let pos = cell / 2 + CGFloat(i) * cell
                            context.stroke(
                                linePath(from: CGPoint(x: pos, y: cell / 2), to: CGPoint(x: pos, y: dimension - cell / 2)),
                                with: .color(.black.opacity(0.55))
                            )
                            context.stroke(
                                linePath(from: CGPoint(x: cell / 2, y: pos), to: CGPoint(x: dimension - cell / 2, y: pos)),
                                with: .color(.black.opacity(0.55))
                            )
                        }
                        // The same system green as the entry field's valid
                        // tick, so the lines and the icon read as one signal.
                        let highlightColor = Color.green
                        if let highlightColumn, highlightColumn >= 0, highlightColumn < size {
                            let pos = cell / 2 + CGFloat(highlightColumn) * cell
                            context.stroke(
                                linePath(from: CGPoint(x: pos, y: cell / 2), to: CGPoint(x: pos, y: dimension - cell / 2)),
                                with: .color(highlightColor),
                                lineWidth: 4
                            )
                        }
                        if let highlightRow, highlightRow >= 0, highlightRow < size {
                            let pos = cell / 2 + CGFloat(highlightRow) * cell
                            context.stroke(
                                linePath(from: CGPoint(x: cell / 2, y: pos), to: CGPoint(x: dimension - cell / 2, y: pos)),
                                with: .color(highlightColor),
                                lineWidth: 4
                            )
                        }
                        for (hx, hy) in Self.hoshiPoints(for: size) {
                            let center = CGPoint(x: cell / 2 + CGFloat(hx) * cell, y: cell / 2 + CGFloat(hy) * cell)
                            let radius: CGFloat = 3
                            context.fill(
                                Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)),
                                with: .color(Color(red: 40 / 255, green: 24 / 255, blue: 8 / 255).opacity(0.85))
                            )
                        }
                    }

                    ForEach(0..<size, id: \.self) { y in
                        ForEach(0..<size, id: \.self) { x in
                            pointView(x: x, y: y, cell: cell)
                                .position(x: cell / 2 + CGFloat(x) * cell, y: cell / 2 + CGFloat(y) * cell)
                        }
                    }
                }
                .frame(width: dimension, height: dimension)

                // A dark overlay with soft-edged holes punched out at the
                // marked points, rather than a blur/desaturate filter on the
                // board itself — draws a plain no-op-cost layer the rest of
                // the time (isDimmed is rare, only while a seki group is
                // actively marked) and never risks the alpha-blending issue
                // an always-attached filter chain caused on a real device.
                if isDimmed {
                    Canvas { context, size in
                        context.drawLayer { layer in
                            layer.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black.opacity(0.6)))
                            layer.blendMode = .destinationOut
                            // A blur applied before punching turns the union
                            // of per-cell squares into one organically
                            // blobby shape following the group's actual
                            // footprint — not a row of separate circular
                            // "puffs" — one lump of light the marked stones
                            // and their shared liberties sit on top of.
                            // Plain (unrounded) rects, each slightly larger
                            // than its own cell so neighboring points fuse
                            // with no seam, keep the pre-blur shape's edges
                            // flat rather than already-rounded — rounding
                            // each cell individually before blurring is what
                            // made the result look like fused circles; a
                            // wider blur over flat edges spreads more
                            // uniformly and reaches further past the region.
                            layer.addFilter(.blur(radius: cell * 0.55))
                            var holePath = Path()
                            for key in sekiSpotlightPoints() {
                                guard let point = parsePointKey(key) else { continue }
                                let rect = CGRect(
                                    x: CGFloat(point.x) * cell, y: CGFloat(point.y) * cell,
                                    width: cell, height: cell
                                ).insetBy(dx: -cell * 0.1, dy: -cell * 0.1)
                                holePath.addRect(rect)
                            }
                            layer.fill(holePath, with: .color(.black))
                        }
                    }
                    .frame(width: dimension, height: dimension)
                    .allowsHitTesting(false)
                }
            }
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .aspectRatio(1, contentMode: .fit)
        .containerRelativeFrame(.horizontal)
    }

    // Mirrors client/src/pages/Game.tsx's HOSHI_POINTS.
    private static func hoshiPoints(for size: Int) -> [(Int, Int)] {
        switch size {
        case 9: return [(2, 2), (2, 6), (6, 2), (6, 6), (4, 4)]
        case 13: return [(3, 3), (3, 9), (9, 3), (9, 9), (6, 6)]
        case 19: return [
            (3, 3), (3, 9), (3, 15),
            (9, 3), (9, 9), (9, 15),
            (15, 3), (15, 9), (15, 15),
        ]
        default: return []
        }
    }

    private func linePath(from: CGPoint, to: CGPoint) -> Path {
        var path = Path()
        path.move(to: from)
        path.addLine(to: to)
        return path
    }

    private func parsePointKey(_ key: String) -> Point? {
        let parts = key.split(separator: ",").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return Point(x: parts[0], y: parts[1])
    }

    // sekiHighlightPoints is just the marked stones; a seki position is
    // fundamentally about the liberties those groups share, so the
    // spotlight needs to include the empty points adjacent to them too, not
    // just the stones themselves.
    private func sekiSpotlightPoints() -> Set<String> {
        guard !sekiHighlightPoints.isEmpty else { return [] }
        var points = sekiHighlightPoints
        for key in sekiHighlightPoints {
            guard let point = parsePointKey(key) else { continue }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let nx = point.x + dx
                let ny = point.y + dy
                guard nx >= 0, nx < size, ny >= 0, ny < size, board[ny][nx] == nil else { continue }
                points.insert("\(nx),\(ny)")
            }
        }
        return points
    }

    // No border on the white stone: there's no dark rim eating into the
    // circle — the warm off-white tint gives it enough definition against
    // the wood on its own, and it reads as a slightly bigger, cleaner disc.
    @ViewBuilder
    private func stoneShape(_ stone: StoneColor) -> some View {
        Circle()
            .fill(stone == .black ? Color.black : Color(red: 0.97, green: 0.94, blue: 0.87))
    }

    @ViewBuilder
    private func pointView(x: Int, y: Int, cell: CGFloat) -> some View {
        let key = "\(x),\(y)"
        let stone = board[y][x]
        let isDead = deadPoints.contains(key)
        // Deliberately never .disabled(...) — SwiftUI dims a disabled
        // button's whole label by default (even with .plain style), which
        // made every stone on the board look semi-transparent since almost
        // every point is non-tappable in one situation or another. Instead
        // the button stays enabled and its action is a no-op when tapping
        // shouldn't do anything, so stones always render at full opacity.
        let canTap = isInteractive && (allowTapOnOccupied || stone == nil)
        Button {
            guard canTap else { return }
            onTap(x, y)
        } label: {
            ZStack {
                Color.clear
                if let stone {
                    // The seki spotlight's lit region (drawn as a separate
                    // layer below the stones) is what makes a marked black
                    // stone read as "not dimmed" now — no per-stone glow
                    // needed on top of it.
                    stoneShape(stone)
                        .padding(cell * 0.06)
                        .opacity(isDead ? 0.35 : 1)
                    if lastMove?.x == x, lastMove?.y == y {
                        Circle()
                            .fill(stone == .black ? Color.white : Color.black)
                            .frame(width: cell * 0.28, height: cell * 0.28)
                            .opacity(isDead ? 0.35 : 1)
                    }
                }
                if stone == nil, pendingMove?.x == x, pendingMove?.y == y {
                    stoneShape(pendingMoveColor)
                        .padding(cell * 0.06)
                        .opacity(0.35)
                        .allowsHitTesting(false)
                }
                if stone == nil || isDead {
                    if blackTerritoryPoints.contains(key) {
                        territoryMarker(color: .black, cell: cell)
                    } else if whiteTerritoryPoints.contains(key) {
                        territoryMarker(color: .white, cell: cell)
                    }
                }
            }
            // Color.clear alone is not always reliably hit-testable as a
            // button's tap area (a long-standing SwiftUI quirk) — this makes
            // the whole cell tappable regardless of the label's actual
            // visual content, which matters most for empty points (an
            // all-Color.clear label) since those are exactly the ones that
            // need to register a tap to place a stone.
            .contentShape(Rectangle())
        }
        .frame(width: cell, height: cell)
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func territoryMarker(color: StoneColor, cell: CGFloat) -> some View {
        Rectangle()
            .fill(color == .black ? Color.black : Color.white)
            .overlay(Rectangle().stroke(Color.black.opacity(0.3), lineWidth: color == .white ? 1 : 0))
            .frame(width: cell * 0.36, height: cell * 0.36)
    }
}
