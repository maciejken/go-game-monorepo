import Foundation

// Runs shared/fixtures/rules.json against the Swift engine, so the device's
// referee and the server's answer identically. Built and run by
// scripts/check-swift-rules.sh; no Xcode target, because the rules are
// plain functions over a board and compile on their own.
//
// Prints one line per failing case and exits non-zero, so it reads like a
// test report rather than a diff.

struct Fixtures: Decodable {
    let version: Int
    let moveSequences: [MoveSequence]
    let scoring: [ScoringCase]
    let handicap: [HandicapCase]
    let clocks: [ClockCase]
    let timeControls: [TimeControlCase]
}

struct MoveSequence: Decodable {
    let name: String
    let size: Int
    let steps: [Step]
    let finalBoard: [String]

    struct Step: Decodable {
        let color: String
        let x: Int
        let y: Int
        let valid: Bool
        let captured: [Point]?
        let error: String?
    }
}

struct ScoringCase: Decodable {
    let name: String
    let size: Int
    let board: [String]
    let captures: CaptureCounts
    let komi: Double
    let dead: [Point]
    let seki: [Point]
    let expect: Expectation

    struct CaptureCounts: Decodable {
        let black: Int
        let white: Int
    }

    struct Expectation: Decodable {
        let black: Double
        let white: Double
        let winner: String
        let margin: Double
        let blackTerritory: Int
        let whiteTerritory: Int
    }
}

struct ClockCase: Decodable {
    let name: String
    let state: State
    let byoyomiSeconds: Int
    let elapsedMs: Int
    let expect: Expectation

    struct State: Decodable {
        let remainingMs: Int
        let periodsLeft: Int
    }

    struct Expectation: Decodable {
        let timedOut: Bool
        let after: State
    }
}

struct TimeControlCase: Decodable {
    let name: String
    let preset: Preset?

    struct Preset: Decodable {
        let mainTimeSeconds: Int
        let byoyomiSeconds: Int
        let byoyomiPeriods: Int
    }
}

struct HandicapCase: Decodable {
    let size: Int
    let handicap: Int
    let points: [Point]
    let komi: Double
}

struct FlowFixtures: Decodable {
    let version: Int
    let cases: [FlowCase]
}

struct FlowCase: Decodable {
    let name: String
    let size: Int
    let handicap: Int
    let opening: Opening
    let actions: [Action]

    struct Opening: Decodable {
        let currentColor: String
        let status: String
    }

    struct Action: Decodable {
        let type: String
        let color: String
        let x: Int?
        let y: Int?
        let expect: Expectation
    }

    struct Expectation: Decodable {
        let status: String?
        let currentColor: String?
        let shortResult: String?
        let rejected: String?
        let endReason: String?
        let captures: CaptureCounts?

        struct CaptureCounts: Decodable {
            let black: Int
            let white: Int
        }
    }
}

func parseBoard(_ rows: [String]) -> Board {
    rows.map { row in
        row.map { character -> StoneColor? in
            switch character {
            case "B": return .black
            case "W": return .white
            default: return nil
            }
        }
    }
}

func renderBoard(_ board: Board) -> [String] {
    board.map { row in
        String(row.map { stone in
            switch stone {
            case .black: return "B"
            case .white: return "W"
            case nil: return "."
            }
        })
    }
}

var failures: [String] = []
var checked = 0

func expect(_ condition: Bool, _ describe: @autoclosure () -> String) {
    checked += 1
    if !condition {
        failures.append(describe())
    }
}

let fixturePath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "shared/fixtures/rules.json"
guard let data = FileManager.default.contents(atPath: fixturePath) else {
    FileHandle.standardError.write("cannot read \(fixturePath)\n".data(using: .utf8)!)
    exit(2)
}
let fixtures = try JSONDecoder().decode(Fixtures.self, from: data)
guard fixtures.version == 1 else {
    FileHandle.standardError.write("fixtures are version \(fixtures.version); this runner understands 1\n".data(using: .utf8)!)
    exit(2)
}

