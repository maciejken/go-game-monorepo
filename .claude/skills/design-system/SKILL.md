---
name: design-system
description: Igo5's colours, buttons and component rules across the iOS app and the web client. Use when adding or restyling any UI control, picking a colour, or deciding how a new component should look.
---

# Igo5 design system

The identity comes from the app icon: a blocky black 5 on yellow. Everything
below follows from that, and from one fact about the yellow.

## The one rule about the yellow

`#FFD43B` is a **background** colour. Black on it reads at about 13:1. The same
yellow as text or a thin line on white reads at about **1.4:1**, which fails
every contrast threshold there is.

So: yellow fills, with black on top. Yellow is only allowed to be a foreground
colour against a dark ground, where it reaches about 13:1. This is why the
secondary button changes colour between themes while the primary one does not.

## Tokens

| Token | Light | Dark | Notes |
|---|---|---|---|
| `yellow` | `#FFD43B` | `#FFD43B` | The icon's yellow. Fill only. |
| `ink` | `#111111` | `#111111` | The icon's black. Only ever sits on the yellow, so it does not flip. |
| `outline` | `#111111` | `#FFD43B` | Border and label of a secondary button. |
| `destructive` | system red | system red | Reached through `role: .destructive`, never set by hand. |
| `cornerRadius` | 12 | | One radius for every button, so two side by side are the same shape. |
| `borderWidth` | 1.5 | | |
| button padding | 12 vertical, 16 horizontal | | The same box for all three variants. |
| `disabledOpacity` | 0.4 | | Dim the whole button; never grey it out. Apply it *after* the background, or it only reaches the label. |
| `pressedOpacity` | 0.75 | | |

Dimming rather than greying is deliberate: an earlier grey disabled state became
invisible against the light background, and the bug took a while to spot.

## Buttons

Three variants. Every one of them shares the same padding and the same corner
radius, so a column of mixed buttons lines up and nothing shifts when one
changes variant. Only circular icon buttons are exempt, because a circle is not
a rounded rectangle that got the radius wrong.

**Primary** — the affirmative action: Log in, Add, Pass, Accept, Done, Send.
Yellow with an ink label, in both themes: tinted glass on iOS 26
(`.glassEffect(.regular.tint(Igo5.yellow), in:)`) so it catches the light like
the ghost does, and a flat fill below that. The tint holds the colour in both
themes — checked, because tinted glass is translucent and could have washed
out against a dark sheet. One per screen as a rule. Where it is
the main action of a form or a sheet, give the label `.frame(maxWidth:
.infinity)` so it spans; a primary button that wraps only its own word reads as
a chip dropped into the row.

**Secondary** — the alternative that still deserves an edge: Copy, Share,
Register, Reopen scoring, Try again. Transparent background, so the page's own
colour shows through, with a 1.5pt border and a label in `outline`.

**Ghost** — glass: no colour of its own, just the surface behind it blurred and
lifted. For what you should be able to find but not be invited towards: Skip,
Cancel, and every destructive action. Real Liquid Glass on iOS 26, a thin
material below it, both in the same rounded rectangle as the other two. Give the
Button `role: .destructive` and the label turns red by itself:

```swift
Button(role: .destructive) { … } label: { Text("Resign") }
    .buttonStyle(.igo5Ghost)
```

The role is already how SwiftUI is told what a button does, so the colour
follows the meaning rather than being set at each call site, and a ghost that
is *not* destructive keeps the `outline` colour.

Destructive actions used to be a red filled button (Delete account) or a red
system capsule (Resign, Reject, Delete game). A red fill shouts as loudly as the
primary and competes with it; red on glass is findable without inviting.

The hierarchy survives the background: the primary is the only filled one, the
secondary is the only bordered one, and the ghost borrows whatever is beneath
it.

Plain text buttons inside a `List` row (Forgot password?, Play without an
account, Block on a profile) stay as list rows. They are rows, not buttons, and
styling them would flatten the hierarchy.

