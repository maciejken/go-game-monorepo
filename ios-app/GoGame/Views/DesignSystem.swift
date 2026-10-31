import SwiftUI
import UIKit

// The app's buttons, in one place. Before this, a prominent button was
// whatever the OS made of it: the system blue below iOS 26, a white or
// black glass capsule above it, and a hand-rolled black fill in the
// fallback path. Three looks for one meaning.
//
// Igo5's yellow is the app icon's yellow, and it is a background colour,
// never a foreground one. Black on it reads at about 13:1; the same yellow
// as text on white is about 1.4:1, which is why the secondary button
// borrows the theme's own ink in light mode and only turns yellow against
// a dark ground.
enum Igo5 {
    /// #FFD43B — the icon's yellow. A fill, with ink on top of it.
    static let yellow = Color(red: 1.0, green: 212.0 / 255.0, blue: 59.0 / 255.0)

    /// #111111 — the icon's black. Stays black in both themes, because it
    /// only ever sits on the yellow.
    static let ink = Color(red: 17.0 / 255.0, green: 17.0 / 255.0, blue: 17.0 / 255.0)

    /// Border and label for secondary and ghost buttons, and the unselected
    /// tab icon: ink on a light ground, yellow on a dark one, so the same
    /// thing reads on either.
    ///
    /// Kept as a UIColor too, because the UIKit appearance proxies need the
    /// dynamic colour itself rather than whatever it resolved to at launch.
    static let outlineUIColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1.0, green: 212.0 / 255.0, blue: 59.0 / 255.0, alpha: 1)
            : UIColor(red: 17.0 / 255.0, green: 17.0 / 255.0, blue: 17.0 / 255.0, alpha: 1)
    }
    static let outline = Color(uiColor: outlineUIColor)

    /// The system red, which already adapts to the theme. Reached through
    /// a button's `role: .destructive` rather than set by hand.
    static let destructive = Color.red

    /// Circular icon buttons, which keep their circle rather than the
    /// radius below. The system's glass styles pad their label by about
    /// 7pt a side; these styles do not, so the frame a call site gives is
    /// the diameter it gets. Both values are what the glass versions used
    /// to render at, measured off a screenshot rather than guessed.
    ///
    /// Hero is the turn marker, the result, the + that starts a game and
    /// the tick that ends scoring. Compact is the review arrows, at about
    /// 80% of it.
    static let heroCircleDiameter: CGFloat = 58
    static let compactCircleDiameter: CGFloat = 46

    /// One radius for every button, so two sitting side by side are the
    /// same shape. Circular icon buttons are their own thing and keep
    /// their circle.
    static let cornerRadius: CGFloat = 12
    static let borderWidth: CGFloat = 1.5

    /// The same box for all three variants: a ghost takes up the room a
    /// secondary would, so a column of mixed buttons lines up and nothing
    /// shifts when one changes variant.
    static let buttonPaddingVertical: CGFloat = 12
    static let buttonPaddingHorizontal: CGFloat = 16

    /// Dim rather than grey out: a disabled button keeps its shape and
    /// colour so it stays findable, which an earlier all-grey version did
    /// not — in light mode it vanished.
    static let disabledOpacity: Double = 0.4
    static let pressedOpacity: Double = 0.75
}

// Shared so the three variants cannot drift apart in anything but their
// fill and their border.
private struct Igo5ButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let foreground: Color

    var body: some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(foreground)
            .padding(.vertical, Igo5.buttonPaddingVertical)
            .padding(.horizontal, Igo5.buttonPaddingHorizontal)
    }
}

// Applied after the background, so a disabled button dims its fill and its
// border too. Inside the body it would only have reached the label.
private func igo5Dimming(_ configuration: ButtonStyleConfiguration, isEnabled: Bool) -> Double {
    guard isEnabled else { return Igo5.disabledOpacity }
    return configuration.isPressed ? Igo5.pressedOpacity : 1
}

// The affirmative action on a screen: Log in, Add, Pass, Accept, Done.
// One per screen, as a rule.
struct Igo5PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Igo5ButtonBody(configuration: configuration, foreground: Igo5.ink)
            .modifier(Igo5YellowBackground())
            .opacity(igo5Dimming(configuration, isEnabled: isEnabled))
    }
}

// The alternative that still deserves an edge: Copy, Share, Register,
// Reopen scoring. Outlined, so it never competes with the yellow.
struct Igo5SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Igo5ButtonBody(configuration: configuration, foreground: Igo5.outline)
            .background(
                RoundedRectangle(cornerRadius: Igo5.cornerRadius)
                    .stroke(Igo5.outline, lineWidth: Igo5.borderWidth)
            )
            .opacity(igo5Dimming(configuration, isEnabled: isEnabled))
    }
}

// Glass: no colour of its own, just the surface behind it blurred and
// lifted slightly. For the action you should be able to find but not be
// invited towards: Reject, Resign, Delete, Block. Give the Button
// `role: .destructive` and the label turns red on its own — the role is
// already how SwiftUI is told what the button does, so the colour follows
// the meaning instead of being set by hand at each call site.
//
// The hierarchy is still readable with a background present: the primary
// is the only filled one, the secondary is the only bordered one, and this
// one borrows whatever is underneath.
struct Igo5GhostButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Igo5ButtonBody(
            configuration: configuration,
            foreground: configuration.role == .destructive ? Igo5.destructive : Igo5.outline
        )
        .modifier(Igo5GlassBackground())
        .opacity(igo5Dimming(configuration, isEnabled: isEnabled))
    }
}

