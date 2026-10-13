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
    public static func selection() { Task { @MainActor in HapticEngine.shared.selection() } }
    public static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .medium) {
        Task { @MainActor in HapticEngine.shared.impact(style) }
    }
    public static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        Task { @MainActor in HapticEngine.shared.notification(type) }
    }
    public static func success() { notification(.success) }
}

@MainActor
private final class HapticEngine {
    static let shared = HapticEngine()
    private let selectionGenerator = UISelectionFeedbackGenerator()
    private let notificationGenerator = UINotificationFeedbackGenerator()
    private var impacts: [UIImpactFeedbackGenerator.FeedbackStyle: UIImpactFeedbackGenerator] = [:]
    private var lastSelection = Date.distantPast
    func selection() {
        guard Date().timeIntervalSince(lastSelection) > 0.08 else { return }
        lastSelection = Date()
        selectionGenerator.selectionChanged(); selectionGenerator.prepare()
    }
    func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let generator = impacts[style] ?? UIImpactFeedbackGenerator(style: style)
        impacts[style] = generator
        generator.impactOccurred(); generator.prepare()
    }
    func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        notificationGenerator.notificationOccurred(type); notificationGenerator.prepare()
    }
}

// MARK: - Platform Bridge
public enum PlatformBridge {
    public static func copyToPasteboard(_ text: String) {
        UIPasteboard.general.string = text
        Haptics.selection()
    }
}
