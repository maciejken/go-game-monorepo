import Foundation

// Ported directly from shared/src/index.ts (re-read in full for this port,
// not from memory) — same function names, same logic, same
// maxSekiSharedRegionSize heuristic, same unbounded liberty-sharing rule for
// findSekiPartnerStones. Swift can't import a TypeScript package, so this is
// a language port, not a redesign.

private func oppositeColor(_ color: StoneColor) -> StoneColor {
    color == .black ? .white : .black
}

private func isPointOnBoard(_ board: Board, _ point: Point) -> Bool {
    point.y >= 0 && point.y < board.count && point.x >= 0 && point.x < board[point.y].count
}

private func getNeighbors(_ board: Board, _ point: Point) -> [Point] {
    [
        Point(x: point.x - 1, y: point.y),
        Point(x: point.x + 1, y: point.y),
        Point(x: point.x, y: point.y - 1),
        Point(x: point.x, y: point.y + 1),
    ].filter { isPointOnBoard(board, $0) }
}

// Flood-fills the connected group of same-color stones starting at `point`.
func getGroup(_ board: Board, _ point: Point) -> [Point] {
    guard let color = board[point.y][point.x] else { return [] }
    var visited: Set<String> = ["\(point.x),\(point.y)"]
    var group: [Point] = [point]
    var stack: [Point] = [point]
    while let current = stack.popLast() {
        for neighbor in getNeighbors(board, current) {
            let key = "\(neighbor.x),\(neighbor.y)"
            if visited.contains(key) || board[neighbor.y][neighbor.x] != color { continue }
            visited.insert(key)
            group.append(neighbor)
            stack.append(neighbor)
        }
    }
    return group
}

// Assigns a stable numeric id to every stone's group, so the region pass
// below can cross-reference "which specific group is this" rather than just
// "which color" — needed to tell seki apart from an ordinary dame point
// next to an already-alive group.
private func labelGroups(_ board: Board) -> [[Int]] {
    let size = board.count
    var groupId = Array(repeating: Array(repeating: -1, count: size), count: size)
    var nextId = 0
    for y in 0..<size {
        for x in 0..<size {
            guard board[y][x] != nil, groupId[y][x] == -1 else { continue }
            let id = nextId
            nextId += 1
            for stone in getGroup(board, Point(x: x, y: y)) {
                groupId[stone.y][stone.x] = id
            }
        }
    }
    return groupId
}

struct Region {
    var size: Int = 0
    var points: [Point] = []
    var colors: Set<StoneColor> = []
    var groupIds: Set<Int> = []
}

// Flood-fills every connected empty region on the board, recording which
// color(s) and which specific stone groups border each one.
private func findRegions(_ board: Board, _ groupId: [[Int]]) -> [Region] {
    let size = board.count
    var regions: [Region] = []
    var visited: Set<String> = []
    for y in 0..<size {
        for x in 0..<size {
            guard board[y][x] == nil else { continue }
            let key = "\(x),\(y)"
            if visited.contains(key) { continue }
            var region = Region()
            var stack = [Point(x: x, y: y)]
            visited.insert(key)
            while let point = stack.popLast() {
                region.size += 1
                region.points.append(point)
                for neighbor in getNeighbors(board, point) {
                    if let neighborStone = board[neighbor.y][neighbor.x] {
                        region.colors.insert(neighborStone)
                        region.groupIds.insert(groupId[neighbor.y][neighbor.x])
                    } else {
                        let neighborKey = "\(neighbor.x),\(neighbor.y)"
                        if !visited.contains(neighborKey) {
                            visited.insert(neighborKey)
                            stack.append(neighbor)
                        }
                    }
                }
            }
            regions.append(region)
        }
    }
    return regions
}

// A shared region only counts as a plausible seki vital point if it's small
// — see shared/src/index.ts's own comment for the full reasoning (an
// ordinary dame between two unrelated groups shouldn't be misread as seki).
private let maxSekiSharedRegionSize = 2

private func findSekiNeutralRegions(_ regions: [Region]) -> Set<Int> {
    var privateRegionsByGroup: [Int: [Int]] = [:]
    var eyeCountByGroup: [Int: Int] = [:]

    for (index, region) in regions.enumerated() {
        guard region.colors.count == 1 else { continue }
        for id in region.groupIds {
            eyeCountByGroup[id, default: 0] += 1
            privateRegionsByGroup[id, default: []].append(index)
        }
    }

    var neutral: Set<Int> = []
    for region in regions {
        guard region.colors.count == 2, region.size <= maxSekiSharedRegionSize else { continue }
        guard region.groupIds.allSatisfy({ (eyeCountByGroup[$0] ?? 0) < 2 }) else { continue }
        for id in region.groupIds {
            for privateIndex in privateRegionsByGroup[id] ?? [] {
                neutral.insert(privateIndex)
            }
        }
    }
    return neutral
}