for sequence in fixtures.moveSequences {
    var board = createEmptyBoard(size: sequence.size)
    var history: [PositionRecord] = []
    var moveNumber = 1

    for (index, step) in sequence.steps.enumerated() {
        let colour: StoneColor = step.color == "black" ? .black : .white
        let result = validateMove(
            board,
            Point(x: step.x, y: step.y),
            colour,
            moveNumber: moveNumber,
            history: history
        )
        let where_ = "\(sequence.name) [step \(index + 1): \(step.color) (\(step.x),\(step.y))]"

        expect(result.isValid == step.valid, "\(where_): expected valid=\(step.valid), got \(result.isValid)")

        if step.valid {
            let expected = step.captured ?? []
            expect(
                Set(result.capturedPoints.map { "\($0.x),\($0.y)" }) == Set(expected.map { "\($0.x),\($0.y)" }),
                "\(where_): captured \(result.capturedPoints.count), expected \(expected.count)"
            )
            if let next = result.board {
                history.append(PositionRecord(board: next, nextColor: opposite(colour)))
                board = next
                moveNumber += 1
            }
        } else {
            expect(
                result.error == step.error,
                "\(where_): error was \(result.error ?? "nil"), expected \(step.error ?? "nil")"
            )
        }
    }

    expect(
        renderBoard(board) == sequence.finalBoard,
        "\(sequence.name): final board differs\n     got: \(renderBoard(board).joined(separator: "/"))\n     want: \(sequence.finalBoard.joined(separator: "/"))"
    )
}

for testCase in fixtures.scoring {
    let board = parseBoard(testCase.board)
    let captures = Captures(black: testCase.captures.black, white: testCase.captures.white)
    let (effective, adjusted) = applyDeadStones(board, captures, testCase.dead)
    let result = scoreBoard(effective, adjusted, komi: testCase.komi, declaredSekiPoints: testCase.seki)

    expect(result.black == testCase.expect.black, "\(testCase.name): black \(result.black), expected \(testCase.expect.black)")
    expect(result.white == testCase.expect.white, "\(testCase.name): white \(result.white), expected \(testCase.expect.white)")
    expect(result.winner.rawValue == testCase.expect.winner, "\(testCase.name): winner \(result.winner.rawValue), expected \(testCase.expect.winner)")
    expect(result.margin == testCase.expect.margin, "\(testCase.name): margin \(result.margin), expected \(testCase.expect.margin)")
    expect(
        result.blackTerritoryPoints.count == testCase.expect.blackTerritory,
        "\(testCase.name): black territory \(result.blackTerritoryPoints.count), expected \(testCase.expect.blackTerritory)"
    )
    expect(
        result.whiteTerritoryPoints.count == testCase.expect.whiteTerritory,
        "\(testCase.name): white territory \(result.whiteTerritoryPoints.count), expected \(testCase.expect.whiteTerritory)"
    )
}

for testCase in fixtures.handicap {
    let points = handicapPoints(size: testCase.size, handicap: testCase.handicap)
    let label = "handicap \(testCase.size)x\(testCase.size) h\(testCase.handicap)"
    expect(
        points == testCase.points,
        "\(label): placed \(points.map { "(\($0.x),\($0.y))" }.joined(separator: " ")), expected \(testCase.points.map { "(\($0.x),\($0.y))" }.joined(separator: " "))"
    )
    expect(
        defaultKomi(forHandicap: testCase.handicap) == testCase.komi,
        "\(label): komi \(defaultKomi(forHandicap: testCase.handicap)), expected \(testCase.komi)"
    )
}

for testCase in fixtures.clocks {
    let state = ClockState(remainingMs: testCase.state.remainingMs, periodsLeft: testCase.state.periodsLeft)
    let timedOut = hasTimedOut(state, byoyomiSeconds: testCase.byoyomiSeconds, elapsedMs: testCase.elapsedMs)
    let after = deductClock(state, byoyomiSeconds: testCase.byoyomiSeconds, elapsedMs: testCase.elapsedMs)
    let expected = ClockState(remainingMs: testCase.expect.after.remainingMs, periodsLeft: testCase.expect.after.periodsLeft)

    expect(timedOut == testCase.expect.timedOut, "clock \(testCase.name): timedOut \(timedOut), expected \(testCase.expect.timedOut)")
    expect(after == expected, "clock \(testCase.name): left \(after), expected \(expected)")
}

