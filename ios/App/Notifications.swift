import Foundation
import UserNotifications
import UIKit

extension Notification.Name { static let sharedRoomPushTapped = Notification.Name("bos.sharedRoomPushTapped") }
import CompanionCore

/// The on-device notification surface. Delivery comes from live or replayed
/// companion frames; a future APNs relay can feed the same categories and
/// userInfo without changing the rest of the app.
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    private let center = UNUserNotificationCenter.current()
    /// Set by `Session`; kept as an id-only value so the notification layer
    /// does not know about SwiftUI navigation or mutable fleet state.
    var responseHandler: ((NotificationTarget) -> Void)?
    var pushTokenHandler: ((String) -> Void)?
    var sharedRoomHandler: ((String) -> Void)?

    private override init() {
        super.init()
        center.delegate = self
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func requestAuthorization() async -> Bool {
        let allowed = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
        if allowed { await MainActor.run { UIApplication.shared.registerForRemoteNotifications() } }
        return allowed
    }

    func deliver(_ notification: NotificationFrame, sequence: Int?) {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        content.categoryIdentifier = notification.isBlocking ? "OPENMAUS_APPROVAL" : "OPENMAUS_UPDATE"
        content.threadIdentifier = notification.threadId
        content.userInfo = [
            "threadId": notification.threadId,
            "botId": notification.botId,
            "kind": notification.kind,
        ]
        if notification.isBlocking { content.interruptionLevel = .timeSensitive }

        // A replay after a short disconnect must reconcile a missed alert,
        // but a repeated frame must not draw it twice.
        let identifier = "openmaus.\(notification.threadId).\(sequence.map(String.init) ?? notification.title)"
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    func setBadge(_ count: Int) {
        center.setBadgeCount(max(0, count))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let strings = response.notification.request.content.userInfo.reduce(into: [String: String]()) { result, pair in
            guard let key = pair.key as? String, let value = pair.value as? String else { return }
            result[key] = value
        }
        if let roomID = strings["roomId"] { sharedRoomHandler?(roomID) }
        else if let target = NotificationTarget(payload: strings) { responseHandler?(target) }
        completionHandler()
    }
}
