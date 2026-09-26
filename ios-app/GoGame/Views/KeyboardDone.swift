import SwiftUI
import UIKit

// A Done above the keyboard, for any screen with something to type in.
//
// Applied once per screen rather than once per field: the keyboard
// toolbar belongs to whichever field is focused, so one is enough however
// many fields a screen has, and it doesn't need a binding to each of
// them. Resigning the first responder outright, rather than clearing a
// specific @FocusState, is what makes that possible.
extension View {
    func keyboardDoneButton() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder),
                        to: nil,
                        from: nil,
                        for: nil
                    )
                }
            }
        }
    }
}
