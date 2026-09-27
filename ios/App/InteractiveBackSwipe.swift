// Puts UIKit's edge-swipe back on a NavigationStack whose screens draw their
// own header. `.navigationBarBackButtonHidden(true)` hides the system button
// and, with it, the interactive pop gesture — so the chat could only be left
// through the chevron. Installing our own delegate on the recogniser restores
// the swipe; `InteractivePop` holds the rule about when it may begin.
import SwiftUI
import UIKit
import CompanionCore

extension View {
    /// Apply inside a `NavigationStack`: the swipe then works for every screen
    /// pushed onto it, since the delegate asks the stack its depth each time.
    func interactiveBackSwipe() -> some View {
        background(InteractiveBackSwipeInstaller().frame(width: 0, height: 0).accessibilityHidden(true))
    }
}

/// Retained by SwiftUI as the representable's coordinator, which matters:
/// `UIGestureRecognizer.delegate` is weak, so a delegate nobody holds is
/// released and the gesture silently goes back to being dead.
private final class InteractiveBackSwipeDelegate: NSObject, UIGestureRecognizerDelegate {
    weak var navigation: UINavigationController?

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let navigation else { return false }
        return InteractivePop.allowsPop(stackDepth: navigation.viewControllers.count)
    }

    /// The chat is a vertical scroll view with horizontal rows inside it; let
    /// the edge pan run alone so a swipe is either a back or a scroll, never
    /// half of each.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { false }
}

private struct InteractiveBackSwipeInstaller: UIViewControllerRepresentable {
    func makeCoordinator() -> InteractiveBackSwipeDelegate { InteractiveBackSwipeDelegate() }

    func makeUIViewController(context: Context) -> UIViewController {
        Installer(delegate: context.coordinator)
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {
        (controller as? Installer)?.install()
    }

    /// An empty controller whose only job is to be somewhere in the hierarchy
    /// the navigation controller can be reached from.
    final class Installer: UIViewController {
        private let popDelegate: InteractiveBackSwipeDelegate

        init(delegate: InteractiveBackSwipeDelegate) {
            self.popDelegate = delegate
            super.init(nibName: nil, bundle: nil)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            install()
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            install()
        }

        /// Called from several places on purpose: the navigation controller is
        /// not reachable yet when SwiftUI first makes this, and UIKit hands the
        /// recogniser its own delegate back whenever the stack is rebuilt.
        func install() {
            guard let navigation = navigationController,
                  let gesture = navigation.interactivePopGestureRecognizer else { return }
            popDelegate.navigation = navigation
            guard gesture.delegate !== popDelegate else { return }
            gesture.delegate = popDelegate
            gesture.isEnabled = true
        }
    }
}