for testCase in fixtures.timeControls {
    let preset = resolveTimeControl(testCase.name)
    if let expected = testCase.preset {
        expect(
            preset?.mainTimeSeconds == expected.mainTimeSeconds
                && preset?.byoyomiSeconds == expected.byoyomiSeconds
                && preset?.byoyomiPeriods == expected.byoyomiPeriods,
            "time control \(testCase.name): resolved to \(String(describing: preset)), expected \(expected)"
        )
    } else {
        expect(preset == nil, "time control \(testCase.name): resolved to \(String(describing: preset)), expected nothing")
    }
}

// The state machine, against the same cases the server is driven through
// by scripts/check-server-flow.mjs.
let flowPath = (fixturePath as NSString).deletingLastPathComponent + "/game-flow.json"
if let flowData = FileManager.default.contents(atPath: flowPath) {
    let flowFixtures = try JSONDecoder().decode(FlowFixtures.self, from: flowData)
    for testCase in flowFixtures.cases {
        let configuration = GameConfiguration(size: testCase.size, handicap: testCase.handicap)
        var events = GameFlow.openingEvents(configuration: configuration)
        var state = GameFlow.replay(events, configuration: configuration)

        expect(
            state.currentColor.rawValue == testCase.opening.currentColor,
            "\(testCase.name) [opening]: currentColor \(state.currentColor.rawValue), expected \(testCase.opening.currentColor)"
        )
        expect(
            state.status.rawValue == testCase.opening.status,
            "\(testCase.name) [opening]: status \(state.status.rawValue), expected \(testCase.opening.status)"
        )

        for (index, action) in testCase.actions.enumerated() {
            let where_ = "\(testCase.name) [action \(index + 1): \(action.type) \(action.color)]"
            let colour: StoneColor = action.color == "black" ? .black : .white
            var thrown: String?
            do {
                let event: GameEvent
                switch action.type {
                case "move":
                    event = try GameFlow.move(
                        Point(x: action.x ?? -1, y: action.y ?? -1),
                        as: colour,
                        in: state,
                        configuration: configuration
                    )
                case "pass":
                    event = try GameFlow.pass(as: colour, in: state)
                default:
                    event = try GameFlow.resign(as: colour, in: state)
                }
                events.append(event)
                state = GameFlow.replay(events, configuration: configuration)
            } catch {
                thrown = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }

            if let rejected = action.expect.rejected {
                expect(thrown == rejected, "\(where_): refused with \(thrown ?? "nothing"), expected \(rejected)")
            } else {
                expect(thrown == nil, "\(where_): unexpectedly refused with \(thrown ?? "")")
            }
            if let status = action.expect.status {
                expect(state.status.rawValue == status, "\(where_): status \(state.status.rawValue), expected \(status)")
            }
            if let colourExpected = action.expect.currentColor {
                expect(
                    state.currentColor.rawValue == colourExpected,
                    "\(where_): currentColor \(state.currentColor.rawValue), expected \(colourExpected)"
                )
            }
            if let shortResult = action.expect.shortResult {
                expect(
                    state.shortResult == shortResult,
                    "\(where_): shortResult \(state.shortResult ?? "nil"), expected \(shortResult)"
                )
            }
            if let endReason = action.expect.endReason {
                expect(
                    state.endReason?.rawValue == endReason,
                    "\(where_): endReason \(state.endReason?.rawValue ?? "nil"), expected \(endReason)"
                )
            }
            if let captures = action.expect.captures {
                expect(
                    state.captures.black == captures.black && state.captures.white == captures.white,
                    "\(where_): captures b\(state.captures.black)/w\(state.captures.white), expected b\(captures.black)/w\(captures.white)"
                )
            }
        }
    }
    print("game-flow cases checked: \(flowFixtures.cases.count)")
}

if failures.isEmpty {
    print("""
    Swift engine agrees with the TypeScript one: \(fixtures.moveSequences.count) sequences, \
    \(fixtures.scoring.count) scoring cases, \(fixtures.handicap.count) handicap layouts, \
    \(fixtures.clocks.count) clock cases (\(checked) assertions).
    """)
    exit(0)
}

print("\(failures.count) of \(checked) assertions failed:")
for failure in failures {
    print("  - \(failure)")
}
exit(1)