### iOS

Defined in `ios-app/GoGame/Views/DesignSystem.swift`:

```swift
Button { … } label: { Text("Pass").frame(maxWidth: .infinity) }
    .buttonStyle(.igo5Primary)

Button("Copy") { … }
    .buttonStyle(.igo5Secondary)

Button(role: .destructive) { … } label: { Text("Resign") }
    .buttonStyle(.igo5Ghost)
```

Do not use `.borderedProminent`, `.glassProminent` or `.bordered` for these
roles any more. They were the reason the app had a blue button on one screen, a
white one on another and a hand-rolled black one on a third. Collapsing them
removed five `if #available(iOS 26.0, *)` pairs and a bespoke `ActionButtonStyle`,
since these styles look the same on every version.

### Circular icon buttons

A glyph with no word beside it gets a circle, not the rounded rectangle with the
wrong radius. Same two meanings and the same colours as the rest.

**Sizes are the call site's job, and they are not the same numbers the system
used.** `.glass` and `.glassProminent` pad their label by roughly 7pt a side;
these styles draw the circle at the frame they are given. Measured off a
screenshot: a 52pt label rendered 66pt, a 44pt label rendered 58pt. So use the
tokens, which are what the glass versions actually rendered at:

- `Igo5.heroCircleDiameter` (58) — the turn marker, the result button, the +
  that starts a game, the tick that ends scoring.
- `Igo5.compactCircleDiameter` (46) — the review arrows, about 80% of hero.

Anything converted from a glass style and left at its old frame will come out
roughly 14pt smaller than it was, which is exactly how the + and the finalize
tick shrank the first time.


```swift
Button(action: finalize) { icon }.buttonStyle(.igo5PrimaryCircle)
Button(action: step) { icon }.buttonStyle(.igo5GhostCircle)
```

- **Finalize** (the tick that ends scoring) is primary. It is the affirmative
  action of that phase, the same as Pass is during play.
- **Review arrows** are ghost. They are navigation, they repeat, and they should
  recede.
- **The + that starts a game** is ghost, by request. Note that by this system's
  own rule — one primary per screen, the affirmative action — it has the better
  claim to primary than anything else on the game list.

The turn marker and the result button keep their own treatment: both are
indicators that happen to be tappable, not actions, and the turn marker's fill
carries the colour whose turn it is.

`Color.accentColor` is still the system blue — there is no `AccentColor` asset in
the catalogue, and there should not be one. Setting it to the yellow would tint
every link, toggle and selected glyph in the app yellow, which is the failing
1.4:1 case above.

### Web

**Not yet applied.** The web client still uses default buttons plus a `.danger`
class. When it is done, mirror the tokens above as CSS custom properties beside
the existing `--series-*` tokens in `client/src/index.css`, and add `.btn-primary`
and `.btn-secondary` so both clients stay one system. The `--series-*` palette
used by the charts is separate and validated for its own purpose; do not reuse
the yellow as a chart series colour.

## The tab bar's selection pill

It is yellow, with an ink glyph, so the tab you are on reads like the primary
button. Getting there took a detour worth recording, because every documented
route fails on iOS 26:

- `.tint(Igo5.yellow)` colours the **glyph** and leaves the capsule grey. In
  light mode that is a yellow glyph on a near-white pill: the unreadable case.
- `UITabBarAppearance.selectionIndicatorTintColor` is ignored.
- `UITabBarAppearance.selectionIndicatorImage` is ignored.

The reason is that the pill is no longer a view with a background colour. It is
drawn by the Liquid Glass renderer: `_UILiquidLensView` wrapping SDF shader
views. Underneath that sits an ordinary `_UITabSelectionView`, and colouring
*that* shows through the glass, which is what `TabSelectionTint.swift` does —
it walks the window for that class and sets `backgroundColor`, a public
property. No private API is called.

