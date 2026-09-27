// Edge-swipe back, restored.
//
// Every screen with its own header sets `.navigationBarBackButtonHidden(true)`,
// and UIKit reads that as "this screen has taken over going back", switching
// off the interactive pop gesture along with the button it hid. Handing the
// recognizer a delegate of our own turns the swipe back on — but it then has
// to keep the one rule UIKit was enforcing for us.
//
// Pure: no UIKit here, so the rule is the part that is tested.
import Foundation

public enum InteractivePop {
    /// Whether an edge swipe may pop. At the root of the stack there is
    /// nothing behind the screen, and a pop that begins there leaves the
    /// navigation controller wedged rather than quietly doing nothing — so
    /// the gesture has to refuse to start, not fail halfway.
    public static func allowsPop(stackDepth: Int) -> Bool { stackDepth > 1 }
}
