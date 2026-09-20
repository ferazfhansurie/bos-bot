import SwiftUI
import UIKit

/// Readable columns for the phone-first surfaces when they run in a wider
/// iPad window. Compact windows naturally remain narrower than these caps.
enum CompanionLayout {
    /// Ask iPadOS for a large landscape window on first launch. The system
    /// clamps this to the current display and still lets the person resize or
    /// tile the app. Previously SwiftUI inferred its initial window from the
    /// 680-point roster column, which produced a tall, phone-like window.
    static let defaultWindowSize = CGSize(width: 1_366, height: 1_024)

    static let rosterWidth: CGFloat = 680
    static let chatWidth: CGFloat = 760
    static let headerWidth: CGFloat = 900

    /// The expanding island animation is anchored to iPhone hardware. On an
    /// iPad it reads as an unexplained floating black card.
    static var supportsIslandPresentation: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }
}
