import SwiftUI
import UIKit

// A shake gesture reaches SwiftUI only through UIKit's motion events, and
// only in the foreground — a suspended app runs no code, which is why
// shaking can't launch the app, just act inside it.
//
// Implemented as a first-responder view controller rather than by
// overriding UIWindow in an extension: overriding a method in an extension
// on a UIKit class is a swizzle in all but name, and this stays scoped to
// wherever the modifier is attached.
struct ShakeDetector: UIViewControllerRepresentable {
    let onShake: () -> Void

    func makeUIViewController(context: Context) -> ShakeViewController {
        let controller = ShakeViewController()
        controller.onShake = onShake
        return controller
    }

    func updateUIViewController(_ uiViewController: ShakeViewController, context: Context) {
        uiViewController.onShake = onShake
    }
}

final class ShakeViewController: UIViewController {
    var onShake: (() -> Void)?

    override var canBecomeFirstResponder: Bool { true }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return }
        onShake?()
    }
}

extension View {
    // Zero-sized and non-interactive: it exists only to sit in the
    // responder chain, so it must not take space or swallow touches.
    func onShake(perform action: @escaping () -> Void) -> some View {
        background(ShakeDetector(onShake: action).frame(width: 0, height: 0).allowsHitTesting(false))
    }
}