Two things to know about it. It is **fragile**: if Apple renames or
restructures that view, the walk finds nothing and the pill returns to system
grey, which is the right way for it to fail. And the lens is rebuilt as the
selection moves, so the paint is reapplied on selection change and once more
after the animation settles.

The **selected** glyph is the one part the appearance proxy does reach, via
`TabSelectionTint.configureAppearance()`, called from the app's `init` because a
proxy set after the bar exists does not apply to it.

The **unselected** glyph cannot be coloured at all, which is an odd asymmetry
but a measured one. `stackedLayoutAppearance.normal.iconColor` is ignored.
`UITabBar.appearance().unselectedItemTintColor` is ignored. Setting `tintColor`
on its image view during the same walk that paints the pill does nothing to the
glyph *and* degrades the pill from `#FFD43B` to roughly `(219, 167, 0)`. So it
stays the system's colour: black in light, white in dark. Checked on iOS 27.0.

The alternative, if this ever breaks and the colour matters more than the
system bar's behaviour, is a hand-built tab bar: full control, at the cost of
the minimise-on-scroll behaviour, the iPadOS adaptation and the accessibility
defaults that come free with the real one.

## Sheet heights

A `.presentationDetents([.height(230)])` is a guess, and the buttons above
already proved it wrong once: when they grew, the delete sheet truncated its own
question with an ellipsis. It would have broken anyway the first time a
translation ran longer than the English, and Polish and German usually do.

Use `.fittedSheetHeight()` from `DesignSystem.swift`, which measures the content
and sets the detent from it. One restriction: the content must size itself. A
`Spacer` inside expands to fill whatever was proposed, so the measurement just
reports the height the sheet already had and never changes. Two sheets still use
fixed heights for that reason (delete account, recovery code); if you remove
their `Spacer`, switch them over.

## Native controls

Most of them can take the yellow, and each was worth checking rather than
assuming — two plausible routes turned out to be dead ends:

- **Toggle** — yellow, set once for the whole app by `.toggleStyle(.igo5Switch)`
  on `RootView`. Do not add `.tint()` per toggle, and do not reach for
  `UISwitch.appearance().onTintColor`: it is ignored, because SwiftUI's Toggle
  on iOS 26 is not that switch any more. A toggle style propagates through the
  environment the way `.tint()` does but lands only on toggles, which is what
  makes it safe — an app-wide `.tint()` of this yellow would turn every text
  button into yellow-on-white at 1.4:1. The knob stays white, so the "on" state
  is carried by its position as well as the colour.
- **Segmented picker** — yellow, set by `Igo5.configureSegmentedAppearance()`
  at launch. There is no SwiftUI style API for it, so the selected pill is only
  reachable through the UIKit appearance proxy, which here *is* honoured —
  unlike the tab bar's. The proxy is global, which suits an app with one
  segmented control (Dead/Seki during scoring). Only the colour is set; the
  font is left alone so the labels keep following Dynamic Type.
- **Text field** — `.tint()` only reaches the caret and the selection. Not
  applied; the caret is not worth a brand colour.

Worth knowing alongside the tab bar above: the appearance proxy that the tab
bar ignores is the very thing that works for a segmented control.

One thing the eye will tell you wrongly: the segmented pill looks darker than
the toggle track. Both are `#FFD43B` exactly, sampled from a screenshot. The
pill carries an ink label across it and sits against the control's grey trough,
while the toggle's yellow is a sliver beside a white knob. Don't "fix" it by
introducing a second yellow.

## Checking a change

Styles are easy to get wrong in one theme only. Build a throwaway SwiftUI app in
the scratchpad that renders the controls in every state (enabled, disabled,
pressed), install it in the simulator, and screenshot it in both appearances:

```sh
xcrun simctl ui booted appearance light   # then dark
xcrun simctl io booted screenshot out.png
```

This is how the buttons above were checked, and it is faster than logging into
the real app to reach the screen a control lives on.