// Real Liquid Glass where there is any, and the nearest older equivalent
// below it: a thin material is the same idea — the backdrop blurred rather
// than a colour laid over it — without the lighting.
private struct Igo5YellowBackground: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.tint(Igo5.yellow), in: RoundedRectangle(cornerRadius: Igo5.cornerRadius))
        } else {
            content.background(RoundedRectangle(cornerRadius: Igo5.cornerRadius).fill(Igo5.yellow))
        }
    }
}

private struct Igo5GlassBackground: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: Igo5.cornerRadius))
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Igo5.cornerRadius))
        }
    }
}

extension Igo5 {
    /// The scoring screen's Dead/Seki picker. A segmented control has no
    /// SwiftUI style API, so its selected pill is only reachable through
    /// the UIKit appearance proxy — which, unlike the tab bar's, is
    /// honoured. Global, so it is set once at launch rather than per
    /// screen; this app has exactly one segmented control.
    ///
    /// Only the colour: the font is left to the system so the labels keep
    /// following Dynamic Type.
    static func configureSegmentedAppearance() {
        UISegmentedControl.appearance().selectedSegmentTintColor = UIColor(Igo5.yellow)
        UISegmentedControl.appearance().setTitleTextAttributes(
            [.foregroundColor: UIColor(Igo5.ink)],
            for: .selected
        )
    }
}

// Every switch in the app, from one line at the root.
//
// There is no other safe way to do it globally. `UISwitch.appearance()
// .onTintColor` is ignored — SwiftUI's Toggle on iOS 26 is not that switch
// any more. The only app-wide colour hook SwiftUI offers is `.tint()`, and
// that reaches everything: a tint of this yellow turns "Forgot password?"
// and "Log out" into yellow text on white, at about 1.4:1. A toggle style
// propagates through the environment exactly like tint does, but lands on
// toggles alone.
struct Igo5ToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        // Wrapping the system switch rather than drawing one.
        // `.toggleStyle(.switch)` inside is what stops the rebuilt Toggle
        // from finding this style again and recursing.
        Toggle(configuration)
            .toggleStyle(.switch)
            .tint(Igo5.yellow)
    }
}

extension ToggleStyle where Self == Igo5ToggleStyle {
    static var igo5Switch: Igo5ToggleStyle { Igo5ToggleStyle() }
}

// The round icon buttons: the + that starts a game, the review arrows, the
// finalize tick. Same two meanings as the rectangular ones and the same
// colours, in a circle — a circle is the shape of a single glyph with no
// word beside it, and is not the rounded rectangle with the wrong radius.
//
// The call site sizes the glyph and its frame; this only colours the
// circle behind it.
struct Igo5CircleButtonStyle: ButtonStyle {
    enum Variant {
        case primary
        case ghost
    }

    let variant: Variant
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(variant == .primary ? Igo5.ink : Igo5.outline)
            .modifier(Igo5CircleBackground(variant: variant))
            .opacity(igo5Dimming(configuration, isEnabled: isEnabled))
    }
}

private struct Igo5CircleBackground: ViewModifier {
    let variant: Igo5CircleButtonStyle.Variant

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            switch variant {
            case .primary:
                content.glassEffect(.regular.tint(Igo5.yellow), in: Circle())
            case .ghost:
                content.glassEffect(.regular, in: Circle())
            }
        } else {
            switch variant {
            case .primary:
                content.background(Igo5.yellow, in: Circle())
            case .ghost:
                content.background(.ultraThinMaterial, in: Circle())
            }
        }
    }
}

extension ButtonStyle where Self == Igo5CircleButtonStyle {
    static var igo5PrimaryCircle: Igo5CircleButtonStyle { Igo5CircleButtonStyle(variant: .primary) }
    static var igo5GhostCircle: Igo5CircleButtonStyle { Igo5CircleButtonStyle(variant: .ghost) }
}

extension ButtonStyle where Self == Igo5PrimaryButtonStyle {
    static var igo5Primary: Igo5PrimaryButtonStyle { Igo5PrimaryButtonStyle() }
}

extension ButtonStyle where Self == Igo5SecondaryButtonStyle {
    static var igo5Secondary: Igo5SecondaryButtonStyle { Igo5SecondaryButtonStyle() }
}

extension ButtonStyle where Self == Igo5GhostButtonStyle {
    static var igo5Ghost: Igo5GhostButtonStyle { Igo5GhostButtonStyle() }
}

// A sheet as tall as whatever is inside it.
//
// A fixed `.height()` detent is a guess, and it was wrong the moment the
// buttons above grew: the delete sheet started truncating its own question
// with an ellipsis. It would have gone wrong anyway the first time a
// translation ran longer than the English.
//
// Only for content that sizes itself. A `Spacer` inside will expand to the
// proposal and the measurement becomes whatever the sheet already was.
private struct FittedSheetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct FittedSheetHeight: ViewModifier {
    @State private var height: CGFloat = 200

    func body(content: Content) -> some View {
        content
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: FittedSheetHeightKey.self, value: proxy.size.height)
                }
            }
            .onPreferenceChange(FittedSheetHeightKey.self) { measured in
                if measured > 0 {
                    height = measured
                }
            }
            .presentationDetents([.height(height)])
    }
}

extension View {
    func fittedSheetHeight() -> some View {
        modifier(FittedSheetHeight())
    }
}
