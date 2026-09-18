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
    // The same, but for a quick note — where the game's start time is a
    // more useful stand-in for a missing title than the two player names.
    let quickNoteTitle: String

    // What the Notes app receives in place of the file: a title line, the
    // link under it, then the record itself.
    var noteText: String {
        [title, gameURL?.absoluteString, "", sgfText]
            .compactMap { $0 }
            .joined(separator: "\n")
    }

    // A quick note is meant to be a jotting, so it gets the title and the
    // link only — the SGF would bury both.
    var quickNoteText: String {
        [quickNoteTitle, gameURL?.absoluteString]
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
            // Two items, because a share extension binds to the type its
            // placeholder advertises: the file one carries the .sgf for
            // Save to Files/AirDrop/Mail, and the text one exists so Notes
            // has something it can actually put in a note. The file comes
            // first so the sheet's header still previews an SGF document.
            activityItems: [SgfFileItemSource(share: share), NoteTextItemSource(share: share)],
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

// The .sgf itself, for anything that takes a file.
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
        share.sgfFileURL
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        subjectForActivityType activityType: UIActivity.ActivityType?
    ) -> String {
        share.title
    }
}

// The same game as plain text, offered only to Notes — everything else
// gets nil and is left with the file above, so Save to Files still writes
// one .sgf rather than picking up a stray .txt beside it.
private final class NoteTextItemSource: NSObject, UIActivityItemSource {
    private let share: GameShare

    init(share: GameShare) {
        self.share = share
        super.init()
    }

    // An empty string rather than the note itself: the placeholder is what
    // tells the system this item is text (so Notes activates for it), and
    // it is never the value anything receives.
    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        ""
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        itemForActivityType activityType: UIActivity.ActivityType?
    ) -> Any? {
        if isQuickNote(activityType) {
            return share.quickNoteText
        }
        return isNotes(activityType) ? share.noteText : nil
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        subjectForActivityType activityType: UIActivity.ActivityType?
    ) -> String {
        isQuickNote(activityType) ? share.quickNoteTitle : share.title
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
