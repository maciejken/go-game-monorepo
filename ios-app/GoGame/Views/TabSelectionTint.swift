import SwiftUI
import UIKit

// Paints the tab bar's selection pill yellow, so the tab you are on reads
// like the primary button.
//
// None of the supported routes reach it. `.tint()` colours the glyph and
// leaves the capsule grey. `UITabBarAppearance.selectionIndicatorTintColor`
// and `.selectionIndicatorImage` are both ignored on iOS 26, because the
// pill is no longer a plain view: it is drawn by the Liquid Glass renderer
// (`_UILiquidLensView` wrapping SDF shader views). What that renderer sits
// on top of is an ordinary `_UITabSelectionView`, and colouring that shows
// through the glass.
//
// So this walks the window for that view by class name and sets a public
// property on it. No private API is called. If Apple renames or restructures
// it, the walk finds nothing and the pill goes back to system grey, which is
// the right way for this to fail.
//
// The lens is rebuilt as the selection moves, so the paint is reapplied on
// selection change and once more after the animation would have finished.
enum TabSelectionTint {
    /// Repaints the pill. Call on appear and whenever the selected tab
    /// changes; the lens is rebuilt as the selection moves, so the paint
    /// is applied again once the animation would have settled.
    ///
    /// Deliberately not a view in the hierarchy. An earlier version was a
    /// UIViewRepresentable in the TabView's background, which puts a view
    /// of ours inside the tab bar's own tree — and on iOS 26 the search
    /// field lives in that tree too. Finding the window from the scene
    /// keeps this out of anyone's layout.
    static func repaint() {
        for delay in [0.0, 0.05, 0.4] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                guard let window = keyWindow() else { return }
                paint(window)
            }
        }
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }

    private static func paint(_ view: UIView) {
        if String(describing: type(of: view)) == "_UITabSelectionView" {
            view.backgroundColor = UIColor(Igo5.yellow)
            view.layer.cornerRadius = view.bounds.height / 2
            view.layer.cornerCurve = .continuous
            view.clipsToBounds = true
        }
        view.subviews.forEach(paint)
    }

    /// The glyph on top of the yellow, which the appearance proxy *does*
    /// reach. Call once before the tab bar is first shown.
    static func configureAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithDefaultBackground()
        for layout in [
            appearance.stackedLayoutAppearance,
            appearance.inlineLayoutAppearance,
            appearance.compactInlineLayoutAppearance,
        ] {
            layout.selected.iconColor = UIColor(Igo5.ink)
            layout.selected.titleTextAttributes = [.foregroundColor: UIColor(Igo5.ink)]
            // `layout.normal.iconColor` and `UITabBar.unselectedItemTintColor`
            // are both set here in spirit and both ignored in fact — the
            // unselected glyph stays the system's own colour. Measured, not
            // assumed; see the skill. Painting its image view by hand in the
            // walk below does not work either, and it degrades the pill.
        }
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }
}
