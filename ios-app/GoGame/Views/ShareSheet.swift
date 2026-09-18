import SwiftUI
import UIKit

// What Share game hands to the system: the SGF as both a file (for Save to
// Files, AirDrop, Mail) and as text (for Notes), plus the game's own
// address for the copy actions.
struct GameShare {
    let sgfFileURL: URL
    let sgfText: String
    let gameURL: URL?
    // The note's first line, which Notes turns into its title.
    let title: String

    // Notes receives this rather than the file: a title line, the link
    // under it, then the record itself.
    var noteText: String {
        [title, gameURL?.absoluteString, "", sgfText]
            .compactMap { $0 }
            .joined(separator: "\n")
    }
}

// Thin wrapper around UIActivityViewController — SwiftUI's own ShareLink
// can't be triggered lazily after an async fetch (its item has to be known
// up front), which is what this needs (fetch the SGF, write it to a temp
// file, then present the sheet).
struct ShareSheet: UIViewControllerRepresentable {
    let share: GameShare

    func makeUIViewController(context: Context) -> UIActivityViewController {
        var activities: [UIActivity] = [CopySgfActivity(text: share.sgfText)]
        if let gameURL = share.gameURL {
            activities.insert(CopyUrlActivity(url: gameURL), at: 0)
        }
        let controller = UIActivityViewController(
            activityItems: [GameShareItemSource(share: share)],
            applicationActivities: activities
        )
        // The system's own Copy would put the temp file's URL on the
        // pasteboard, which is useless outside this app's sandbox — Copy
        // URL and Copy SGF say what they actually copy.
        controller.excludedActivityTypes = [.copyToPasteboard]
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// Hands each activity the representation it can actually use: Notes wants
// text (handed a file it makes an empty-looking note), everything else
// wants the .sgf file.
private final class GameShareItemSource: NSObject, UIActivityItemSource {
    private let share: GameShare

    init(share: GameShare) {
        self.share = share
        super.init()
    }

    // Decides the sheet's own header preview, before any activity is
    // picked — the file, so it shows as an SGF document.
    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        share.sgfFileURL
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        itemForActivityType activityType: UIActivity.ActivityType?
    ) -> Any? {
        guard let activityType else { return share.sgfFileURL }
        return isNotes(activityType) ? share.noteText : share.sgfFileURL
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        subjectForActivityType activityType: UIActivity.ActivityType?
    ) -> String {
        share.title
    }

    // Matched on the identifier rather than a hardcoded constant: Notes
    // ships more than one (its share extension and Quick Note), and they
    // have been renamed across releases.
    private func isNotes(_ activityType: UIActivity.ActivityType) -> Bool {
        activityType.rawValue.localizedCaseInsensitiveContains("note")
    }
}

// Copies the game's own address — the one the app opens as a Universal
// Link and the web client serves as a page.
private final class CopyUrlActivity: UIActivity {
    private let url: URL

    init(url: URL) {
        self.url = url
        super.init()
    }

    override var activityTitle: String? { "Copy URL" }

    override var activityImage: UIImage? { UIImage(systemName: "link") }

    override var activityType: UIActivity.ActivityType? {
        UIActivity.ActivityType("com.maciejkedra.igo5.copy-url")
    }

    override class var activityCategory: UIActivity.Category { .action }

    override func canPerform(withActivityItems activityItems: [Any]) -> Bool { true }

    override func prepare(withActivityItems activityItems: [Any]) {}

    override func perform() {
        UIPasteboard.general.url = url
        activityDidFinish(true)
    }
}

// Copies the SGF itself as text, for pasting straight into an editor or a
// review tool rather than saving a file.
private final class CopySgfActivity: UIActivity {
    private let text: String

    init(text: String) {
        self.text = text
        super.init()
    }

    override var activityTitle: String? { "Copy SGF" }

    override var activityImage: UIImage? { UIImage(systemName: "doc.on.doc") }

    override var activityType: UIActivity.ActivityType? {
        UIActivity.ActivityType("com.maciejkedra.igo5.copy-sgf")
    }

    override class var activityCategory: UIActivity.Category { .action }

    override func canPerform(withActivityItems activityItems: [Any]) -> Bool { true }

    override func prepare(withActivityItems activityItems: [Any]) {}

    override func perform() {
        UIPasteboard.general.string = text
        activityDidFinish(true)
    }
}
