import Foundation

// Offline games live on the device as one JSON file each: the event log,
// plus the few things that can't be derived from it (the title, and the
// outcome of scoring once it has been finalised).
//
// The log is the source of truth, exactly as it is on the server — the
// board, whose turn it is and how the game ended are all replayed from it
// by GameFlow rather than stored alongside and left to disagree.

// An event as it sits on disk. GameEvent is an enum with associated values,
// which Codable can encode, but not into anything a person would want to
// read in a file or debug by eye.
struct StoredGameEvent: Codable {
    let type: String
    let color: StoneColor?
    let point: Point?
    let points: [Point]?

    init(_ event: GameEvent) {
        switch event {
        case let .handicap(points):
            self.type = "handicap"
            self.color = nil
            self.point = nil
            self.points = points
        case let .move(color, point):
            self.type = "move"
            self.color = color
            self.point = point
            self.points = nil
        case let .pass(color):
            self.type = "pass"
            self.color = color
            self.point = nil
            self.points = nil
        case let .resign(color):
            self.type = "resign"
            self.color = color
            self.point = nil
            self.points = nil
        }
    }

    var event: GameEvent? {
        switch type {
        case "handicap":
            return .handicap(points: points ?? [])
        case "move":
            guard let color, let point else { return nil }
            return .move(color: color, point: point)
        case "pass":
            guard let color else { return nil }
            return .pass(color: color)
        case "resign":
            guard let color else { return nil }
            return .resign(color: color)
        default:
            return nil
        }
    }
}

struct OfflineGameRecord: Codable {
    let id: String
    var title: String?
    let size: Int
    let handicap: Int
    let komi: Double
    let createdAt: Int
    var updatedAt: Int
    var events: [StoredGameEvent]
    // Marked during the scoring phase and kept, so reopening scoring starts
    // from what was already marked rather than a blank board.
    var deadPoints: [Point]
    var sekiPoints: [Point]
    // Who is playing each colour, when there is anything to say: the signed-
    // in user's name goes on the side they took, and the other side is left
    // to its colour. Absent in games saved before names existed, which is
    // why these are optional.
    var blackName: String?
    var whiteName: String?
    // The id this game was given when it was published to the server, once
    // it has been. The device's own copy stays as it is — publishing sends
    // a finished game up, it doesn't move it.
    var publishedGameId: String?
    // Set only for a game shared with a nearby device: the colour this
    // device plays, the guest taking the other. nil means nobody else is
    // playing and both colours are this player's.
    var hostColor: StoneColor?
    // Only set once scoring has been finalised: a resignation's result is
    // derivable from the log, a counted one is not.
    var scoredResult: String?
    var scoredBlack: Double?
    var scoredWhite: Double?

    var configuration: GameConfiguration {
        GameConfiguration(size: size, handicap: handicap, komi: komi)
    }

    var gameEvents: [GameEvent] {
        events.compactMap(\.event)
    }

    // Which side this device plays: one colour once the game is shared with
    // a nearby device, both while it is nobody else's.
    var myColor: MyColor {
        switch hostColor {
        case .black: return .black
        case .white: return .white
        case nil: return .both
        }
    }
}

enum OfflineGameStoreError: LocalizedError {
    case notFound

    var errorDescription: String? {
        switch self {
        case .notFound:
            return "Game not found"
        }
    }
}

// Every offline game id starts with this, which is how the app knows to
// reach for the device rather than the network — see GameTransports.
let offlineGameIdPrefix = "offline-"

func isOfflineGameId(_ id: String) -> Bool {
    id.hasPrefix(offlineGameIdPrefix)
}

final class OfflineGameStore {
    static let shared = OfflineGameStore()

    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            self.directory = base.appendingPathComponent("OfflineGames", isDirectory: true)
        }
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    private func url(for id: String) -> URL {
        // Ids are generated here and always "offline-<uuid>", so they can't
        // contain a path separator — but a file name is built from one, so
        // this doesn't take that on trust.
        let safe = id.replacingOccurrences(of: "/", with: "_")
        return directory.appendingPathComponent("\(safe).json")
    }

    func create(
        size: Int,
        handicap: Int,
        komi: Double?,
        title: String?,
        blackName: String? = nil,
        whiteName: String? = nil,
        hostColor: StoneColor? = nil
    ) throws -> OfflineGameRecord {
        let configuration = GameConfiguration(size: size, handicap: handicap, komi: komi)
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let record = OfflineGameRecord(
            id: offlineGameIdPrefix + UUID().uuidString.lowercased(),
            title: title?.isEmpty == true ? nil : title,
            size: size,
            handicap: handicap,
            komi: configuration.komi,
            createdAt: now,
            updatedAt: now,
            events: GameFlow.openingEvents(configuration: configuration).map(StoredGameEvent.init),
            deadPoints: [],
            sekiPoints: [],
            blackName: blackName,
            whiteName: whiteName,
            hostColor: hostColor,
            scoredResult: nil,
            scoredBlack: nil,
            scoredWhite: nil
        )
        try save(record)
        return record
    }

    func load(_ id: String) throws -> OfflineGameRecord {
        guard let data = FileManager.default.contents(atPath: url(for: id).path) else {
            throw OfflineGameStoreError.notFound
        }
        return try decoder.decode(OfflineGameRecord.self, from: data)
    }

    func save(_ record: OfflineGameRecord) throws {
        var updated = record
        updated.updatedAt = Int(Date().timeIntervalSince1970 * 1000)
        // Written whole, to a temporary file, then moved into place: a
        // crash mid-write leaves the previous game intact rather than a
        // half-written log that replays into nonsense.
        let data = try encoder.encode(updated)
        let destination = url(for: record.id)
        let temporary = destination.appendingPathExtension("writing")
        try data.write(to: temporary, options: .atomic)
        _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
    }

    func delete(_ id: String) throws {
        try? FileManager.default.removeItem(at: url(for: id))
    }

    // Newest first, matching the order the games list uses.
    func all() -> [OfflineGameRecord] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { file in
                guard let data = FileManager.default.contents(atPath: file.path) else { return nil }
                return try? decoder.decode(OfflineGameRecord.self, from: data)
            }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
}

extension OfflineGameRecord {
    // The list shows server games and offline ones side by side, so an
    // offline game has to describe itself in the same shape.
    var summary: GameSummary {
        let flow = GameFlow.replay(gameEvents, configuration: configuration)
        let status = scoredResult != nil ? GameStatus.finished : flow.status
        return GameSummary(
            id: id,
            size: size,
            handicap: handicap,
            komi: komi,
            title: title,
            status: status.rawValue,
            result: nil,
            shortResult: scoredResult ?? flow.shortResult,
            createdAt: createdAt,
            updatedAt: updatedAt,
            blackUsername: displayName(blackName, colour: .black),
            whiteUsername: displayName(whiteName, colour: .white),
            blackUserId: nil,
            whiteUserId: nil,
            myColor: myColor,
            isAiOpponent: false,
            gnugoLevel: nil,
            timeControl: nil,
            starred: false,
            tags: []
        )
    }
}

// A side's label: the name recorded for it, or just its colour. The two mix
// freely — the signed-in player's name on one side, "White" on the other.
func displayName(_ name: String?, colour: StoneColor) -> String {
    if let name, !name.isEmpty {
        return name
    }
    return colour == .black ? String(localized: "Black") : String(localized: "White")
}