// Given a stone belonging to one side of a seki, returns every stone in the
// opposite-color group(s) it shares a liberty with — used to auto-extend a
// "mark seki" tap to the other side of the pair, since a real seki always
// involves both. Any adjacent opposite-color group sharing a liberty
// counts, however many there are — this session already relaxed this from a
// size-limited heuristic to trusting the human's declaration, for the web
// client; this port keeps that same relaxed rule.
func findSekiPartnerStones(_ board: Board, _ point: Point) -> [Point] {
    guard let color = board[point.y][point.x] else { return [] }
    let opponent = oppositeColor(color)
    var partnerStones: [Point] = []
    var visitedPartnerStones: Set<String> = []
    var visitedLiberties: Set<String> = []

    for stone in getGroup(board, point) {
        for liberty in getNeighbors(board, stone) {
            guard board[liberty.y][liberty.x] == nil else { continue }
            let libertyKey = "\(liberty.x),\(liberty.y)"
            if visitedLiberties.contains(libertyKey) { continue }
            visitedLiberties.insert(libertyKey)

            for neighbor in getNeighbors(board, liberty) {
                let neighborKey = "\(neighbor.x),\(neighbor.y)"
                guard board[neighbor.y][neighbor.x] == opponent, !visitedPartnerStones.contains(neighborKey) else { continue }
                let partnerGroup = getGroup(board, neighbor)
                for partnerStone in partnerGroup {
                    visitedPartnerStones.insert("\(partnerStone.x),\(partnerStone.y)")
                }
                partnerStones.append(contentsOf: partnerGroup)
            }
        }
    }
    return partnerStones
}

// A player can also directly declare a group to be in seki — this pulls in
// every group directly sharing a liberty with a declared group too, so both
// sides' eyes end up excluded from territory either way.
private func findDeclaredSekiRegions(_ board: Board, _ groupId: [[Int]], _ regions: [Region], _ declaredPoints: [Point]) -> Set<Int> {
    var declaredGroups: Set<Int> = []
    for point in declaredPoints {
        guard isPointOnBoard(board, point), board[point.y][point.x] != nil else { continue }
        declaredGroups.insert(groupId[point.y][point.x])
    }

    for region in regions {
        if region.colors.count == 2, region.groupIds.contains(where: { declaredGroups.contains($0) }) {
            declaredGroups.formUnion(region.groupIds)
        }
    }

    var neutral: Set<Int> = []
    for (index, region) in regions.enumerated() {
        if region.colors.count == 1, region.groupIds.contains(where: { declaredGroups.contains($0) }) {
            neutral.insert(index)
        }
    }
    return neutral
}

// Removes stones marked dead from the board (so they no longer block
// territory for their color) and credits each one to the opposing color as
// a prisoner. Leaves the inputs untouched.
func applyDeadStones(_ board: Board, _ captures: Captures, _ deadPoints: [Point]) -> (board: Board, captures: Captures) {
    var nextBoard = board
    var blackCaptures = captures.black
    var whiteCaptures = captures.white
    for point in deadPoints {
        guard isPointOnBoard(nextBoard, point) else { continue }
        guard let stone = nextBoard[point.y][point.x] else { continue }
        nextBoard[point.y][point.x] = nil
        if oppositeColor(stone) == .black {
            blackCaptures += 1
        } else {
            whiteCaptures += 1
        }
    }
    return (nextBoard, Captures(black: blackCaptures, white: whiteCaptures))
}

struct ScoreResult {
    let black: Double
    let white: Double
    let winner: StoneColor
    let margin: Double
    // Every empty point actually counted as territory for that color — for
    // rendering the scoring-phase territory markers. Points inside a seki
    // (automatic or declared) are deliberately absent from both, same as
    // dame — they score for neither side, so there's nothing to mark.
    let blackTerritoryPoints: [Point]
    let whiteTerritoryPoints: [Point]
}

// Japanese-style territory scoring: surrounded empty territory plus
// prisoners. This scores the board exactly as it stands — it does not know
// which stones are "dead", so it's only correct after applyDeadStones has
// already removed any the players agreed didn't survive.
func scoreBoard(_ board: Board, _ captures: Captures, komi: Double, declaredSekiPoints: [Point] = []) -> ScoreResult {
    let groupId = labelGroups(board)
    let regions = findRegions(board, groupId)
    let sekiNeutral = findSekiNeutralRegions(regions)
    let declaredNeutral = findDeclaredSekiRegions(board, groupId, regions, declaredSekiPoints)

    var blackTerritory = 0
    var whiteTerritory = 0
    var blackTerritoryPoints: [Point] = []
    var whiteTerritoryPoints: [Point] = []

    for (index, region) in regions.enumerated() {
        guard region.colors.count == 1, !sekiNeutral.contains(index), !declaredNeutral.contains(index) else { continue }
        if region.colors.contains(.black) {
            blackTerritory += region.size
            blackTerritoryPoints.append(contentsOf: region.points)
        } else {
            whiteTerritory += region.size
            whiteTerritoryPoints.append(contentsOf: region.points)
        }
    }

    let black = Double(blackTerritory + captures.black)
    let white = Double(whiteTerritory + captures.white) + komi

    return ScoreResult(
        black: black,
        white: white,
        winner: black > white ? .black : .white,
        margin: abs(black - white),
        blackTerritoryPoints: blackTerritoryPoints,
        whiteTerritoryPoints: whiteTerritoryPoints
    )
}
