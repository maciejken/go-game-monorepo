import SwiftUI

// Thin wrapper around UIActivityViewController — SwiftUI's own ShareLink
// can't be triggered lazily after an async fetch (its item has to be known
// up front), which is what Export SGF needs (fetch the text, write it to a
// temp file, then present the sheet).
struct ShareSheet: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
