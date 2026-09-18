import SwiftUI
import UIKit

// Thin wrapper around UIActivityViewController — SwiftUI's own ShareLink
// can't be triggered lazily after an async fetch (its item has to be known
// up front), which is what Export SGF needs (fetch the text, write it to a
// temp file, then present the sheet).
struct ShareSheet: UIViewControllerRepresentable {
    let activityItems: [Any]
    // Shown as an extra row in the sheet's action list. nil leaves the
    // sheet with only the system's own activities.
    var copyLinkURL: URL?

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(
            activityItems: activityItems,
            applicationActivities: copyLinkURL.map { [CopyLinkActivity(url: $0)] },
        )
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// Copies the game's own address rather than whatever is being shared, so
// the sheet can offer the SGF file and the link side by side without the
// system's "Copy" lumping the two together.
private final class CopyLinkActivity: UIActivity {
    private let url: URL

    init(url: URL) {
        self.url = url
        super.init()
    }

    override var activityTitle: String? { "Copy Game Link" }

    override var activityImage: UIImage? { UIImage(systemName: "link") }

    override var activityType: UIActivity.ActivityType? {
        UIActivity.ActivityType("com.maciejkedra.igo5.copy-game-link")
    }

    override class var activityCategory: UIActivity.Category { .action }

    override func canPerform(withActivityItems activityItems: [Any]) -> Bool { true }

    override func prepare(withActivityItems activityItems: [Any]) {}

    override func perform() {
        UIPasteboard.general.url = url
        activityDidFinish(true)
    }
}
