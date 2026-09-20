import AudioToolbox
import UIKit

// MARK: - Sound Effects
public enum SoundEffects {
    public static func playSent() {
        AudioServicesPlaySystemSound(1004)
    }
}

// MARK: - Haptic Feedback
public enum Haptics {
    public static func selection() {
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
    }

    public static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .medium) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
    }

    public static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(type)
    }

    public static func success() {
        notification(.success)
    }
}

// MARK: - Platform Bridge
public enum PlatformBridge {
    public static func copyToPasteboard(_ text: String) {
        UIPasteboard.general.string = text
        Haptics.selection()
    }
}
