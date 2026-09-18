import LinkPresentation
import SwiftUI
import UIKit

// What Share game hands to the system: the SGF as a file (for Save to
// Files, AirDrop, Mail), the game's own address (for Notes, and for Copy
// URL), and the SGF as text (for Copy SGF).
struct GameShare {
    let sgfFileURL: URL
    let sgfText: String
    let gameURL: URL?
    // The note's title, via the sheet's subject.
    let title: String
    // The same, but for a quick note — where the game's start time is a
    // more useful stand-in for a missing title than the two player names.
    let quickNoteTitle: String
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
            // Two items, each with its own source so every activity gets
            // only what it can use: the .sgf file for Save to Files/
            // AirDrop/Mail, and the game's address for Notes, which
            // renders a URL item as a link in the note body. The file
            // comes first so the sheet's header previews it.
            activityItems: [SgfFileItemSource(share: share), GameLinkItemSource(share: share)],
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

// Notes appears twice in the sheet: its app row, served by the sharing
// extension, and New Quick Note among the actions. Matched on substrings
// rather than hardcoded constants — Apple ships more than one of these and
// has renamed them across releases — and only the sharing extension is
// named as such, so anything else note-ish is the quick one.
private func isNotes(_ activityType: UIActivity.ActivityType?) -> Bool {
    activityType?.rawValue.localizedCaseInsensitiveContains("note") ?? false
}

private func isQuickNote(_ activityType: UIActivity.ActivityType?) -> Bool {
    guard isNotes(activityType), let rawValue = activityType?.rawValue else { return false }
    return !rawValue.localizedCaseInsensitiveContains("sharing")
}

// The .sgf itself, for anything that takes a file. A quick note is the
// exception: it is meant to stay a jotting, and it can't read a file out
// of this app's sandbox anyway.
private final class SgfFileItemSource: NSObject, UIActivityItemSource {
    private let share: GameShare

    init(share: GameShare) {
        self.share = share
        super.init()
    }

    // Also decides the sheet's header preview, before any activity is
    // picked — the file, so it shows as an SGF document.
    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        share.sgfFileURL
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        itemForActivityType activityType: UIActivity.ActivityType?
    ) -> Any? {
        isQuickNote(activityType) ? nil : share.sgfFileURL
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        subjectForActivityType activityType: UIActivity.ActivityType?
    ) -> String {
        isQuickNote(activityType) ? share.quickNoteTitle : share.title
    }
}

// The game's address, offered to Notes only: it lands in the note as a
// link, which is what both a full note and a quick note can actually show.
// Everything else gets nil and keeps the file alone, so Save to Files
// still writes one .sgf rather than a .webloc beside it.
private final class GameLinkItemSource: NSObject, UIActivityItemSource {
    private let share: GameShare

    init(share: GameShare) {
        self.share = share
        super.init()
    }

    // Deliberately the .sgf file, not the link: the sheet decides which
    // activities to offer from placeholders alone, and a web URL among
    // them makes the whole share a link share — Save to Files disappears
    // and Add to Reading List takes its place. Advertising a file keeps
    // the offer list as it was; the real link is handed over below, to
    // Notes only.
    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        share.sgfFileURL
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        itemForActivityType activityType: UIActivity.ActivityType?
    ) -> Any? {
        isNotes(activityType) ? share.gameURL : nil
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        subjectForActivityType activityType: UIActivity.ActivityType?
    ) -> String {
        isQuickNote(activityType) ? share.quickNoteTitle : share.title
    }

    // How a link carries a title: a quick note takes nothing but the URL
    // item — not the subject, not a separate text item — so the name has
    // to travel as the link's own metadata, the same way Safari's quick
    // notes get a page title.
    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
        let metadata = LPLinkMetadata()
        metadata.title = share.quickNoteTitle
        metadata.originalURL = share.gameURL
        metadata.url = share.gameURL
        return metadata
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
