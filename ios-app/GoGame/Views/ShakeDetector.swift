import SwiftUI
import UIKit

extension Notification.Name {
    static let deviceDidShake = Notification.Name("deviceDidShake")
}

// A shake gesture reaches SwiftUI only through UIKit's motion events, and
// only in the foreground — a suspended app runs no code, which is why
// shaking can't launch the app, just act inside it.
//
// Implemented as a first-responder view controller rather than by
// overriding UIWindow in an extension: overriding a method in an extension
// on a UIKit class is a swizzle in all but name.
//
// It posts a notification rather than calling a closure, so that exactly
// one of these needs to exist. Two would fight over first-responder
// status — whichever appeared last would take it, and the other would stay
// silent even after the winner left the screen.
private struct ShakeSource: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ShakeViewController {
        ShakeViewController()
    }

    func updateUIViewController(_ uiViewController: ShakeViewController, context: Context) {}
}

final class ShakeViewController: UIViewController {
    override var canBecomeFirstResponder: Bool { true }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
        // Motion events only reach the first responder, and any text field
        // the user taps becomes it — the coordinate entry, a title, a
        // search box. Taking it back once each keyboard goes away is what
        // keeps a shake working for the rest of the session; without it,
        // editing anything once kills the gesture until this view is
        // rebuilt. Also on returning to the foreground, since the system
        // can hand first-responder status elsewhere while away.
        let reclaim: (Notification) -> Void = { [weak self] _ in
            guard let self, isViewLoaded, view.window != nil else { return }
            becomeFirstResponder()
        }
        NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main, using: reclaim
        )
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: reclaim
        )
    }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return }
        NotificationCenter.default.post(name: .deviceDidShake, object: nil)
    }
}

extension View {
    // Installs the detector. Attached once, near the root — everything
    // else listens with onShake below. Zero-sized and non-interactive: it
    // exists only to sit in the responder chain, so it must not take space
    // or swallow touches.
    func shakeSource() -> some View {
        background(ShakeSource().frame(width: 0, height: 0).allowsHitTesting(false))
    }

    // Reacts to a shake from anywhere in the app; each listener decides for
    // itself whether this one is its to handle.
    func onShake(perform action: @escaping () -> Void) -> some View {
        onReceive(NotificationCenter.default.publisher(for: .deviceDidShake)) { _ in action() }
    }
}
