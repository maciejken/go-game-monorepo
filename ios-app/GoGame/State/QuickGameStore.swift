import Foundation

// Holds the shake-to-play preset for whoever needs it: MainTabView (which
// acts on a shake), the preset editor and the new-game form (which write
// it). Separate from SessionStore because it outlives none of it — it's
// just one row of settings — and keeping it here means an edit made in one
// screen is visible to the gesture immediately, without a refetch.
@Observable
final class QuickGameStore {
    var preset: QuickGamePreset?
    // Set by GameBoardView while a board is on screen. A shake there is
    // far more likely to be someone reacting to the game in front of them
    // than a request for a different one, so the gesture stays out of it.
    var isBoardOpen = false

    var isShakeEnabled: Bool { preset?.shakeToPlay == true }

    func load() async {
        preset = try? await APIClient.getQuickGamePreset()
    }
}
